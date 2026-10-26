/**
 * O aviso de "você já tem cadastro" do link público (23/10/2026), no modelo
 * "esqueci a senha": a tela responde a MESMA frase a todo mundo
 * (`inscricao_publica.RESPOSTA_PADRAO`), e quem fica sabendo que o cadastro
 * existe é só o dono da caixa de e-mail que JÁ está no cadastro — nunca o
 * endereço digitado no pedido, que pode ser de qualquer um.
 *
 * Quando sai:
 *
 * - o pedido casou com o cadastro pelo **e-mail + nome** (o e-mail digitado é
 *   um dos do cadastro): vai a esse endereço, até `LIMITE_EMAIL_24H` vezes por
 *   dia;
 * - casou pelo **SIAPE + nome**: vai ao e-mail do cadastro (o institucional),
 *   no máximo `LIMITE_SIAPE_24H` vez por dia — SIAPE e nome são públicos
 *   (Portal da Transparência), e sem o teto qualquer um faria a CSSO mandar
 *   e-mail a qualquer servidor;
 * - a pessoa já tinha pedido ou vaga na turma: o aviso diz que não precisa
 *   pedir de novo.
 *
 * Não sai quando o casamento é só pelo nome, quando o cadastro não tem e-mail,
 * nem quando o e-mail do cadastro está em mais de um cadastro sem confirmação
 * (a caixa não diz qual das pessoas a abre). Nesses casos quem vê é a equipe,
 * na conferência ("parece com PTC-…").
 *
 * O e-mail não leva nome, SIAPE, IP, nada do que foi digitado, nem a turma
 * (caixa compartilhada). Sai pela fila de sempre (`email.enfileirar`, como
 * `acesso_participante.ts`) e vence em 24 h: com o envio desligado, não chega
 * dias depois.
 *
 * Etapa 2 (26/10/2026): o e-mail leva dois botões, "Sim, fui eu" e "Não fui
 * eu", num link com token (`aviso_cadastro`, 7 dias). Abrir o link não faz
 * nada — leitor de e-mail pré-visualiza links —; o botão grava a resposta, e
 * ela só serve de selo para a equipe na conferência. O "sou eu" liga NADA
 * ao cadastro: não aceita a vaga e não acrescenta o e-mail digitado (seria
 * tomada de conta: quem digitasse o nome e o SIAPE de outro, com um e-mail
 * seu, o levaria para o cadastro da vítima). Faz uma coisa só: confirma o
 * e-mail do cadastro que recebeu o aviso, o mesmo que o link de acesso aos
 * certificados já confirma.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, count, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  aviso_cadastro as tabela_aviso,
  email_saida,
  inscricao as tabela_inscricao,
  participante as tabela_participante,
  participante_email as tabela_email,
  treinamento as tabela_treinamento,
  turma as tabela_turma,
} from "../db/esquema/index.js";
import { Participante, normalizar_email } from "../dominio/treinamento.js";
import * as auditoria from "./auditoria.js";
import * as email from "./email.js";
import type { ParticipanteCarregado } from "./participante.js";

export const TIPO_AVISO = "AVISO_CADASTRO_EXISTENTE";
export const TIPO_REPETIDO = "AVISO_PEDIDO_REPETIDO";
export const TIPOS: readonly string[] = [TIPO_AVISO, TIPO_REPETIDO];
export const VALIDADE_MS = 24 * 3_600_000;
export const JANELA_MS = 24 * 3_600_000;
export const LIMITE_SIAPE_24H = 1;
export const LIMITE_EMAIL_24H = 3;
/** A página dos botões "sou eu" / "não fui eu" (sem sessão, como /certificados/acesso). */
export const CAMINHO = "/aviso-cadastro";
export const VALIDADE_RESPOSTA_MS = 7 * 24 * 3_600_000;
export type Resposta = "SOU_EU" | "NAO_FUI_EU";

export type Chave = "EMAIL" | "SIAPE";

const ASSINATURA = "Superintendência Integrada de Saúde (Sisa) — UFVJM\nMensagem enviada pelo Sistema SISA.\n";

export const ASSUNTO = "Pedido de vaga em treinamento — Sistema SISA · UFVJM";

export function corpo(ja_na_turma: boolean, treinamento: string | null = null, link: string | null = null): string {
  const quanto = treinamento ? ` em ${treinamento}` : " em treinamento";
  return (
    "Olá.\n\n" +
    (ja_na_turma
      ? `Recebemos pelo link público um novo pedido de vaga${quanto} com dados ligados a este e-mail. ` +
        "Já existe um pedido ou uma vaga em seu nome nessa turma: não é preciso pedir de novo. " +
        "A equipe responsável confere os pedidos e avisa por aqui.\n\n"
      : `Recebemos pelo link público um pedido de vaga${quanto} com dados ligados a este e-mail. ` +
        "Você já tem cadastro conosco e não precisa criar outro: a equipe responsável vai conferir o pedido " +
        "e avisar por aqui.\n\n") +
    (link
      ? `Foi você? Diga à equipe, em um clique (vale por 7 dias):\n${link}\n\n` +
        "Não foi você? Use o mesmo link para avisar, ou ignore esta mensagem: " +
        "nada é confirmado sem a conferência da equipe. "
      : "Não foi você? Ignore esta mensagem: nada é confirmado sem a conferência da equipe. ") +
    "Se receber avisos repetidos, responda a este e-mail.\n\n" +
    ASSINATURA
  );
}

/**
 * Para onde o aviso iria: o endereço do cadastro (o digitado só quando é um
 * dos do cadastro), e `null` quando não há canal seguro.
 */
async function _destino(
  tx: Executor,
  pessoa: ParticipanteCarregado,
  chave: Chave,
  digitado: string,
): Promise<{ endereco: string; email_id: number | null } | null> {
  let endereco: string;
  let email_id: number | null = null;
  if (chave === "EMAIL") {
    const alvo = normalizar_email(digitado);
    const do_cadastro = pessoa.emails.find((m) => m.email_normalizado === alvo);
    if (!do_cadastro) return null;
    endereco = do_cadastro.email;
    email_id = do_cadastro.id;
  } else {
    endereco = Participante.email_exibicao(pessoa);
    email_id = pessoa.emails.find((m) => m.email_normalizado === normalizar_email(endereco))?.id ?? null;
  }
  if (!email.email_valido(endereco)) return null;
  // o endereço de mais de um cadastro, sem confirmação, não diz quem abre a caixa
  const donos = await tx
    .select({ participante_id: tabela_email.participante_id, confirmado_em: tabela_email.confirmado_em })
    .from(tabela_email)
    .where(eq(tabela_email.email_normalizado, normalizar_email(endereco)));
  const confirmado = donos.find((d) => d.confirmado_em !== null);
  if (confirmado && confirmado.participante_id !== pessoa.id) return null;
  if (!confirmado && new Set(donos.map((d) => d.participante_id)).size > 1) return null;
  return { endereco, email_id };
}

/** O hash que fica no banco; o token só existe no e-mail. */
function _hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** O nome do treinamento do pedido: é tudo o que o e-mail diz da turma. */
async function _treinamento_do_pedido(tx: Executor, inscricao_id: number): Promise<string | null> {
  const [l] = await tx
    .select({ nome: tabela_treinamento.nome })
    .from(tabela_inscricao)
    .innerJoin(tabela_turma, eq(tabela_turma.id, tabela_inscricao.turma_id))
    .innerJoin(tabela_treinamento, eq(tabela_treinamento.id, tabela_turma.treinamento_id))
    .where(eq(tabela_inscricao.id, inscricao_id));
  return l?.nome ?? null;
}

/**
 * Enfileira o aviso, se cabe (ver o cabeçalho). Devolve se enfileirou — a rota
 * NÃO usa a resposta: o visitante recebe a mesma tela de qualquer jeito.
 * `base_url` liga os botões "sou eu" / "não fui eu"; sem ela o aviso sai só
 * informativo.
 */
export async function avisar(
  tx: Executor,
  pessoa: ParticipanteCarregado,
  d: { chave: Chave; digitado: string; ja_na_turma: boolean; inscricao_id: number; base_url?: string | null },
  agora: Date = new Date(),
): Promise<boolean> {
  const destino = await _destino(tx, pessoa, d.chave, d.digitado);
  if (!destino) return false;
  const para = destino.endereco;
  const [recentes] = await tx
    .select({ n: count() })
    .from(email_saida)
    .where(
      and(
        inArray(email_saida.tipo, [...TIPOS]),
        sql`lower(${email_saida.destinatario}) = ${para.trim().toLowerCase()}`,
        gt(email_saida.criado_em, new Date(agora.getTime() - JANELA_MS)),
      ),
    );
  const teto = d.chave === "SIAPE" ? LIMITE_SIAPE_24H : LIMITE_EMAIL_24H;
  if (Number(recentes?.n ?? 0) >= teto) return false;
  let link: string | null = null;
  if (d.base_url) {
    const token = randomBytes(24).toString("base64url");
    await tx.insert(tabela_aviso).values({
      participante_id: pessoa.id,
      inscricao_id: d.inscricao_id,
      email_id: destino.email_id,
      token_hash: _hash(token),
      expira_em: new Date(agora.getTime() + VALIDADE_RESPOSTA_MS),
    });
    link = `${d.base_url}${CAMINHO}/${token}`;
  }
  await email.enfileirar(tx, {
    tipo: d.ja_na_turma ? TIPO_REPETIDO : TIPO_AVISO,
    destinatario: para,
    assunto: ASSUNTO,
    corpo: corpo(d.ja_na_turma, await _treinamento_do_pedido(tx, d.inscricao_id), link),
    expira_em: new Date(agora.getTime() + VALIDADE_MS),
  });
  await auditoria.registrar(tx, {
    entidade: "participante",
    entidade_id: pessoa.id,
    tipo_evento: TIPO_AVISO,
    // RN-19 na escrita: o identificador e a chave, nunca o endereço
    descricao:
      `${pessoa.identificador_publico}: aviso de pedido pelo link enfileirado para o e-mail do cadastro ` +
      `(casou por ${d.chave === "SIAPE" ? "SIAPE" : "e-mail"} e nome${d.ja_na_turma ? "; já estava na turma" : ""})`,
    usuario: null,
  });
  return true;
}

// ---------------------------------------------------------------------
// Etapa 2: "sou eu" / "não fui eu"
// ---------------------------------------------------------------------
export interface AvisoAberto {
  id: number;
  /** o treinamento do pedido: o que a página diz da turma */
  treinamento: string;
  resposta: Resposta | null;
  expira_em: Date;
}

/** O aviso de um token, ou `null` para token desconhecido ou vencido. */
export async function abrir(tx: Executor, token: string, agora: Date = new Date()): Promise<AvisoAberto | null> {
  if (!token || token.length > 64) return null;
  const [linha] = await tx.select().from(tabela_aviso).where(eq(tabela_aviso.token_hash, _hash(token)));
  if (!linha || linha.expira_em <= agora) return null;
  return {
    id: linha.id,
    treinamento: (await _treinamento_do_pedido(tx, linha.inscricao_id)) ?? "treinamento",
    resposta: (linha.resposta as Resposta | null) ?? null,
    expira_em: linha.expira_em,
  };
}

/**
 * O e-mail que recebeu o aviso passa a CONFIRMADO no cadastro — só ele, e só
 * quando nenhum outro cadastro o tem (a caixa não diz de qual das pessoas ela
 * é; `uq_email_confirmado` também não deixaria).
 */
async function _confirmar_o_email(tx: Executor, participante_id: number, email_id: number | null, agora: Date): Promise<void> {
  if (email_id === null) return;
  const [alvo] = await tx.select().from(tabela_email).where(eq(tabela_email.id, email_id));
  if (!alvo || alvo.participante_id !== participante_id || alvo.confirmado_em !== null) return;
  const donos = await tx
    .select({ participante_id: tabela_email.participante_id })
    .from(tabela_email)
    .where(eq(tabela_email.email_normalizado, alvo.email_normalizado));
  if (new Set(donos.map((x) => x.participante_id)).size > 1) return;
  await tx.update(tabela_email).set({ confirmado_em: agora }).where(and(eq(tabela_email.id, email_id), isNull(tabela_email.confirmado_em)));
  await auditoria.registrar(tx, {
    entidade: "participante",
    entidade_id: participante_id,
    tipo_evento: "EMAIL_CONFIRMADO_PELO_LINK",
    descricao: `${await _identificador(tx, participante_id)}: e-mail confirmado pelo botão «sou eu» do aviso de pedido`,
    usuario: null,
  });
}

async function _identificador(tx: Executor, participante_id: number): Promise<string> {
  const [p] = await tx
    .select({ identificador: tabela_participante.identificador_publico })
    .from(tabela_participante)
    .where(eq(tabela_participante.id, participante_id));
  return p?.identificador ?? `participante #${participante_id}`;
}

/**
 * Grava a resposta do titular, uma vez só: a primeira vale, e o clique repetido
 * (ou o outro botão, depois) devolve o que ficou. `null`: token desconhecido ou
 * vencido. Nada além do selo e do e-mail confirmado muda — ver o cabeçalho.
 */
export async function responder(
  tx: Executor,
  token: string,
  resposta: Resposta,
  agora: Date = new Date(),
): Promise<Resposta | null> {
  if (!token || token.length > 64) return null;
  const [linha] = await tx.select().from(tabela_aviso).where(eq(tabela_aviso.token_hash, _hash(token)));
  if (!linha || linha.expira_em <= agora) return null;
  if (linha.resposta !== null) return linha.resposta as Resposta;
  // a condição na escrita: dois cliques ao mesmo tempo não gravam duas respostas
  const gravada = await tx
    .update(tabela_aviso)
    .set({ resposta, respondida_em: agora })
    .where(and(eq(tabela_aviso.id, linha.id), isNull(tabela_aviso.resposta)))
    .returning({ id: tabela_aviso.id });
  if (!gravada.length) {
    const [atual] = await tx.select({ r: tabela_aviso.resposta }).from(tabela_aviso).where(eq(tabela_aviso.id, linha.id));
    return (atual?.r as Resposta | null) ?? resposta;
  }
  if (resposta === "SOU_EU") await _confirmar_o_email(tx, linha.participante_id, linha.email_id, agora);
  await auditoria.registrar(tx, {
    entidade: "participante",
    entidade_id: linha.participante_id,
    tipo_evento: "AVISO_CADASTRO_RESPONDIDO",
    descricao:
      `${await _identificador(tx, linha.participante_id)}: o titular respondeu ao aviso de pedido pelo link: ` +
      (resposta === "SOU_EU" ? "«sou eu»" : "«não fui eu»"),
    usuario: null,
  });
  return resposta;
}

/**
 * O selo da conferência, por pedido: o titular negou («não fui eu» pesa mais),
 * confirmou, ou não disse nada (ausente do mapa). É uma pista para a equipe,
 * nunca uma decisão: nada se aceita nem se recusa por ele.
 */
export async function selos(tx: Executor, inscricao_ids: number[]): Promise<Map<number, Resposta>> {
  const saida = new Map<number, Resposta>();
  if (!inscricao_ids.length) return saida;
  const linhas = await tx
    .select({ inscricao_id: tabela_aviso.inscricao_id, resposta: tabela_aviso.resposta })
    .from(tabela_aviso)
    .where(and(inArray(tabela_aviso.inscricao_id, inscricao_ids), sql`${tabela_aviso.resposta} IS NOT NULL`))
    .orderBy(desc(tabela_aviso.respondida_em));
  for (const l of linhas) {
    const r = l.resposta as Resposta;
    if (r === "NAO_FUI_EU" || !saida.has(l.inscricao_id)) saida.set(l.inscricao_id, r);
  }
  return saida;
}
