/**
 * A comunicação de acidente por LINK, sem conta (fatia F2; D1b, 23/10/2026).
 *
 * Terceirizado, estudante e visitante não têm conta, e o servidor muitas vezes
 * também não. O link é o cartaz do setor: a equipe gera, divulga internamente
 * (intranet, e-mail institucional, cartaz) e troca quando vazar. Nunca URL
 * aberta (D1c).
 *
 * - **Token.** 24 bytes sorteados, mostrados UMA vez; o banco guarda só o
 *   SHA-256. Gerar de novo para o mesmo recorte (geral ou um campus) desliga o
 *   anterior. Token desconhecido e link desligado são o mesmo "link inválido".
 * - **Anti-abuso, nesta ordem.** O limite por IP vem ANTES de olhar o token
 *   (senão vira oráculo do token); o campo-isca (`site`) barra robô com a mesma
 *   resposta do envio real, sem gravar nada além de um evento sem conteúdo; o
 *   teto de comunicações por link ainda não triadas segura a enxurrada de um
 *   link vazado.
 * - **Sem oráculo de cadastro.** O formulário não consulta o cadastro de
 *   servidores: o SIAPE digitado é guardado como veio (`acidente_comunicacao`).
 * - **Nada volta ao público por e-mail** (D6). A tela mostra o protocolo a
 *   quem acabou de comunicar, e só a ele (cookie do próprio caminho).
 * - **Minimização.** Sem anexo, sem saúde declarada e sem CPF; o IP de quem
 *   comunicou é apagado em 90 dias pela rotina de privacidade.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, count, eq, isNull } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import { acidente_link_publico, acidente_ocorrencia, campus as tabela_campus } from "../db/esquema/index.js";
import { RegraViolada } from "../nucleo/erros.js";
import * as auditoria from "./auditoria.js";
import * as comunicacao from "./acidente_comunicacao.js";
import { dentro_do_limite as limite_generico } from "./inscricao_publica.js";
import type { UsuarioAtual } from "./rbac.js";

export const CAMINHO = "/acidente";
export const PREFIXO_CHAVE_IP = "acidente:";
/** Envios por IP numa janela de 10 minutos (a do limite genérico). */
export const LIMITE_POR_JANELA = 5;
/** Comunicações por link ainda na fila de triagem: acima disto, o link para de receber. Trocável no teste. */
export const ajuste = { teto_em_espera: 30 };

export type Link = typeof acidente_link_publico.$inferSelect;

/** O link existe, mas a fila dele está cheia: a resposta diz a saída. */
export class TetoAtingido extends RegraViolada {}

function _hash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// ---------------------------------------------------------------------
// A equipe: gerar, trocar, desligar
// ---------------------------------------------------------------------
/** Gera o link (geral, ou de um campus) e devolve o TOKEN — a única vez em que ele existe. */
export async function gerar_link(tx: Executor, usuario: UsuarioAtual, campus_id: number | null): Promise<string> {
  usuario.exigir("acidente.triar");
  if (campus_id !== null) {
    const [c] = await tx.select({ id: tabela_campus.id }).from(tabela_campus).where(eq(tabela_campus.id, campus_id));
    if (!c) throw new RegraViolada("Escolha o campus na lista, ou deixe o link geral.");
  }
  const anteriores = await tx
    .select()
    .from(acidente_link_publico)
    .where(
      and(
        eq(acidente_link_publico.ativo, true),
        campus_id === null ? isNull(acidente_link_publico.campus_id) : eq(acidente_link_publico.campus_id, campus_id),
      ),
    );
  for (const a of anteriores) await _desligar(tx, usuario, a, "trocado por um link novo");
  const token = randomBytes(24).toString("base64url");
  const [link] = await tx
    .insert(acidente_link_publico)
    .values({ campus_id, token_sha256: _hash(token), gerado_por: usuario.id })
    .returning();
  await auditoria.registrar(tx, {
    entidade: "acidente_link_publico",
    entidade_id: link!.id,
    tipo_evento: auditoria.ACIDENTE_LINK_GERADO,
    descricao: `Link de comunicação de acidente ${campus_id === null ? "geral" : "de campus"} gerado` +
      (anteriores.length ? " (o anterior parou de funcionar)." : "."),
    usuario,
  });
  return token;
}

async function _desligar(tx: Executor, usuario: UsuarioAtual, link: Link, motivo: string): Promise<void> {
  await tx
    .update(acidente_link_publico)
    .set({ ativo: false, desligado_em: new Date() })
    .where(eq(acidente_link_publico.id, link.id));
  await auditoria.registrar(tx, {
    entidade: "acidente_link_publico",
    entidade_id: link.id,
    tipo_evento: auditoria.ACIDENTE_LINK_DESLIGADO,
    descricao: `Link de comunicação de acidente desligado: ${motivo}.`,
    usuario,
  });
}

export async function desligar_link(tx: Executor, usuario: UsuarioAtual, id: number): Promise<void> {
  usuario.exigir("acidente.triar");
  const [link] = await tx.select().from(acidente_link_publico).where(eq(acidente_link_publico.id, id));
  if (!link || !link.ativo) return;
  await _desligar(tx, usuario, link, "pela equipe");
}

export async function links_ativos(tx: Executor) {
  return tx
    .select({
      id: acidente_link_publico.id,
      campus_id: acidente_link_publico.campus_id,
      gerado_em: acidente_link_publico.gerado_em,
      campus_sigla: tabela_campus.sigla,
    })
    .from(acidente_link_publico)
    .leftJoin(tabela_campus, eq(tabela_campus.id, acidente_link_publico.campus_id))
    .where(eq(acidente_link_publico.ativo, true))
    .orderBy(acidente_link_publico.id);
}

// ---------------------------------------------------------------------
// O público
// ---------------------------------------------------------------------
/** O link ATIVO de um token, ou `null`: desconhecido e desligado são o mesmo nada. */
export async function link_do_token(tx: Executor, token: string): Promise<Link | null> {
  if (!token || token.length > 64) return null;
  const [link] = await tx
    .select()
    .from(acidente_link_publico)
    .where(and(eq(acidente_link_publico.token_sha256, _hash(token)), eq(acidente_link_publico.ativo, true)));
  return link ?? null;
}

/** Conta o envio no limite por IP (o contador é próprio deste formulário). */
export function dentro_do_limite(tx: Executor, ip: string | null | undefined, agora: Date = new Date()): Promise<boolean> {
  return limite_generico(tx, ip, agora, PREFIXO_CHAVE_IP, LIMITE_POR_JANELA);
}

export async function em_espera(tx: Executor): Promise<number> {
  const [r] = await tx
    .select({ n: count() })
    .from(acidente_ocorrencia)
    .where(and(eq(acidente_ocorrencia.origem, "PUBLICO"), eq(acidente_ocorrencia.estado, "RECEBIDA")));
  return Number(r?.n ?? 0);
}

/**
 * Grava a comunicação que chegou pelo link. O campus do link (se houver)
 * prevalece sobre o escolhido no formulário: o cartaz do Mucuri comunica para
 * a equipe do Mucuri.
 */
export async function comunicar(
  tx: Executor,
  link: Link,
  dados: comunicacao.DadosComunicacao,
  ip: string | null,
): Promise<comunicacao.Ocorrencia> {
  if ((await em_espera(tx)) >= ajuste.teto_em_espera) {
    throw new TetoAtingido(
      "O formulário recebeu muitas comunicações que a equipe ainda não triou e parou de aceitar por enquanto. " +
        "Comunique o acidente diretamente à equipe de segurança do trabalho ou à sua chefia.",
    );
  }
  const fatos = { ...dados.fatos, campus_id: link.campus_id ?? dados.fatos.campus_id };
  // sem conta não há "sou eu": cada envolvido entra pelo nome
  const envolvidos = dados.envolvidos.map((e) => ({ ...e, sou_eu: false }));
  return comunicacao.comunicar(tx, null, { ...dados, fatos, envolvidos, sou_chefia: false }, { ip });
}

/** O robô que preencheu o campo-isca: um evento sem conteúdo, e nada mais. */
export async function registrar_isca(tx: Executor, link: Link): Promise<void> {
  await auditoria.registrar(tx, {
    entidade: "acidente_link_publico",
    entidade_id: link.id,
    tipo_evento: auditoria.ACIDENTE_PUBLICO_HONEYPOT,
    descricao: "Envio pelo link barrado pelo campo-isca; nada foi gravado.",
    usuario: null,
    usuario_nome: "formulário por link",
  });
}
