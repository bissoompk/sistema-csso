/**
 * O aviso de reciclagem por e-mail ao participante: "o seu certificado vence
 * (ou venceu) — procure a CSSO".
 *
 * Duas portas, a mesma função:
 *
 * - **na tela** (`/certificados/vencimentos`), quem tem `certificado.emitir`
 *   marca e avisa;
 * - **automática**, desligada até alguém com `treinamento.gerenciar` a ligar:
 *   a varredura noturna (`reciclagem.varrer`) avisa uma vez, no dia em que o
 *   certificado entra na janela de 30 dias. Ligar é o ato da CSSO que o ROPA
 *   pede para todo e-mail que sai (§5.9).
 *
 * Um aviso por certificado: o que já foi (ou está na fila) não sai de novo
 * por nenhuma das duas portas.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  certificado as tabela_certificado,
  email_saida as tabela_email,
  parametro as tabela_parametro,
} from "../db/esquema/index.js";
import { Certificado as C } from "../dominio/treinamento.js";
import * as auditoria from "./auditoria.js";
import * as datas_br from "./datas_br.js";
import * as email from "./email.js";
import * as servico from "./emissao_certificado.js";
import { destinatario } from "./envio_certificado.js";
import type { UsuarioAtual } from "./rbac.js";

export const TIPO = "RECICLAGEM_AVISO";
export const PARAMETRO_AUTOMATICO = "reciclagem.aviso_email_automatico";

type CertificadoRegistro = typeof tabela_certificado.$inferSelect;

export interface ResultadoAviso {
  enfileirados: number;
  sem_email: number;
  ja_avisados: number;
  // separados, porque cada um pede uma coisa: o anulado já foi substituído, o
  // sem vencimento não recicla, e o fora do escopo é de outro campus
  anulados: number;
  sem_vencimento: number;
  fora: number;
}

export async function automatico_ligado(tx: Executor): Promise<boolean> {
  const [p] = await tx.select().from(tabela_parametro).where(eq(tabela_parametro.chave, PARAMETRO_AUTOMATICO));
  return p?.valor === "sim";
}

export async function definir_automatico(tx: Executor, usuario: UsuarioAtual, ligado: boolean): Promise<void> {
  usuario.exigir("treinamento.gerenciar");
  const valor = ligado ? "sim" : "nao";
  await tx
    .insert(tabela_parametro)
    .values({
      chave: PARAMETRO_AUTOMATICO,
      valor,
      descricao: "Avisar por e-mail, uma vez, o participante cujo certificado entra na janela de reciclagem",
    })
    .onConflictDoUpdate({ target: tabela_parametro.chave, set: { valor } });
  await auditoria.registrar(tx, {
    entidade: "parametro",
    entidade_id: 0,
    tipo_evento: "RECICLAGEM_AVISO_AUTOMATICO",
    descricao: `Aviso de reciclagem por e-mail automático ${ligado ? "ligado" : "desligado"}`,
    campo: PARAMETRO_AUTOMATICO,
    valor_novo: valor,
    usuario,
  });
}

/** Os certificados (da lista) que já têm aviso enviado ou na fila. */
export async function ja_avisados(tx: Executor, ids: number[]): Promise<Set<number>> {
  if (!ids.length) return new Set();
  const linhas = await tx
    .select({ certificado_id: tabela_email.certificado_id })
    .from(tabela_email)
    .where(
      and(
        eq(tabela_email.tipo, TIPO),
        inArray(tabela_email.certificado_id, ids),
        inArray(tabela_email.situacao, ["PENDENTE", "ENVIADO"]),
      ),
    );
  return new Set(linhas.map((l) => l.certificado_id!));
}

function _mensagem(certificado: CertificadoRegistro, hoje: string): { assunto: string; corpo: string } {
  const c = servico.montar_contexto(null, certificado);
  const vence = certificado.data_vencimento!;
  const venceu = vence < hoje;
  return {
    assunto: `Reciclagem — ${c.treinamento_nome}`.slice(0, 200),
    corpo:
      `Olá, ${c.participante_nome}.\n\n` +
      `O seu certificado do treinamento ${c.treinamento_nome} (nº ${C.rotulo(certificado)}, ` +
      `turma ${c.turma_codigo}) ${venceu ? "venceu" : "vence"} em ${datas_br.numerica(vence)}.\n\n` +
      "Para manter a capacitação em dia, procure a CSSO para se inscrever na próxima turma de reciclagem.\n\n" +
      "Coordenação de Saúde e Segurança Ocupacional (CSSO) — UFVJM\n" +
      "Mensagem enviada pelo Sistema CSSO.\n",
  };
}

async function _avisar(
  tx: Executor,
  certificados: CertificadoRegistro[],
  autor: UsuarioAtual | null,
  hoje: string,
): Promise<ResultadoAviso> {
  const r: ResultadoAviso = { enfileirados: 0, sem_email: 0, ja_avisados: 0, anulados: 0, sem_vencimento: 0, fora: 0 };
  const avisados = await ja_avisados(
    tx,
    certificados.map((c) => c.id),
  );
  for (const certificado of certificados) {
    if (certificado.situacao !== "EMITIDO") {
      r.anulados += 1;
      continue;
    }
    if (certificado.data_vencimento === null) {
      r.sem_vencimento += 1;
      continue;
    }
    if (avisados.has(certificado.id)) {
      r.ja_avisados += 1;
      continue;
    }
    const para = await destinatario(tx, certificado);
    if (!para) {
      r.sem_email += 1;
      continue;
    }
    const { assunto, corpo } = _mensagem(certificado, hoje);
    await email.enfileirar(tx, {
      tipo: TIPO,
      destinatario: para,
      assunto,
      corpo,
      certificado_id: certificado.id,
      criado_por: autor?.id ?? null,
    });
    await auditoria.registrar(tx, {
      entidade: "certificado",
      entidade_id: certificado.id,
      tipo_evento: "RECICLAGEM_AVISO_PEDIDO",
      descricao:
        `Aviso de reciclagem por e-mail do certificado ${C.rotulo(certificado)}` +
        (autor ? "" : " (automático, pela varredura noturna)"),
      usuario: autor,
    });
    r.enfileirados += 1;
  }
  return r;
}

/** A porta da tela: os marcados no monitor, no escopo de quem pede. */
export async function avisar_marcados(
  tx: Executor,
  usuario: UsuarioAtual,
  ids: number[],
  hoje: string = datas_br.hoje(),
): Promise<ResultadoAviso> {
  usuario.exigir("certificado.emitir");
  const certificados: CertificadoRegistro[] = [];
  let fora = 0;
  for (const id of ids) {
    const certificado = await servico.no_escopo(tx, usuario, id);
    if (certificado) certificados.push(certificado);
    else fora += 1;
  }
  const r = await _avisar(tx, certificados, usuario, hoje);
  return { ...r, fora: r.fora + fora };
}

/** A porta da varredura: um certificado que acabou de entrar na janela. */
export async function avisar_pela_rotina(tx: Executor, certificado_id: number, hoje: string): Promise<boolean> {
  const [certificado] = await tx.select().from(tabela_certificado).where(eq(tabela_certificado.id, certificado_id));
  if (!certificado) return false;
  return (await _avisar(tx, [certificado], null, hoje)).enfileirados > 0;
}

export function resumo(r: ResultadoAviso): string {
  const partes = [`${r.enfileirados} aviso(s) de reciclagem na fila de envio`];
  if (r.ja_avisados) partes.push(`${r.ja_avisados} já avisado(s) antes`);
  if (r.sem_email) partes.push(`${r.sem_email} sem e-mail cadastrado`);
  if (r.anulados) partes.push(`${r.anulados} anulado(s), que não recebe(m) aviso`);
  if (r.sem_vencimento) partes.push(`${r.sem_vencimento} sem vencimento (treinamento que não expira)`);
  if (r.fora) partes.push(`${r.fora} fora do seu escopo ou inexistente(s)`);
  let frase = partes.join("; ") + ".";
  if (r.enfileirados && !email.configurado()) {
    frase += " O envio de e-mail ainda não está ligado: eles saem quando for configurado.";
  }
  return frase;
}
