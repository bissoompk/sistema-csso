/**
 * Login é o e-mail (23/10/2026, DESVIOS.md): a conversão das contas que já
 * existiam, feita uma vez — e de novo a cada publicação, sem efeito quando
 * não há o que converter (idempotente).
 *
 * SÓ no banco com a marca de produção (`instalacao.lerMarca`): o banco de
 * teste e o local, e as contas de teste (`coordenador_csso`, `servidor`…),
 * continuam com o nome de usuário, que a tela de entrada segue aceitando.
 *
 * Cada conta convertida é um evento LOGIN_CONVERTIDO_PARA_EMAIL na trilha,
 * com o login de antes e o de depois. A conta em conflito NÃO é convertida:
 *
 * - e-mail vazio, ou que não é e-mail;
 * - o mesmo e-mail (sem caixa, aparado) em outra conta;
 * - o e-mail já é o login de outra conta.
 *
 * Ela é devolvida em `puladas`, com o motivo, e a ferramenta da publicação
 * (`ferramentas/converter-logins.ts`) escreve no log do deploy. Não vai à
 * trilha: a cada publicação a mesma conta seria pulada de novo, e a trilha
 * ganharia um evento repetido por deploy até alguém corrigir o e-mail.
 *
 * As sessões abertas não caem: a sessão aponta para o `usuario.id`, não para
 * o login.
 */
import { asc, eq } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import { usuario } from "../db/esquema/index.js";
import * as auditoria from "./auditoria.js";
import { LOGIN_CONVERTIDO_PARA_EMAIL } from "./auditoria.js";
import { login_do_email } from "./autenticacao.js";
import { AMBIENTE_PRODUCAO, lerMarca } from "./instalacao.js";

export interface Convertida {
  id: number;
  de: string;
  para: string;
}
export interface Pulada {
  id: number;
  login: string;
  motivo: string;
}
export interface ResultadoConversao {
  /** o banco tem a marca de produção? Sem ela nada é tocado. */
  producao: boolean;
  convertidas: Convertida[];
  puladas: Pulada[];
  /** contas cujo login já era o e-mail */
  ja_certas: number;
}

const PARECE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function converter_logins_para_email(tx: Executor): Promise<ResultadoConversao> {
  const resultado: ResultadoConversao = { producao: false, convertidas: [], puladas: [], ja_certas: 0 };
  const marca = await lerMarca(tx);
  if (!marca || marca.ambiente !== AMBIENTE_PRODUCAO) return resultado;
  resultado.producao = true;

  const contas = await tx.select().from(usuario).orderBy(asc(usuario.id)).for("update");
  // login em uso, sem caixa → id da conta (o índice único é em lower(login))
  const logins = new Map(contas.map((c) => [c.login.toLowerCase(), c.id]));
  // e-mail normalizado → ids (o índice único é em lower(email), sem o trim)
  const emails = new Map<string, number[]>();
  for (const c of contas) {
    const alvo = login_do_email(c.email);
    emails.set(alvo, [...(emails.get(alvo) ?? []), c.id]);
  }

  let pendentes = contas.filter((c) => {
    if (c.login === login_do_email(c.email)) {
      resultado.ja_certas += 1;
      return false;
    }
    return true;
  });
  const puladas = new Map<number, Pulada>();
  // Em voltas: a conta A cujo e-mail é o login antigo de B só converte depois
  // que B converteu e largou aquele login. Para quando uma volta não converte nada.
  for (let progresso = true; progresso && pendentes.length; ) {
    progresso = false;
    const restam: typeof pendentes = [];
    for (const c of pendentes) {
      const alvo = login_do_email(c.email);
      let motivo: string | null = null;
      if (!alvo) motivo = "e-mail vazio";
      else if (!PARECE_EMAIL.test(alvo)) motivo = `o e-mail '${c.email}' não é um e-mail`;
      else if ((emails.get(alvo) ?? []).length > 1) motivo = `o e-mail '${alvo}' está em mais de uma conta`;
      else if ((logins.get(alvo) ?? c.id) !== c.id) motivo = `o e-mail '${alvo}' já é o login de outra conta (id ${logins.get(alvo)})`;
      if (motivo) {
        puladas.set(c.id, { id: c.id, login: c.login, motivo });
        restam.push(c);
        continue;
      }
      puladas.delete(c.id);
      await tx.update(usuario).set({ login: alvo }).where(eq(usuario.id, c.id));
      logins.delete(c.login.toLowerCase());
      logins.set(alvo, c.id);
      await auditoria.registrar(tx, {
        entidade: "usuario",
        entidade_id: c.id,
        tipo_evento: LOGIN_CONVERTIDO_PARA_EMAIL,
        descricao:
          `Login da conta '${c.login}' convertido para o e-mail cadastrado ('${alvo}') na publicação: ` +
          "o login passou a ser o e-mail.",
        campo: "login",
        valor_anterior: c.login,
        valor_novo: alvo,
        usuario_nome: "sistema (publicação)",
      });
      resultado.convertidas.push({ id: c.id, de: c.login, para: alvo });
      progresso = true;
    }
    pendentes = restam;
  }
  resultado.puladas = [...puladas.values()];
  return resultado;
}
