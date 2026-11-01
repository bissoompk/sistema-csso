/**
 * A marca de produção e o que depende dela. Não existe no Python: lá produção
 * e teste eram pastas diferentes (`dados/` e `dados-teste/`) e a trava era de
 * disco. Na nuvem a mesma `DATABASE_URL` pode apontar para o banco de teste
 * ou para o de produção — e as ferramentas que APAGAM o banco
 * (`ambiente-teste`, `producao-iniciar`) precisam de uma resposta que não
 * dependa de ninguém lembrar qual é qual. A resposta mora no próprio banco
 * (tabela `instalacao`, gravada uma vez por `producao-iniciar`, protegida por
 * gatilho em `travas.sql`).
 *
 * A recusa em si está em `ferramentas/apagar-banco.ts` (antes do DROP, na
 * mesma transação). `CSSO_AMBIENTE=producao` no ambiente é a segunda metade:
 * com ele o `ambiente-teste` não roda em banco nenhum, mesmo sem a marca.
 */
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { ehProducao } from "../config.js";
import type { Executor } from "../db/cliente.js";
import { instalacao } from "../db/esquema/index.js";

export const AMBIENTE_PRODUCAO = "PRODUCAO";

/** Recusa de ferramenta destrutiva num banco (ou ambiente) de produção. */
export class BancoDeProducao extends Error {}

export type Marca = typeof instalacao.$inferSelect;

/** `CSSO_AMBIENTE` diz produção? Aceita a grafia com e sem acento, e em inglês. */
export function ambienteDeProducao(valor: string | undefined = process.env.CSSO_AMBIENTE): boolean {
  return ehProducao(valor ?? "");
}

/**
 * Quem é este banco, num texto que a pessoa consegue conferir e digitar: a
 * referência do projeto Supabase (o `postgres.<ref>` do pooler, ou o
 * `db.<ref>.supabase.co` da conexão direta) ou, fora do Supabase,
 * `host/banco`. É o que `producao-iniciar` pede para digitar antes de apagar.
 */
export function identidadeDoBanco(url: string): string {
  const u = new URL(url);
  const usuario = decodeURIComponent(u.username);
  const doUsuario = usuario.match(/^[a-z_]+\.([a-z0-9]{10,})$/i);
  if (doUsuario) return doUsuario[1]!;
  const doHost = u.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
  if (doHost) return doHost[1]!;
  const banco = decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres";
  return `${u.hostname}/${banco}`;
}

/** A marca, lida por um executor (a tabela pode não existir num banco antigo). */
export async function lerMarca(tx: Executor): Promise<Marca | null> {
  const [existe] = (await tx.execute(
    sql`SELECT to_regclass('public.instalacao') IS NOT NULL AS ok`,
  )) as unknown as { ok: boolean }[];
  if (!existe?.ok) return null;
  const [marca] = await tx.select().from(instalacao).limit(1);
  return marca ?? null;
}

/** A marca, lida numa conexão própria e curta — para as ferramentas, antes de apagar. */
export async function marcaDoBanco(url: string): Promise<Marca | null> {
  const conexao = postgres(url, { max: 1, prepare: false, onnotice: () => {}, connect_timeout: 15 });
  try {
    const [existe] = await conexao`SELECT to_regclass('public.instalacao') IS NOT NULL AS ok`;
    if (!existe?.ok) return null;
    const [linha] = await conexao`SELECT id, ambiente, identidade, marcada_em, marcada_por FROM instalacao LIMIT 1`;
    return (linha as Marca | undefined) ?? null;
  } finally {
    await conexao.end({ timeout: 5 });
  }
}

/** Grava a marca. Só `producao-iniciar` chama; uma vez por banco. */
export async function gravarMarca(tx: Executor, identidade: string, por: string): Promise<Marca> {
  const [marca] = await tx
    .insert(instalacao)
    .values({ id: 1, ambiente: AMBIENTE_PRODUCAO, identidade, marcada_por: por })
    .returning();
  return marca!;
}
