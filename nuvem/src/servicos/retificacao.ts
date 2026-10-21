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
import * as datas_br from "./datas_br.js";
import * as servico_presenca from "./presenca.js";
import {
  carregar_inscricao,
  editar_turma,
  inscricoes_da_turma,
  RegraDaTurma,
  type TurmaCarregada,
  type TurmaRegistro,
} from "./turma.js";

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

// ---------------------------------------------------------------------
// A turma concluída com dado errado
// ---------------------------------------------------------------------
export const TURMA_RETIFICADA = "TURMA_RETIFICADA";

/**
 * O que se corrige na turma depois de concluída: o que sai no papel. Vagas,
 * prazo de inscrição, nota e frequência mínimas ficam de fora — mudá-los
 * depois do fato mudaria quem passou, e isso é retificar presença ou nota,
 * que já existe (aba Presença e notas).
 */
export const CAMPOS_DA_TURMA_CONCLUIDA = [
  "data_inicio",
  "data_fim",
  "local",
  "descricao",
  "campus_id",
  "unidade_promotora_id",
  "carga_horaria_horas",
  "data_base_vencimento",
  "observacoes",
] as const;

const ROTULO_CAMPO_TURMA: Record<string, string> = {
  data_inicio: "início",
  data_fim: "término",
  local: "local",
  descricao: "descrição",
  campus_id: "campus",
  unidade_promotora_id: "unidade promotora",
  carga_horaria_horas: "carga horária",
  data_base_vencimento: "data base do vencimento",
  observacoes: "observações",
};

export interface ResultadoTurma {
  mudou: boolean;
  // inscritos cujo resultado mudou com a carga nova
  reapurados: number;
  // certificados em vigor que continuam com o dado antigo até serem reemitidos
  em_vigor: number;
}

/**
 * Corrige a turma CONCLUÍDA, com motivo. Os certificados já emitidos não mudam
 * — cada papel diz o que dizia —; a tela oferece reemitir todos de uma vez.
 *
 * Duas travas além das de `editar_turma`: o período novo tem de conter todo
 * dia de presença lançado, e a carga nova não pode reprovar quem já tem
 * certificado em vigor (anule-o antes: certificado de reprovado não existe).
 */
export async function retificar_turma(
  tx: Executor,
  usuario: UsuarioAtual,
  turma: TurmaCarregada,
  campos: Partial<TurmaRegistro>,
  motivo: string | null | undefined,
): Promise<ResultadoTurma> {
  usuario.exigir("turma.concluir");
  if (turma.situacao !== "CONCLUIDA") {
    throw new RegraDaTurma("Só a turma concluída se corrige por aqui; a que não acabou se edita normalmente.");
  }
  const limpo = (motivo ?? "").trim();
  if (!limpo) {
    throw new RegraDaTurma("Corrigir turma concluída exige o motivo: o que ela dizia já foi comunicado a quem participou.");
  }
  const permitidos = new Set<string>(CAMPOS_DA_TURMA_CONCLUIDA);
  const so_permitidos = Object.fromEntries(Object.entries(campos).filter(([k]) => permitidos.has(k))) as Partial<TurmaRegistro>;
  const mudados = Object.keys(so_permitidos).filter((k) => {
    const novo = so_permitidos[k as keyof TurmaRegistro] ?? null;
    const atual = turma[k as keyof TurmaRegistro] ?? null;
    // '8.0' e '8' são a mesma carga
    if (k === "carga_horaria_horas" && novo !== null && atual !== null) {
      return servico_presenca.comparar(String(novo), String(atual)) !== 0;
    }
    return String(novo ?? "") !== String(atual ?? "");
  });
  if (!mudados.length) return { mudou: false, reapurados: 0, em_vigor: 0 };

  const inscricoes = await inscricoes_da_turma(tx, turma);
  const inicio = so_permitidos.data_inicio ?? turma.data_inicio;
  const fim = so_permitidos.data_fim ?? turma.data_fim;
  const fora = inscricoes.flatMap((i) => i.presencas.filter((p) => p.data < inicio || p.data > fim).map((p) => p.data));
  if (fora.length) {
    const dias = [...new Set(fora)].sort().map(datas_br.numerica);
    throw new RegraDaTurma(
      `Há presença lançada em ${dias.join(", ")}, fora do período novo. Corrija a presença antes, ou o período.`,
    );
  }

  const ativos = await servico.certificados_da_turma(tx, turma);
  const carga_mudou = mudados.includes("carga_horaria_horas");
  if (carga_mudou) {
    // a avaliação com a carga nova, ANTES de gravar
    const simulada = { ...turma, carga_horaria_horas: so_permitidos.carga_horaria_horas ?? null } as TurmaCarregada;
    const reprovaria = inscricoes.filter(
      (i) =>
        Object.hasOwn(ativos, i.id) &&
        servico_presenca.avaliar(simulada, { ...i, turma: simulada }).situacao !== i.situacao,
    );
    if (reprovaria.length) {
      throw new RegraDaTurma(
        `Com a carga nova, ${reprovaria.length} pessoa(s) com certificado em vigor mudaria(m) de resultado ` +
          `(${reprovaria.map((i) => i.participante.identificador_publico).join(", ")}). ` +
          "Corrija a presença delas antes, ou anule o certificado.",
      );
    }
  }

  await editar_turma(tx, usuario, turma, so_permitidos, { concluida: true });
  let reapurados = 0;
  if (carga_mudou) {
    for (const i of inscricoes) {
      i.turma = turma;
      if (await servico_presenca.reapurar_inscricao(tx, usuario, i, `Carga da turma corrigida: ${limpo}`)) reapurados += 1;
    }
  }
  await auditoria.registrar(tx, {
    entidade: "turma",
    entidade_id: turma.id,
    tipo_evento: TURMA_RETIFICADA,
    descricao: `${turma.codigo} concluída, corrigida (${mudados.map((k) => ROTULO_CAMPO_TURMA[k] ?? k).join(", ")}): ${limpo}`,
    comentario: limpo,
    usuario,
  });
  return { mudou: true, reapurados, em_vigor: Object.keys(ativos).length };
}

export interface ResultadoLote {
  reemitidos: { antigo: string; novo: string }[];
  travados: { certificado: string; motivo: string }[];
}

/**
 * Reemite TODOS os certificados em vigor da turma com os dados de hoje: cada
 * um, a `retificar` de sempre (anula e emite o substituto), num savepoint — o
 * que trava fica como estava e não derruba os outros.
 */
export async function retificar_certificados_da_turma(
  tx: Executor,
  usuario: UsuarioAtual,
  turma: TurmaCarregada,
  motivo: string | null | undefined,
): Promise<ResultadoLote> {
  usuario.exigir("certificado.anular");
  usuario.exigir("certificado.emitir");
  const limpo = (motivo ?? "").trim();
  if (!limpo) throw new RetificacaoRecusada("Reemitir a turma exige o motivo, que vai para cada certificado anulado.");
  const ativos = Object.values(await servico.certificados_da_turma(tx, turma)).sort((a, b) => a.id - b.id);
  const r: ResultadoLote = { reemitidos: [], travados: [] };
  for (const certificado of ativos) {
    try {
      const feito = await tx.transaction((sp) => retificar(sp as Executor, usuario, certificado, limpo));
      r.reemitidos.push({ antigo: C.rotulo(feito.antigo), novo: C.rotulo(feito.novo) });
    } catch (erro) {
      if (!(erro instanceof RegraViolada)) throw erro;
      r.travados.push({ certificado: C.rotulo(certificado), motivo: erro.message });
    }
  }
  return r;
}
