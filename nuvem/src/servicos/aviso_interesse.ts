/**
 * "Quero ser avisado" da vitrine pública (/cursos). Quem não achou turma aberta
 * deixa nome e e-mail e é avisado, uma vez por turma, quando abrir uma do
 * interesse escolhido (este curso, os cursos do setor, ou qualquer curso).
 *
 * LGPD (consentimento, art. 7º, I):
 * - só nome e e-mail; a caixa de consentimento nasce DESMARCADA e a versão do
 *   texto de finalidade fica gravada;
 * - **nada sai antes da confirmação** pelo link enviado ao e-mail; o cadastro
 *   não confirmado é apagado em 7 dias, o confirmado expira em 12 meses, o
 *   cancelado sai em 30 dias e o IP do consentimento em 90 (`privacidade.ts`);
 * - **a resposta é sempre a mesma** (e-mail novo, repetido ou inválido) e o
 *   tempo de resposta tem piso, para a página não revelar quem já está cadastrado;
 * - o link de saída de cada aviso é assinado com a chave do sistema e não
 *   pede login; abrir o link NÃO cancela (o pré-carregamento do leitor de
 *   e-mail não descadastra ninguém): só o botão "Confirmar saída" (POST);
 * - a trilha leva só o `id`, nunca o e-mail; a equipe vê CONTAGENS, nunca a lista.
 * Chave de ligar: parâmetro `aviso_interesse.ativo` (desligado por padrão, como
 * o aviso de reciclagem). Desligada, o cadastro funciona e o aviso da turma
 * não enfileira nada.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, count, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  aviso_interesse as tabela,
  aviso_interesse_envio as tabela_envio,
  parametro as tabela_parametro,
  campus as tabela_campus,
  treinamento as tabela_treinamento,
  unidade_uorg as tabela_unidade,
} from "../db/esquema/index.js";
import { obterConfig } from "../config.js";
import { normalizar_email } from "../dominio/treinamento.js";
import * as auditoria from "./auditoria.js";
import * as datas_br from "./datas_br.js";
import * as email from "./email.js";
import * as emissao from "./emissao_certificado.js";
import type { UsuarioAtual } from "./rbac.js";
import type { TurmaCarregada } from "./turma.js";
import { url_da_ficha } from "./vitrine_divulgacao.js";

export const PARAMETRO_ATIVO = "aviso_interesse.ativo";
export const TIPO_CONFIRMAR = "AVISO_INT_CONFIRMAR";
export const TIPO_TURMA = "AVISO_INT_TURMA";
export const VERSAO_DO_TEXTO = "2026-10";
export const TEXTO_DE_FINALIDADE =
  "Usaremos seu nome e e-mail só para avisar quando abrir turma do interesse escolhido. Você confirma pelo e-mail e " +
  "pode sair a qualquer momento pelo link em cada aviso. O cadastro expira em 12 meses.";
export const RESPOSTA_PADRAO =
  "Se o e-mail for válido, você receberá uma mensagem para confirmar. O aviso só começa depois da confirmação.";

export const DIAS_PARA_CONFIRMAR = 7;
export const MESES_DE_VIDA = 12;
export const DIAS_DO_CANCELADO = 30;
export const DIAS_DO_IP = 90;
/** o mesmo cadastro reenvia a confirmação no máximo uma vez por hora */
export const MINUTOS_ENTRE_REENVIOS = 60;

export const TIPOS = ["TREINAMENTO", "SETOR", "QUALQUER"] as const;
export type Tipo = (typeof TIPOS)[number];

export class CadastroInvalido extends Error {}

export interface DadosDoCadastro {
  nome: string;
  email: string;
  tipo: string;
  /** o id do treinamento (tipo TREINAMENTO) ou da unidade (tipo SETOR) */
  alvo: number | null;
  campus_id: number | null;
  consentimento: boolean;
}

// ---------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------
const _hash = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

/** O token do link de saída: `<id>.<assinatura>`, sem estado no banco. */
export function token_de_saida(id: number): string {
  const mac = createHmac("sha256", obterConfig().chaveSecreta).update(`aviso-sair:${id}`, "utf8").digest("base64url");
  return `${id}.${mac.slice(0, 32)}`;
}

/** O id de um token de saída válido, ou `null`. */
export function id_do_token_de_saida(token: string): number | null {
  const m = /^(\d{1,9})\.([A-Za-z0-9_-]{32})$/.exec(token);
  if (!m) return null;
  const esperado = Buffer.from(token_de_saida(Number(m[1])));
  const recebido = Buffer.from(token);
  return esperado.length === recebido.length && timingSafeEqual(esperado, recebido) ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------
// A chave de ligar
// ---------------------------------------------------------------------
export async function ativo(tx: Executor): Promise<boolean> {
  const [p] = await tx.select().from(tabela_parametro).where(eq(tabela_parametro.chave, PARAMETRO_ATIVO));
  return p?.valor === "sim";
}

export async function definir_ativo(tx: Executor, usuario: UsuarioAtual, ligado: boolean): Promise<void> {
  usuario.exigir("treinamento.gerenciar");
  const valor = ligado ? "sim" : "nao";
  await tx
    .insert(tabela_parametro)
    .values({ chave: PARAMETRO_ATIVO, valor, descricao: "Avisar por e-mail quem pediu aviso na vitrine quando abrir turma do interesse" })
    .onConflictDoUpdate({ target: tabela_parametro.chave, set: { valor } });
  await auditoria.registrar(tx, {
    entidade: "parametro",
    entidade_id: 0,
    tipo_evento: "AVISO_INTERESSE_CHAVE",
    descricao: `Aviso de interesse da vitrine ${ligado ? "ligado" : "desligado"}`,
    campo: PARAMETRO_ATIVO,
    valor_novo: valor,
    usuario,
  });
}

// ---------------------------------------------------------------------
// Cadastrar
// ---------------------------------------------------------------------
async function _alvo_existe(tx: Executor, tipo: Tipo, alvo: number | null, campus_id: number | null): Promise<boolean> {
  if (tipo === "TREINAMENTO") {
    const [t] = await tx.select({ id: tabela_treinamento.id }).from(tabela_treinamento).where(eq(tabela_treinamento.id, alvo!));
    if (!t) return false;
  }
  if (tipo === "SETOR") {
    const [u] = await tx.select({ id: tabela_unidade.id }).from(tabela_unidade).where(eq(tabela_unidade.id, alvo!));
    if (!u) return false;
  }
  if (campus_id !== null) {
    const [c] = await tx.select({ id: tabela_campus.id }).from(tabela_campus).where(eq(tabela_campus.id, campus_id));
    if (!c) return false;
  }
  return true;
}

function _validar(d: DadosDoCadastro): { nome: string; email: string; normalizado: string; tipo: Tipo } {
  const nome = d.nome.trim().replace(/\s+/g, " ");
  if (!nome || nome.length > 120) throw new CadastroInvalido("nome");
  const endereco = d.email.trim();
  if (!email.email_valido(endereco) || endereco.length > 254) throw new CadastroInvalido("email");
  if (!(TIPOS as readonly string[]).includes(d.tipo)) throw new CadastroInvalido("tipo");
  if (!d.consentimento) throw new CadastroInvalido("consentimento");
  const tipo = d.tipo as Tipo;
  if (tipo !== "QUALQUER" && d.alvo === null) throw new CadastroInvalido("alvo");
  return { nome, email: endereco, normalizado: normalizar_email(endereco), tipo };
}

async function _mandar_confirmacao(tx: Executor, id: number, nome: string, para: string, token: string): Promise<void> {
  const url = `${await emissao.url_base_validacao(tx)}/cursos/avise-me/confirmar/${token}`;
  await email.enfileirar(tx, {
    tipo: TIPO_CONFIRMAR,
    destinatario: para,
    assunto: "Confirme seu pedido de aviso de cursos da SISA",
    corpo:
      `Olá, ${nome}.\n\n` +
      "Alguém (esperamos que você) pediu para ser avisado quando abrirem turmas de cursos da SISA/UFVJM.\n\n" +
      `Para confirmar, abra o link (vale por ${DIAS_PARA_CONFIRMAR} dias):\n${url}\n\n` +
      "Se não foi você, ignore esta mensagem: sem a confirmação, nada será enviado e o pedido é apagado.\n\n" +
      "Sistema SISA — UFVJM\n",
    // o link morre com o pedido: a mensagem não sai depois disso
    expira_em: new Date(Date.now() + DIAS_PARA_CONFIRMAR * 86_400_000),
  });
  await tx.update(tabela).set({ confirmacao_enviada_em: new Date() }).where(eq(tabela.id, id));
}

/**
 * Registra o pedido e manda o e-mail de confirmação. **Devolve sempre a mesma
 * coisa** para e-mail novo, repetido, já confirmado ou com envio recente: quem
 * chama não pode distinguir. Dado inválido levanta `CadastroInvalido` (erro de
 * formulário, que a rota mostra sem revelar nada sobre cadastros).
 */
export async function cadastrar(tx: Executor, d: DadosDoCadastro, ip: string | null, agora: Date = new Date()): Promise<string> {
  const v = _validar(d);
  if (!(await _alvo_existe(tx, v.tipo, d.tipo === "QUALQUER" ? null : d.alvo, d.campus_id))) throw new CadastroInvalido("alvo");
  const [existente] = await tx
    .select()
    .from(tabela)
    .where(
      and(
        eq(tabela.email_normalizado, v.normalizado),
        eq(tabela.tipo, v.tipo),
        v.tipo === "TREINAMENTO" ? eq(tabela.treinamento_id, d.alvo!) : v.tipo === "SETOR" ? eq(tabela.unidade_id, d.alvo!) : sql`true`,
        isNull(tabela.cancelado_em),
      ),
    );
  if (existente) {
    // já confirmado: nada a fazer. Ainda não: reenvia a confirmação, no máximo 1 vez por hora
    const ultima = existente.confirmacao_enviada_em?.getTime() ?? 0;
    if (!existente.confirmado_em && agora.getTime() - ultima >= MINUTOS_ENTRE_REENVIOS * 60_000) {
      const token = randomBytes(32).toString("base64url");
      await tx.update(tabela).set({ confirmacao_hash: _hash(token) }).where(eq(tabela.id, existente.id));
      await _mandar_confirmacao(tx, existente.id, existente.nome, existente.email, token);
    }
    return RESPOSTA_PADRAO;
  }
  const token = randomBytes(32).toString("base64url");
  const [linha] = await tx
    .insert(tabela)
    .values({
      nome: v.nome,
      email: v.email,
      email_normalizado: v.normalizado,
      tipo: v.tipo,
      treinamento_id: v.tipo === "TREINAMENTO" ? d.alvo : null,
      unidade_id: v.tipo === "SETOR" ? d.alvo : null,
      campus_id: d.campus_id,
      consentimento_em: agora,
      consentimento_versao: VERSAO_DO_TEXTO,
      ip_consentimento: ip,
      confirmacao_hash: _hash(token),
    })
    .returning();
  await _mandar_confirmacao(tx, linha!.id, v.nome, v.email, token);
  await auditoria.registrar(tx, {
    entidade: "aviso_interesse",
    entidade_id: linha!.id,
    tipo_evento: "AVISO_INTERESSE_CRIADO",
    descricao: `Pedido de aviso da vitrine #${linha!.id} (${v.tipo}) aguardando confirmação`,
    usuario: null,
  });
  return RESPOSTA_PADRAO;
}

// ---------------------------------------------------------------------
// Confirmar e sair
// ---------------------------------------------------------------------
/** `true` se o link confirmou (ou já estava confirmado); `false` se não vale mais. */
export async function confirmar(tx: Executor, token: string, agora: Date = new Date()): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return false;
  const [linha] = await tx.select().from(tabela).where(eq(tabela.confirmacao_hash, _hash(token)));
  if (!linha || linha.cancelado_em) return false;
  const limite = agora.getTime() - DIAS_PARA_CONFIRMAR * 86_400_000;
  if (linha.criado_em.getTime() < limite) return false;
  await tx
    .update(tabela)
    .set({ confirmado_em: agora, confirmacao_hash: null, expira_em: datas_br.somar_meses(datas_br.hoje(agora), MESES_DE_VIDA) })
    .where(eq(tabela.id, linha.id));
  await auditoria.registrar(tx, {
    entidade: "aviso_interesse",
    entidade_id: linha.id,
    tipo_evento: "AVISO_INTERESSE_CONFIRMADO",
    descricao: `Pedido de aviso da vitrine #${linha.id} confirmado`,
    usuario: null,
  });
  return true;
}

/** O cadastro do link de saída existe e ainda está ativo? (a página mostra o botão) */
export async function saida_valida(tx: Executor, token: string): Promise<boolean> {
  const id = id_do_token_de_saida(token);
  if (id === null) return false;
  const [linha] = await tx.select({ id: tabela.id }).from(tabela).where(eq(tabela.id, id));
  return Boolean(linha);
}

/** Cancela. Idempotente: sair duas vezes é sair. `false` só para token que não vale. */
export async function descadastrar(tx: Executor, token: string, agora: Date = new Date()): Promise<boolean> {
  const id = id_do_token_de_saida(token);
  if (id === null) return false;
  const [linha] = await tx.select().from(tabela).where(eq(tabela.id, id));
  if (!linha) return false;
  if (linha.cancelado_em) return true;
  await tx.update(tabela).set({ cancelado_em: agora, confirmacao_hash: null }).where(eq(tabela.id, id));
  await auditoria.registrar(tx, {
    entidade: "aviso_interesse",
    entidade_id: id,
    tipo_evento: "AVISO_INTERESSE_CANCELADO",
    descricao: `Pedido de aviso da vitrine #${id} cancelado pela própria pessoa`,
    usuario: null,
  });
  return true;
}

/**
 * `List-Unsubscribe` + `List-Unsubscribe-Post` (RFC 8058): o "cancelar inscrição"
 * do próprio leitor de e-mail chama o POST do link de saída, sem login. O link
 * está no corpo do aviso (o banco só guarda o corpo; o texto some pelo expurgo
 * de corpos, e então o cabeçalho também deixa de sair, o que é inofensivo: a
 * mensagem já foi enviada há muito).
 */
email.registrar_cabecalhos(TIPO_TURMA, (m) => {
  const achado = /(https?:\/\/\S+\/cursos\/avise-me\/sair\/\d+\.[A-Za-z0-9_-]{32})/.exec(m.corpo ?? "");
  if (!achado) return undefined;
  return { "List-Unsubscribe": `<${achado[1]}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
});

// ---------------------------------------------------------------------
// Avisar da turma
// ---------------------------------------------------------------------
function _periodo(t: TurmaCarregada): string {
  return t.data_inicio === t.data_fim ? datas_br.numerica(t.data_inicio) : `${datas_br.numerica(t.data_inicio)} a ${datas_br.numerica(t.data_fim)}`;
}

/**
 * Enfileira o aviso da turma para quem pediu e já confirmou: por treinamento,
 * por setor ou "qualquer", e pelo campus quando a pessoa informou um. Um aviso
 * por pessoa por turma (`aviso_interesse_envio`); publicar de novo não repete.
 * Desligada a chave, ou turma que não está divulgada com inscrição aberta,
 * não faz nada. Devolve quantos e-mails entraram na fila.
 */
export async function avisar_turma(tx: Executor, turma: TurmaCarregada, agora: Date = new Date()): Promise<number> {
  if (!turma.divulgar_na_vitrine || turma.situacao !== "INSCRICOES_ABERTAS") return 0;
  if (!(await ativo(tx))) return 0;
  const hoje = datas_br.hoje(agora);
  if (turma.inscricao_aberta_ate && turma.inscricao_aberta_ate < hoje) return 0;
  const interesse = or(
    eq(tabela.tipo, "QUALQUER"),
    and(eq(tabela.tipo, "TREINAMENTO"), eq(tabela.treinamento_id, turma.treinamento_id)),
    turma.unidade_promotora_id === null ? sql`false` : and(eq(tabela.tipo, "SETOR"), eq(tabela.unidade_id, turma.unidade_promotora_id)),
  );
  const campus = turma.campus_id === null ? isNull(tabela.campus_id) : or(isNull(tabela.campus_id), eq(tabela.campus_id, turma.campus_id));
  const interessados = await tx
    .select()
    .from(tabela)
    .where(and(isNotNull(tabela.confirmado_em), isNull(tabela.cancelado_em), sql`${tabela.expira_em} >= ${hoje}`, interesse, campus));
  if (!interessados.length) return 0;
  const base = await emissao.url_base_validacao(tx);
  const ficha = url_da_ficha(base, turma.codigo);
  const titulo = turma.titulo_vitrine?.trim() || turma.treinamento.nome;
  let enfileirados = 0;
  for (const p of interessados) {
    // a vaga do envio é reservada ANTES do e-mail: dois cliques não mandam dois avisos
    const reservado = await tx
      .insert(tabela_envio)
      .values({ aviso_id: p.id, turma_id: turma.id })
      .onConflictDoNothing()
      .returning({ aviso_id: tabela_envio.aviso_id });
    if (!reservado.length) continue;
    const saida = `${base}/cursos/avise-me/sair/${token_de_saida(p.id)}`;
    const registro = await email.enfileirar(tx, {
      tipo: TIPO_TURMA,
      destinatario: p.email,
      assunto: `Inscrições abertas: ${titulo}`.slice(0, 200),
      corpo:
        `Olá, ${p.nome}.\n\n` +
        `Você pediu para ser avisado, e abriu turma: ${titulo} (${_periodo(turma)}).\n` +
        (turma.inscricao_aberta_ate ? `Inscrições até ${datas_br.numerica(turma.inscricao_aberta_ate)}.\n` : "") +
        `\nVeja os detalhes e inscreva-se: ${ficha}\n\n` +
        `Você recebeu esta mensagem porque pediu aviso de cursos. Para sair a qualquer momento: ${saida}\n\n` +
        "Sistema SISA — UFVJM\n",
      // aviso de turma cujo prazo passou não sai mais
      expira_em: turma.inscricao_aberta_ate ? new Date(`${datas_br.somar_dias(turma.inscricao_aberta_ate, 1)}T03:00:00Z`) : null,
    });
    await tx.update(tabela_envio).set({ email_id: registro.id }).where(and(eq(tabela_envio.aviso_id, p.id), eq(tabela_envio.turma_id, turma.id)));
    await tx.update(tabela).set({ ultimo_aviso_em: agora }).where(eq(tabela.id, p.id));
    enfileirados += 1;
  }
  return enfileirados;
}

// ---------------------------------------------------------------------
// O que a equipe vê: só contagens
// ---------------------------------------------------------------------
export interface Contagem {
  /** confirmados, não cancelados e não expirados que casam com a turma */
  aguardando: number;
}

/** Quantas pessoas aguardam turma como esta. Nunca devolve nome nem e-mail. */
export async function contar_para_turma(tx: Executor, turma: Pick<TurmaCarregada, "treinamento_id" | "unidade_promotora_id" | "campus_id">, hoje: string = datas_br.hoje()): Promise<Contagem> {
  const interesse = or(
    eq(tabela.tipo, "QUALQUER"),
    and(eq(tabela.tipo, "TREINAMENTO"), eq(tabela.treinamento_id, turma.treinamento_id)),
    turma.unidade_promotora_id === null ? sql`false` : and(eq(tabela.tipo, "SETOR"), eq(tabela.unidade_id, turma.unidade_promotora_id)),
  );
  const campus = turma.campus_id === null ? isNull(tabela.campus_id) : or(isNull(tabela.campus_id), eq(tabela.campus_id, turma.campus_id));
  const [r] = await tx
    .select({ n: count() })
    .from(tabela)
    .where(and(isNotNull(tabela.confirmado_em), isNull(tabela.cancelado_em), sql`${tabela.expira_em} >= ${hoje}`, interesse, campus));
  return { aguardando: r?.n ?? 0 };
}

/** As opções do formulário: os setores com turma divulgada e os campi. Sem dado pessoal. */
export async function opcoes_do_formulario(tx: Executor): Promise<{ campi: { id: number; nome: string }[] }> {
  const campi = await tx.select({ id: tabela_campus.id, nome: tabela_campus.nome }).from(tabela_campus).orderBy(tabela_campus.nome);
  return { campi };
}

// ---------------------------------------------------------------------
// Retenção (rotina noturna)
// ---------------------------------------------------------------------
export interface Expurgos {
  nao_confirmados: number;
  expirados: number;
  cancelados: number;
  ips: number;
}

export async function expurgar(tx: Executor, agora: Date = new Date()): Promise<Expurgos> {
  const dias = (n: number) => new Date(agora.getTime() - n * 86_400_000);
  const hoje = datas_br.hoje(agora);
  const apagados = async (onde: ReturnType<typeof and>) =>
    (await tx.delete(tabela).where(onde).returning({ id: tabela.id })).length;
  const nao_confirmados = await apagados(and(isNull(tabela.confirmado_em), isNull(tabela.cancelado_em), lt(tabela.criado_em, dias(DIAS_PARA_CONFIRMAR))));
  // confirmado que passou do prazo: apagado no dia seguinte ao vencimento
  const expirados = await apagados(and(isNotNull(tabela.confirmado_em), isNull(tabela.cancelado_em), sql`${tabela.expira_em} < ${hoje}`));
  const cancelados = await apagados(and(isNotNull(tabela.cancelado_em), lt(tabela.cancelado_em, dias(DIAS_DO_CANCELADO))));
  const ips = (
    await tx
      .update(tabela)
      .set({ ip_consentimento: null })
      .where(and(isNotNull(tabela.ip_consentimento), lt(tabela.consentimento_em, dias(DIAS_DO_IP))))
      .returning({ id: tabela.id })
  ).length;
  return { nao_confirmados, expirados, cancelados, ips };
}

/**
 * Pedido de acesso do titular (LGPD art. 18, II): a equipe confere a identidade
 * de quem escreveu à CSSO e consulta pelo e-mail. Só contagem por tipo e a
 * situação, sem nome nem lista. A consulta entra na trilha só com a quantidade
 * (o e-mail é o dado pessoal e não vai para a trilha).
 */
export async function consultar_do_titular(
  tx: Executor,
  usuario: UsuarioAtual,
  email_titular: string,
): Promise<{ tipo: string; confirmado: boolean }[]> {
  usuario.exigir("treinamento.gerenciar");
  if (!email.email_valido(email_titular.trim())) throw new CadastroInvalido("email");
  const achados = await do_titular(tx, email_titular);
  await auditoria.registrar(tx, {
    entidade: "aviso_interesse",
    entidade_id: 0,
    tipo_evento: "AVISO_INTERESSE_CONSULTADO",
    descricao: `Pedido de acesso do titular: ${achados.length} cadastro(s) de aviso da vitrine`,
    usuario,
  });
  return achados;
}

/**
 * Pedido de eliminação (LGPD art. 18, VI): apaga TODOS os cadastros do e-mail,
 * inclusive os cancelados que ainda esperam o expurgo. Os envios já feitos
 * saem junto (cascata). Devolve quantos foram apagados.
 */
export async function apagar_do_titular(tx: Executor, usuario: UsuarioAtual, email_titular: string): Promise<number> {
  usuario.exigir("treinamento.gerenciar");
  if (!email.email_valido(email_titular.trim())) throw new CadastroInvalido("email");
  const apagados = await tx
    .delete(tabela)
    .where(eq(tabela.email_normalizado, normalizar_email(email_titular)))
    .returning({ id: tabela.id });
  await auditoria.registrar(tx, {
    entidade: "aviso_interesse",
    entidade_id: 0,
    tipo_evento: "AVISO_INTERESSE_APAGADO",
    descricao: `Pedido do titular: ${apagados.length} cadastro(s) de aviso da vitrine apagado(s)`,
    usuario,
  });
  return apagados.length;
}

/** Os cadastros de um e-mail, para o pedido de acesso do titular (LGPD art. 18). Só contagem por tipo. */
export async function do_titular(tx: Executor, email_titular: string): Promise<{ tipo: string; confirmado: boolean }[]> {
  const linhas = await tx
    .select({ tipo: tabela.tipo, confirmado_em: tabela.confirmado_em })
    .from(tabela)
    .where(and(eq(tabela.email_normalizado, normalizar_email(email_titular)), isNull(tabela.cancelado_em)));
  return linhas.map((l) => ({ tipo: l.tipo, confirmado: l.confirmado_em !== null }));
}

