/**
 * O envio de e-mail (NUVEM): uma caixa de saída (`email_saida`) e um SMTP.
 *
 * Quem pede o envio só GRAVA a linha (`enfileirar`), na transação do pedido:
 * se o pedido desfaz, o e-mail some junto. Quem envia é `processar_fila`,
 * chamada pela função de fundo `email-background` (acordada logo depois do
 * pedido) e pela agendada `email-agendado` (a cada 10 min, de reserva). O PDF
 * do certificado e a conversa com o SMTP não cabem no tempo de uma tela.
 *
 * O provedor é qualquer SMTP: o institucional, o Gmail do setor com senha de
 * app, ou um serviço de envio (Brevo, Resend…). Configuração no Netlify:
 *
 * - `CSSO_SMTP_URL` — `smtps://usuario:senha@smtp.exemplo.com:465` (ou
 *   `smtp://…:587`, que sobe para TLS). Segredo: só no painel.
 * - `CSSO_EMAIL_REMETENTE` — `"Sistema SISA · UFVJM" <csso@exemplo.com>`.
 * - `CSSO_EMAIL_RESPONDER_PARA` — opcional: para onde vai a resposta.
 *
 * Sem as duas primeiras o envio está desligado: os pedidos ficam na caixa,
 * PENDENTES, e saem quando ele for ligado. A tela diz isso.
 *
 * O anexo (o certificado) não fica na caixa: é montado na hora do envio por
 * quem o tipo registrou (`registrar_anexador`) — ver `envio_certificado.ts`.
 */
import { and, asc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import nodemailer from "nodemailer";
import type { Executor } from "../db/cliente.js";
import { agora_utc, email_saida as tabela } from "../db/esquema/index.js";
import { global } from "../web.js";
import { mensagem_sem_dados } from "./privacidade.js";

export type EmailRegistro = typeof tabela.$inferSelect;

export const MAXIMO_TENTATIVAS = 5;
/** Quanto a linha fica "presa" a quem a pegou: passado isso, outro envio a retoma. */
export const POSSE_MS = 10 * 60_000;

export const ROTULO_SITUACAO: Readonly<Record<string, string>> = {
  PENDENTE: "Na fila",
  ENVIADO: "Enviado",
  FALHOU: "Falhou",
  CANCELADO: "Cancelado",
};

export function configurado(): boolean {
  return Boolean((process.env.CSSO_SMTP_URL || "").trim() && (process.env.CSSO_EMAIL_REMETENTE || "").trim());
}

/**
 * O que falta para o envio ligar, SÓ pelos nomes das variáveis (nunca valor):
 * a tela /config e a ferramenta `testar-email` dizem "faltam tais variáveis"
 * sem tocar no segredo.
 */
export function variaveis_faltando(): string[] {
  const falta: string[] = [];
  if (!(process.env.CSSO_SMTP_URL || "").trim()) falta.push("CSSO_SMTP_URL");
  if (!(process.env.CSSO_EMAIL_REMETENTE || "").trim()) falta.push("CSSO_EMAIL_REMETENTE");
  return falta;
}

export interface DescricaoSmtp {
  /** a URL é válida e dá para saber servidor e porta */
  valida: boolean;
  servidor: string;
  porta: number | null;
  /** `smtps://` (TLS já na conexão, porta 465) ou `smtp://` (sobe para TLS, porta 587) */
  protocolo: string;
  /** o SMTP pede usuário e senha (só diz que há; nunca o valor) */
  com_login: boolean;
}

/** Servidor, porta e protocolo da `CSSO_SMTP_URL`, SEM usuário nem senha. */
export function descrever_smtp(): DescricaoSmtp | null {
  const bruto = (process.env.CSSO_SMTP_URL || "").trim();
  if (!bruto) return null;
  try {
    const u = new URL(bruto);
    const protocolo = u.protocol.replace(/:$/, "");
    const padrao = protocolo === "smtps" ? 465 : 587;
    return {
      valida: protocolo === "smtp" || protocolo === "smtps",
      servidor: u.hostname,
      porta: u.port ? Number(u.port) : padrao,
      protocolo,
      com_login: Boolean(u.username),
    };
  } catch {
    return { valida: false, servidor: "", porta: null, protocolo: "", com_login: false };
  }
}

/** Tira do texto a URL do SMTP, o usuário e a senha, se aparecerem numa mensagem de erro. */
export function sem_segredos(texto: string): string {
  let saida = texto;
  const bruto = (process.env.CSSO_SMTP_URL || "").trim();
  const segredos = [bruto];
  try {
    const u = new URL(bruto);
    segredos.push(u.password, decodeURIComponent(u.password), u.username, decodeURIComponent(u.username));
  } catch {
    /* URL inválida: só a inteira */
  }
  for (const segredo of segredos) if (segredo && segredo.length >= 3) saida = saida.split(segredo).join("***");
  return saida;
}

// as telas dizem "o envio está desligado" sem perguntar à rota
global("email_configurado", configurado);

const RE_EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export function email_valido(email: string | null | undefined): boolean {
  return RE_EMAIL.test((email ?? "").trim());
}

// ---------------------------------------------------------------------
// O transporte (trocável no teste)
// ---------------------------------------------------------------------
export interface Mensagem {
  para: string;
  assunto: string;
  texto: string;
  anexos: { nome: string; tipo: string; bytes: Uint8Array }[];
}

export type Transporte = (m: Mensagem) => Promise<void>;

function _smtp(): Transporte {
  const transporte = nodemailer.createTransport(process.env.CSSO_SMTP_URL!.trim(), {
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  } as never);
  return async (m) => {
    await transporte.sendMail({
      from: process.env.CSSO_EMAIL_REMETENTE!.trim(),
      replyTo: (process.env.CSSO_EMAIL_RESPONDER_PARA || "").trim() || undefined,
      to: m.para,
      subject: m.assunto,
      text: m.texto,
      attachments: m.anexos.map((a) => ({ filename: a.nome, contentType: a.tipo, content: Buffer.from(a.bytes) })),
    });
  };
}

/**
 * Confere a conexão e o login com o SMTP, sem enviar nada. Devolve `null` se
 * está tudo certo, ou o motivo (já sem segredo). Usada pela ferramenta
 * `testar-email`.
 */
export async function verificar_smtp(): Promise<string | null> {
  if (!configurado()) return "envio não configurado";
  try {
    const t = nodemailer.createTransport(process.env.CSSO_SMTP_URL!.trim(), {
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    } as never);
    await t.verify();
    return null;
  } catch (erro) {
    return sem_segredos(erro instanceof Error ? erro.message : String(erro));
  }
}

/** Envia UMA mensagem agora, sem passar pela fila (a ferramenta `testar-email`). */
export async function enviar_agora(m: Mensagem): Promise<void> {
  const t = _transporte();
  if (!t) throw new Error("envio não configurado");
  await t(m);
}

let _transporte_de_teste: Transporte | null = null;

/** Para o teste: o "SMTP" que guarda a mensagem em vez de enviar. `null` volta ao real. */
export function definir_transporte(t: Transporte | null): void {
  _transporte_de_teste = t;
}

function _transporte(): Transporte | null {
  if (_transporte_de_teste) return _transporte_de_teste;
  return configurado() ? _smtp() : null;
}

// ---------------------------------------------------------------------
// Anexos por tipo
// ---------------------------------------------------------------------
export type Anexador = (tx: Executor, email: EmailRegistro) => Promise<Mensagem["anexos"]>;
const _anexadores = new Map<string, Anexador>();

export function registrar_anexador(tipo: string, anexador: Anexador): void {
  _anexadores.set(tipo, anexador);
}

// ---------------------------------------------------------------------
// Enfileirar
// ---------------------------------------------------------------------
export interface Pedido {
  tipo: string;
  destinatario: string;
  assunto: string;
  corpo: string;
  certificado_id?: number | null;
  inscricao_id?: number | null;
  criado_por?: number | null;
  /** depois disto a mensagem não sai mais (vira CANCELADO): o aviso que só vale na hora */
  expira_em?: Date | null;
}

export async function enfileirar(tx: Executor, p: Pedido): Promise<EmailRegistro> {
  const destinatario = p.destinatario.trim();
  if (!email_valido(destinatario)) throw new Error(`destinatario invalido para ${p.tipo}`);
  const [linha] = await tx
    .insert(tabela)
    .values({
      tipo: p.tipo,
      destinatario,
      assunto: p.assunto.slice(0, 200),
      corpo: p.corpo,
      certificado_id: p.certificado_id ?? null,
      inscricao_id: p.inscricao_id ?? null,
      criado_por: p.criado_por ?? null,
      expira_em: p.expira_em ?? null,
    })
    .returning();
  return linha!;
}

/** O que venceu na fila sem sair vira CANCELADO, com o motivo. Devolve quantos. */
export async function vencer(db: Executor, agora: Date = new Date()): Promise<number> {
  const r = await db
    .update(tabela)
    .set({ situacao: "CANCELADO", ultimo_erro: "Venceu antes do envio." })
    .where(and(eq(tabela.situacao, "PENDENTE"), lte(tabela.expira_em, agora)))
    .returning({ id: tabela.id });
  return r.length;
}

/** Devolve à fila o que falhou de vez (a tela "tentar de novo"). */
export async function reenfileirar(tx: Executor, id: number): Promise<boolean> {
  const r = await tx
    .update(tabela)
    .set({ situacao: "PENDENTE", tentativas: 0, proxima_tentativa_em: agora_utc(), ultimo_erro: null })
    .where(and(eq(tabela.id, id), eq(tabela.situacao, "FALHOU")))
    .returning({ id: tabela.id });
  return r.length > 0;
}

export async function cancelar(tx: Executor, id: number): Promise<boolean> {
  const r = await tx
    .update(tabela)
    .set({ situacao: "CANCELADO" })
    .where(and(eq(tabela.id, id), sql`${tabela.situacao} IN ('PENDENTE','FALHOU')`))
    .returning({ id: tabela.id });
  return r.length > 0;
}

// ---------------------------------------------------------------------
// Enviar
// ---------------------------------------------------------------------
/** Espera antes da próxima tentativa: 1, 5, 15, 60 min. */
function _espera_ms(tentativa: number): number {
  return [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000][Math.min(tentativa - 1, 3)]!;
}

/**
 * Pega UMA linha vencida, em transação curta, e a empurra para frente
 * (`POSSE_MS`): outro envio em paralelo (`SKIP LOCKED`) pega a seguinte.
 */
async function _pegar(db: Executor, agora: Date): Promise<EmailRegistro | null> {
  return db.transaction(async (tx) => {
    const [livre] = await tx
      .select({ id: tabela.id })
      .from(tabela)
      .where(
        and(
          eq(tabela.situacao, "PENDENTE"),
          lte(tabela.proxima_tentativa_em, agora),
          or(isNull(tabela.expira_em), gt(tabela.expira_em, agora)),
        ),
      )
      .orderBy(asc(tabela.proxima_tentativa_em), asc(tabela.id))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!livre) return null;
    const [linha] = await tx
      .update(tabela)
      .set({
        tentativas: sql`${tabela.tentativas} + 1`,
        proxima_tentativa_em: new Date(agora.getTime() + POSSE_MS),
      })
      .where(eq(tabela.id, livre.id))
      .returning();
    return linha ?? null;
  });
}

export interface ResultadoFila {
  enviados: number;
  falhas: number;
  /** desligado: nada saiu, e nada foi tocado */
  desligado: boolean;
}

/**
 * Esvazia a fila até `prazo_ms` ou `limite` mensagens. O erro de uma não para
 * as outras; a mensagem de erro vai SEM dado pessoal (`mensagem_sem_dados`).
 *
 * `db` é o banco (as funções do Netlify) ou a transação de uma tela ("enviar
 * agora"): aí cada envio vira um savepoint dela — o pool é de UMA conexão.
 */
export async function processar_fila(
  db: Executor,
  opcoes: { prazo_ms?: number; limite?: number; agora?: () => Date } = {},
): Promise<ResultadoFila> {
  const resultado: ResultadoFila = { enviados: 0, falhas: 0, desligado: false };
  const relogio = opcoes.agora ?? (() => new Date());
  // o vencido sai da fila mesmo com o envio desligado: ligado dias depois, o
  // aviso de "agora" chegaria fora de hora
  await vencer(db, relogio());
  const transporte = _transporte();
  if (!transporte) return { ...resultado, desligado: true };
  const fim = Date.now() + (opcoes.prazo_ms ?? 20_000);
  const limite = opcoes.limite ?? 50;
  while (Date.now() < fim && resultado.enviados + resultado.falhas < limite) {
    const email = await _pegar(db, relogio());
    if (!email) break;
    try {
      await db.transaction(async (tx) => {
        const anexador = _anexadores.get(email.tipo);
        const anexos = anexador ? await anexador(tx as Executor, email) : [];
        await transporte({ para: email.destinatario, assunto: email.assunto, texto: email.corpo ?? "", anexos });
        await tx
          .update(tabela)
          .set({ situacao: "ENVIADO", enviado_em: agora_utc(), ultimo_erro: null })
          .where(eq(tabela.id, email.id));
      });
      resultado.enviados += 1;
    } catch (erro) {
      resultado.falhas += 1;
      const desistiu = email.tentativas >= MAXIMO_TENTATIVAS;
      await db
        .update(tabela)
        .set({
          situacao: desistiu ? "FALHOU" : "PENDENTE",
          ultimo_erro: sem_segredos(mensagem_sem_dados(erro)).slice(0, 500),
          proxima_tentativa_em: new Date(relogio().getTime() + _espera_ms(email.tentativas)),
        })
        .where(eq(tabela.id, email.id));
      console.error(`[email ${email.id}] tentativa ${email.tentativas}: ${sem_segredos(mensagem_sem_dados(erro))}`);
    }
  }
  return resultado;
}

/**
 * Acorda a função de fundo que envia — logo depois do pedido, para o e-mail
 * não esperar a agendada. Sem URL do site (servidor local, teste) não faz
 * nada; a falha aqui nunca derruba o pedido (a agendada pega depois).
 */
export async function acordar_envio(): Promise<void> {
  const segredo = process.env.CSSO_ROTINA_SEGREDO ?? "";
  const base = (process.env.URL || "").replace(/\/+$/, "");
  if (!base || segredo.length < 32 || !configurado()) return;
  try {
    await fetch(`${base}/.netlify/functions/email-background`, {
      method: "POST",
      headers: { "x-csso-rotina": segredo },
      signal: AbortSignal.timeout(3_000),
    });
  } catch (erro) {
    console.warn(`[email] não acordou o envio: ${mensagem_sem_dados(erro)}`);
  }
}

/** A caixa, mais recente primeiro (a tela). */
export async function caixa(tx: Executor, opcoes: { situacao?: string; limite?: number } = {}) {
  const onde = opcoes.situacao ? eq(tabela.situacao, opcoes.situacao) : undefined;
  return tx
    .select()
    .from(tabela)
    .where(onde)
    .orderBy(sql`${tabela.id} DESC`)
    .limit(opcoes.limite ?? 200);
}

export async function contagem(tx: Executor): Promise<Record<string, number>> {
  const linhas = await tx
    .select({ situacao: tabela.situacao, n: sql<number>`count(*)::int` })
    .from(tabela)
    .groupBy(tabela.situacao);
  const saida: Record<string, number> = { PENDENTE: 0, ENVIADO: 0, FALHOU: 0, CANCELADO: 0 };
  for (const l of linhas) saida[l.situacao] = Number(l.n);
  return saida;
}

/** O corpo leva o nome da pessoa; passado o prazo, sai — a linha fica. */
export const DIAS_DO_CORPO = 90;

export async function expurgar_corpos(tx: Executor, agora: Date = new Date(), dias = DIAS_DO_CORPO): Promise<number> {
  const limite = new Date(agora.getTime() - dias * 86_400_000);
  const r = await tx
    .update(tabela)
    .set({ corpo: null })
    .where(and(sql`${tabela.corpo} IS NOT NULL`, sql`${tabela.situacao} <> 'PENDENTE'`, lte(tabela.criado_em, limite)))
    .returning({ id: tabela.id });
  return r.length;
}
