/**
 * Corrigir o que já foi emitido: o nome do participante, o vínculo, a
 * organização, o CPF do certificado — ou só reemitir o papel com o contexto de
 * hoje (modelo consertado, rubrica nova).
 *
 * **O certificado emitido não se reescreve.** O papel antigo pode estar na mão
 * de alguém, e a chave impressa nele precisa continuar respondendo — agora
 * "anulado". Por isso corrigir é UM ato com três passos, na mesma transação:
 *
 * 1. grava a correção no cadastro do participante (o que vale daqui em diante);
 * 2. anula o certificado antigo, com o motivo;
 * 3. emite o substituto, com número e chave novos, e aponta o antigo para ele
 *    (`substituido_por_id`).
 *
 * Se a emissão do substituto travar (instrutor fora da vigência, modelo
 * quebrado), nada dos três fica: quem pediu a correção não pode acabar com o
 * certificado anulado e sem o novo.
 *
 * O nome de **servidor** não se corrige aqui: ele mora no cadastro de servidor
 * (`servidores.atualizar_cadastro`), que tem permissão própria. A tela aponta
 * para lá e, corrigido o nome, o reemitir daqui já sai com ele.
 */
import { and, eq, ne } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import { certificado as tabela_certificado, participante as tabela_participante } from "../db/esquema/index.js";
import { Certificado as C, ROTULO_VINCULO, VINCULOS_PARTICIPANTE } from "../dominio/treinamento.js";
import { RegraViolada } from "../nucleo/erros.js";
import * as auditoria from "./auditoria.js";
import * as cpf_certificado from "./cpf_certificado.js";
import * as servico from "./emissao_certificado.js";
import type { ParticipanteCarregado } from "./participante.js";
import type { UsuarioAtual } from "./rbac.js";
import { carregar_inscricao } from "./turma.js";

export const CERTIFICADO_RETIFICADO = "CERTIFICADO_RETIFICADO";
export const PARTICIPANTE_CORRIGIDO = "PARTICIPANTE_CORRIGIDO";

export class RetificacaoRecusada extends RegraViolada {}

/** O que a tela manda. Campo ausente (`undefined`) = não mexer. */
export interface Correcao {
  nome?: string;
  vinculo?: string;
  organizacao?: string;
  // dígitos; `null` apaga
  cpf?: string | null;
}

const ROTULO_CAMPO: Record<string, string> = {
  nome: "nome",
  vinculo: "vínculo",
  organizacao: "organização",
};

/**
 * Grava a correção no cadastro e devolve os campos que mudaram (a frase da
 * trilha e da tela). Quem chama já exigiu a permissão.
 *
 * Na trilha vão o vínculo e a organização, que são cartaz; o NOME não — RN-19
 * na escrita, como em `criar_externo`. O nome antigo continua no congelado do
 * certificado anulado, que é onde ele precisa ser lido.
 */
export async function corrigir_participante(
  tx: Executor,
  usuario: UsuarioAtual,
  participante: ParticipanteCarregado,
  c: Correcao,
): Promise<string[]> {
  const campos: Partial<typeof tabela_participante.$inferSelect> = {};
  const externo = participante.servidor_id === null;

  if (c.nome !== undefined) {
    const limpo = c.nome.trim().replace(/\s+/g, " ");
    if (!limpo) throw new RetificacaoRecusada("O nome não pode ficar em branco.");
    if (limpo.length > 160) throw new RetificacaoRecusada("O nome passa de 160 caracteres.");
    if (!externo) {
      if (limpo !== (participante.servidor?.nome ?? "")) {
        throw new RetificacaoRecusada(
          "O nome de servidor vem do cadastro de servidores: corrija-o lá e volte para reemitir.",
        );
      }
    } else if (limpo !== participante.nome) {
      campos.nome = limpo;
    }
  }
  if (c.vinculo !== undefined && externo && c.vinculo !== participante.vinculo) {
    if (c.vinculo === "SERVIDOR" || !(VINCULOS_PARTICIPANTE as readonly string[]).includes(c.vinculo)) {
      throw new RetificacaoRecusada(
        "Vínculo inválido. Quem é servidor entra pelo SIAPE, e não virando externo em servidor.",
      );
    }
    campos.vinculo = c.vinculo;
  }
  if (c.organizacao !== undefined && externo) {
    const limpa = c.organizacao.trim() || null;
    if (limpa !== null && limpa.length > 160) throw new RetificacaoRecusada("A organização passa de 160 caracteres.");
    if (limpa !== (participante.organizacao ?? null)) campos.organizacao = limpa;
  }

  const mudou = Object.keys(campos).map((k) => ROTULO_CAMPO[k]!);
  if (mudou.length) {
    await tx.update(tabela_participante).set(campos).where(eq(tabela_participante.id, participante.id));
    const vinculo_antes = participante.vinculo;
    const organizacao_antes = participante.organizacao;
    Object.assign(participante, campos);
    const detalhes: string[] = [];
    if ("nome" in campos) detalhes.push("nome corrigido");
    if ("vinculo" in campos) {
      detalhes.push(`vínculo: ${ROTULO_VINCULO[vinculo_antes] ?? vinculo_antes} → ${ROTULO_VINCULO[campos.vinculo!]}`);
    }
    if ("organizacao" in campos) {
      detalhes.push(`organização: ${organizacao_antes || "—"} → ${campos.organizacao || "—"}`);
    }
    await auditoria.registrar(tx, {
      entidade: "participante",
      entidade_id: participante.id,
      tipo_evento: PARTICIPANTE_CORRIGIDO,
      descricao: `${participante.identificador_publico} · ${detalhes.join("; ")}`,
      usuario,
    });
  }
  if (c.cpf !== undefined && (await cpf_certificado.definir_do_participante(tx, usuario, participante, c.cpf))) {
    mudou.push("CPF");
  }
  return mudou;
}

export interface ResultadoRetificacao {
  antigo: servico.CertificadoRegistro;
  novo: servico.CertificadoRegistro;
  corrigidos: string[];
  // os OUTROS certificados em vigor da mesma pessoa, que continuam com o dado antigo
  outros_em_vigor: number;
}

/** Corrige (ou só reemite) o certificado: anula o antigo e emite o substituto. */
export async function retificar(
  tx: Executor,
  usuario: UsuarioAtual,
  certificado: servico.CertificadoRegistro,
  motivo: string | null | undefined,
  correcao: Correcao = {},
): Promise<ResultadoRetificacao> {
  usuario.exigir("certificado.anular");
  usuario.exigir("certificado.emitir");
  const limpo = (motivo ?? "").trim();
  if (!limpo) {
    throw new RetificacaoRecusada(
      "Corrigir exige o motivo: é o que explica, depois, por que a mesma pessoa tem dois números para a mesma turma.",
    );
  }
  if (C.anulado(certificado)) {
    throw new RetificacaoRecusada(
      `O certificado ${C.rotulo(certificado)} já está anulado: emita o novo pela turma, na aba Emissão.`,
    );
  }
  const inscricao = await carregar_inscricao(tx, certificado.inscricao_id);
  if (!inscricao) throw new RetificacaoRecusada("A inscrição deste certificado não foi encontrada.");

  const corrigidos = await corrigir_participante(tx, usuario, inscricao.participante, correcao);
  await servico.anular(tx, usuario, certificado, `Retificação: ${limpo}`);
  // de novo do banco: a emissão lê o participante já corrigido
  const atual = (await carregar_inscricao(tx, certificado.inscricao_id))!;
  const { certificado: novo } = await servico.emitir(tx, usuario, atual);

  await tx
    .update(tabela_certificado)
    .set({ substituido_por_id: novo.id })
    .where(eq(tabela_certificado.id, certificado.id));
  certificado.substituido_por_id = novo.id;
  await auditoria.registrar(tx, {
    entidade: "certificado",
    entidade_id: novo.id,
    tipo_evento: CERTIFICADO_RETIFICADO,
    descricao:
      `Certificado ${C.rotulo(novo)} substitui ${C.rotulo(certificado)}` +
      (corrigidos.length ? ` (corrigido: ${corrigidos.join(", ")})` : " (reemitido sem mudança de cadastro)") +
      `: ${limpo}`,
    comentario: limpo,
    usuario,
  });

  const outros = await tx
    .select({ id: tabela_certificado.id })
    .from(tabela_certificado)
    .where(
      and(
        eq(tabela_certificado.participante_id, certificado.participante_id),
        eq(tabela_certificado.situacao, "EMITIDO"),
        ne(tabela_certificado.id, novo.id),
      ),
    );
  return { antigo: certificado, novo, corrigidos, outros_em_vigor: corrigidos.length ? outros.length : 0 };
}
