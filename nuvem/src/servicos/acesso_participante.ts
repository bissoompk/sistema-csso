/**
 * O participante SEM conta (terceirizado, discente, visitante — e o servidor
 * que não quer entrar) baixa os próprios certificados: digita o e-mail em
 * `/certificados/acesso`, recebe um link que vale por 2 horas, e o link lista
 * e baixa os certificados EMITIDOS de quem tem aquele e-mail cadastrado.
 *
 * Quem prova ser o dono é a caixa de e-mail: o link só vai ao endereço que já
 * está no cadastro (pela CSSO, pela inscrição ou pelo SIAPE), nunca a um
 * endereço novo. Por isso o envio de e-mail tem de estar ligado
 * (`email.ts`); sem ele, a página diz que o acesso está indisponível.
 *
 * **Sem oráculo.** A resposta ao pedido é sempre a mesma frase: de fora não
 * se sabe se o e-mail está cadastrado nem se há certificado. O e-mail só sai
 * quando há o que mostrar.
 *
 * **Sem canhão de spam.** O link só sai para endereço cadastrado, até
 * `LINKS_POR_HORA` vezes por endereço, e o pedido conta no limite por IP.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, asc, count, eq, gt, lt } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  acesso_participante as tabela,
  agora_utc,
  certificado as tabela_certificado,
  participante_email as tabela_email,
} from "../db/esquema/index.js";
import { Certificado as C, normalizar_email } from "../dominio/treinamento.js";
import * as datas_br from "./datas_br.js";
import * as email from "./email.js";
import * as servico from "./emissao_certificado.js";

export const CAMINHO = "/certificados/acesso";
export const VALIDADE_MS = 2 * 3_600_000;
export const LINKS_POR_HORA = 3;
export const DIAS_DO_REGISTRO = 7;
export const TIPO_EMAIL = "ACESSO_CERTIFICADOS";

export const RESPOSTA_PADRAO =
  "Se este e-mail estiver cadastrado em algum certificado emitido pela CSSO, " +
  "enviamos para ele um link de acesso, válido por 2 horas. Confira também a caixa de spam.";

type CertificadoRegistro = typeof tabela_certificado.$inferSelect;

export class EmailInvalido extends Error {}

function _hash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Os certificados em vigor de quem tem este e-mail (em qualquer participante). */
async function _certificados(tx: Executor, email_normalizado: string): Promise<CertificadoRegistro[]> {
  const linhas = await tx
    .selectDistinct({ c: tabela_certificado })
    .from(tabela_certificado)
    .innerJoin(tabela_email, eq(tabela_email.participante_id, tabela_certificado.participante_id))
    .where(and(eq(tabela_email.email_normalizado, email_normalizado), eq(tabela_certificado.situacao, "EMITIDO")))
    .orderBy(asc(tabela_certificado.ano), asc(tabela_certificado.numero));
  return linhas.map((l) => l.c);
}

/**
 * O pedido do link. Não devolve nada de propósito: a rota responde sempre
 * `RESPOSTA_PADRAO`. Lança `EmailInvalido` só para o que nem parece e-mail.
 */
export async function pedir_link(
  tx: Executor,
  digitado: string,
  ip: string | null,
  base_url: string,
  agora: Date = new Date(),
): Promise<void> {
  if (!email.email_valido(digitado)) throw new EmailInvalido("Digite o e-mail completo.");
  const normalizado = normalizar_email(digitado);
  const [recentes] = await tx
    .select({ n: count() })
    .from(tabela)
    .where(and(eq(tabela.email_normalizado, normalizado), gt(tabela.criado_em, new Date(agora.getTime() - 3_600_000))));
  if (Number(recentes?.n ?? 0) >= LINKS_POR_HORA) return;
  const certificados = await _certificados(tx, normalizado);
  if (!certificados.length) return;
  // o endereço como está no cadastro (a caixa que recebe é a mesma)
  const [cadastrado] = await tx
    .select({ email: tabela_email.email })
    .from(tabela_email)
    .where(eq(tabela_email.email_normalizado, normalizado))
    .limit(1);
  const token = randomBytes(24).toString("base64url");
  const expira_em = new Date(agora.getTime() + VALIDADE_MS);
  await tx.insert(tabela).values({ token_hash: _hash(token), email_normalizado: normalizado, expira_em, ip });
  const link = `${base_url}${CAMINHO}/${token}`;
  await email.enfileirar(tx, {
    tipo: TIPO_EMAIL,
    destinatario: cadastrado?.email ?? digitado,
    assunto: "Seus certificados — CSSO UFVJM",
    corpo:
      "Olá.\n\n" +
      "Alguém (provavelmente você) pediu acesso aos certificados de treinamento ligados a este e-mail. " +
      `Use o link abaixo até ${datas_br.numerica(datas_br.hoje(expira_em))}, às ` +
      `${expira_em.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" })}:\n\n` +
      `${link}\n\n` +
      `Há ${certificados.length} certificado(s). Se não foi você, ignore esta mensagem: sem o link, ninguém os vê.\n\n` +
      "Coordenação de Saúde e Segurança Ocupacional (CSSO) — UFVJM\n" +
      "Mensagem enviada pelo Sistema CSSO.\n",
  });
}

export interface ItemDoTitular {
  id: number;
  rotulo: string;
  treinamento: string;
  turma: string;
  inicio: string;
  fim: string;
  emissao: string;
  vencimento: string | null;
  so_word: boolean;
}

/** O que o link abre, ou `null` para token desconhecido ou vencido. */
export async function abrir(
  tx: Executor,
  token: string,
  agora: Date = new Date(),
): Promise<{ email_normalizado: string; certificados: CertificadoRegistro[] } | null> {
  if (!token || token.length > 64) return null;
  const [linha] = await tx.select().from(tabela).where(eq(tabela.token_hash, _hash(token)));
  if (!linha || linha.expira_em <= agora) return null;
  if (linha.usado_em === null) await tx.update(tabela).set({ usado_em: agora_utc() }).where(eq(tabela.id, linha.id));
  return { email_normalizado: linha.email_normalizado, certificados: await _certificados(tx, linha.email_normalizado) };
}

export function itens(certificados: CertificadoRegistro[]): ItemDoTitular[] {
  return certificados.map((c) => {
    const x = servico.montar_contexto(null, c);
    return {
      id: c.id,
      rotulo: C.rotulo(c),
      treinamento: x.treinamento_nome,
      turma: x.turma_codigo,
      inicio: x.turma_data_inicio,
      fim: x.turma_data_fim,
      emissao: x.data_emissao,
      vencimento: x.data_vencimento || null,
      so_word: servico.do_modelo_enviado(c),
    };
  });
}

/** Apaga o registro dos links (e-mail e IP) passado o prazo. */
export async function expurgar(tx: Executor, agora: Date = new Date(), dias = DIAS_DO_REGISTRO): Promise<number> {
  const r = await tx
    .delete(tabela)
    .where(lt(tabela.criado_em, new Date(agora.getTime() - dias * 86_400_000)))
    .returning({ id: tabela.id });
  return r.length;
}

// ---------------------------------------------------------------------
// Limite por IP — o desenho de /validar (memória da instância)
// ---------------------------------------------------------------------
export const JANELA_S = 600;
export const LIMITE_POR_JANELA = 5;
const _tentativas = new Map<string, number[]>();
export const relogio = { agora: (): number => performance.now() / 1000 };

export function limpar_limites(): void {
  _tentativas.clear();
}

export function dentro_do_limite(ip: string | null | undefined): boolean {
  const chave = ip || "desconhecido";
  const agora = relogio.agora();
  const fila = (_tentativas.get(chave) ?? []).filter((t) => agora - t <= JANELA_S);
  fila.push(agora);
  _tentativas.set(chave, fila);
  return fila.length <= LIMITE_POR_JANELA;
}
