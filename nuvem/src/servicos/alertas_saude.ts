/**
 * Os alertas de saúde do sistema — o que `/saude/db` mostra e o que o aviso
 * diário por e-mail (`netlify/functions/alerta-saude.mts`) leva à administração.
 *
 * Antes só aparecia se alguém abrisse a tela: backup que falhou, cadeia da
 * trilha rompida ou e-mail parado ficavam dias sem ninguém ver. O texto de cada
 * alerta diz o quê e nunca leva dado pessoal (vai por e-mail).
 */
import { and, eq, lt, sql } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import { email_saida } from "../db/esquema/index.js";
import { obterConfig } from "../config.js";
import * as email from "./email.js";
import { ROTINA_BACKUP, ROTINA_CADEIA, ROTINA_PRIVACIDADE, ROTINA_SESSOES, ultimas_execucoes } from "./rotinas.js";

/** Backup mais velho que isto é alerta: a rotina é diária, com folga de meio dia. */
export const BACKUP_ATRASADO_HORAS = 36;
/** Rotina noturna que não conclui há mais que isto parou. */
export const ROTINA_PARADA_HORAS = 36;
/** E-mail na fila há mais que isto sem sair: o envio travou. */
export const EMAIL_PARADO_HORAS = 6;

export const TIPO_ALERTA = "ALERTA_SAUDE";

const ROTINAS_DIARIAS = [ROTINA_CADEIA, ROTINA_PRIVACIDADE, ROTINA_SESSOES];

export async function alertas_de_saude(tx: Executor, agora: Date = new Date()): Promise<string[]> {
  const alertas: string[] = [];
  const rotinas = await ultimas_execucoes(tx);
  const ultimoBackup = rotinas.find((r) => r.rotina === ROTINA_BACKUP);
  if (!ultimoBackup) alertas.push("nenhum backup registrado");
  else if (!ultimoBackup.ok) alertas.push("o último backup FALHOU");
  else if (agora.getTime() - new Date(ultimoBackup.concluida_em).getTime() > BACKUP_ATRASADO_HORAS * 3_600_000) {
    alertas.push(`o último backup tem mais de ${BACKUP_ATRASADO_HORAS} horas`);
  }
  for (const r of rotinas) {
    if (r.rotina === ROTINA_BACKUP) continue;
    if (!r.ok) {
      alertas.push(
        r.rotina === ROTINA_CADEIA
          ? "a conferência da cadeia da trilha FALHOU ou a encontrou rompida — trate como incidente"
          : `a última passada de ${r.rotina} falhou`,
      );
    } else if (
      ROTINAS_DIARIAS.includes(r.rotina) &&
      agora.getTime() - new Date(r.concluida_em).getTime() > ROTINA_PARADA_HORAS * 3_600_000
    ) {
      alertas.push(`a rotina ${r.rotina} não conclui há mais de ${ROTINA_PARADA_HORAS} horas`);
    }
  }
  const [{ falhos } = { falhos: 0 }] = await tx
    .select({ falhos: sql<number>`count(*)::int` })
    .from(email_saida)
    .where(eq(email_saida.situacao, "FALHOU"));
  if (falhos) alertas.push(`${falhos} e-mail(s) com envio falho na caixa de saída`);
  const limite = new Date(agora.getTime() - EMAIL_PARADO_HORAS * 3_600_000);
  const [{ parados } = { parados: 0 }] = await tx
    .select({ parados: sql<number>`count(*)::int` })
    .from(email_saida)
    .where(and(eq(email_saida.situacao, "PENDENTE"), lt(email_saida.criado_em, limite)));
  if (parados) alertas.push(`${parados} e-mail(s) na fila há mais de ${EMAIL_PARADO_HORAS} horas sem sair`);
  return alertas;
}

export type ResultadoAviso = { enviado: false; motivo: string } | { enviado: true; alertas: number };

/**
 * Enfileira o e-mail de alerta para `CSSO_ALERTA_EMAIL`, quando há alerta. Sem
 * endereço configurado não avisa (e diz por quê); sem alerta não manda nada.
 */
export async function avisar_administracao(tx: Executor, agora: Date = new Date()): Promise<ResultadoAviso> {
  const destino = obterConfig().alertaEmail;
  if (!destino) return { enviado: false, motivo: "CSSO_ALERTA_EMAIL não configurado" };
  if (!email.email_valido(destino)) return { enviado: false, motivo: "CSSO_ALERTA_EMAIL inválido" };
  const alertas = await alertas_de_saude(tx, agora);
  if (!alertas.length) return { enviado: false, motivo: "sem alertas" };
  const raiz = (process.env.CSSO_URL_PUBLICA || process.env.URL || "").trim().replace(/\/+$/, "");
  await email.enfileirar(tx, {
    tipo: TIPO_ALERTA,
    destinatario: destino,
    assunto: `Sistema SISA — ${alertas.length} alerta(s) de saúde`,
    corpo:
      `A conferência diária do Sistema SISA encontrou:\n\n${alertas.map((a) => `• ${a}`).join("\n")}\n\n` +
      `Detalhes em ${raiz}/saude/db (entre com uma conta de administração).\n\n` +
      "--\nSistema SISA · UFVJM\nMensagem automática: não responda. Ela chega todo dia enquanto houver alerta.",
  });
  return { enviado: true, alertas: alertas.length };
}
