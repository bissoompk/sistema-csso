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
 */
import { and, count, eq, gt, inArray, sql } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import { email_saida, participante_email as tabela_email } from "../db/esquema/index.js";
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

export type Chave = "EMAIL" | "SIAPE";

const ASSINATURA = "Superintendência Integrada de Saúde (Sisa) — UFVJM\nMensagem enviada pelo Sistema SISA.\n";

export const ASSUNTO = "Pedido de vaga em treinamento — Sistema SISA · UFVJM";

export function corpo(ja_na_turma: boolean): string {
  return (
    "Olá.\n\n" +
    (ja_na_turma
      ? "Recebemos pelo link público um novo pedido de vaga em treinamento com dados ligados a este e-mail. " +
        "Já existe um pedido ou uma vaga em seu nome nessa turma: não é preciso pedir de novo. " +
        "A equipe responsável confere os pedidos e avisa por aqui.\n\n"
      : "Recebemos pelo link público um pedido de vaga em treinamento com dados ligados a este e-mail. " +
        "Você já tem cadastro conosco e não precisa criar outro: a equipe responsável vai conferir o pedido " +
        "e avisar por aqui.\n\n") +
    "Não foi você? Ignore esta mensagem: nada é confirmado sem a conferência da equipe. " +
    "Se receber avisos repetidos, responda a este e-mail.\n\n" +
    ASSINATURA
  );
}

/**
 * Para onde o aviso iria: o endereço do cadastro (o digitado só quando é um
 * dos do cadastro), e `null` quando não há canal seguro.
 */
async function _destino(tx: Executor, pessoa: ParticipanteCarregado, chave: Chave, digitado: string): Promise<string | null> {
  let endereco: string;
  if (chave === "EMAIL") {
    const alvo = normalizar_email(digitado);
    const do_cadastro = pessoa.emails.find((m) => m.email_normalizado === alvo);
    if (!do_cadastro) return null;
    endereco = do_cadastro.email;
  } else {
    endereco = Participante.email_exibicao(pessoa);
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
  return endereco;
}

/**
 * Enfileira o aviso, se cabe (ver o cabeçalho). Devolve se enfileirou — a rota
 * NÃO usa a resposta: o visitante recebe a mesma tela de qualquer jeito.
 */
export async function avisar(
  tx: Executor,
  pessoa: ParticipanteCarregado,
  d: { chave: Chave; digitado: string; ja_na_turma: boolean },
  agora: Date = new Date(),
): Promise<boolean> {
  const para = await _destino(tx, pessoa, d.chave, d.digitado);
  if (!para) return false;
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
  await email.enfileirar(tx, {
    tipo: d.ja_na_turma ? TIPO_REPETIDO : TIPO_AVISO,
    destinatario: para,
    assunto: ASSUNTO,
    corpo: corpo(d.ja_na_turma),
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
