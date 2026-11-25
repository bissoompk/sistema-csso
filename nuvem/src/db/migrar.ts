import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const aqui = path.dirname(fileURLToPath(import.meta.url));

/**
 * Limites da migração (26/11/2026). Um `ALTER TABLE` pede bloqueio exclusivo da tabela: com uma
 * consulta longa aberta nela, o Postgres esperaria sem fim, e o build do Netlify ficaria preso.
 * Com `lock_timeout`, quem não consegue o bloqueio a tempo FALHA; as migrações pendentes rodam
 * numa transação só, então nada fica pela metade, o build falha e a versão anterior continua no ar.
 * `statement_timeout` corta um comando que demore além do razoável pelo mesmo caminho.
 */
export const LOCK_TIMEOUT_PADRAO = "10s";
export const STATEMENT_TIMEOUT_PADRAO = "120s";
const RE_DURACAO = /^\d+(ms|s|min)?$/;

export interface OpcoesMigracao {
  /** pasta das migrações (os testes usam uma pasta própria) */
  pasta?: string;
  /** sem as travas (`travas.sql`): só para os testes da própria migração */
  sem_travas?: boolean;
  lock_timeout?: string;
  statement_timeout?: string;
}

function _duracao(valor: string | undefined, padrao: string, nome: string): string {
  const v = (valor ?? "").trim() || padrao;
  if (!RE_DURACAO.test(v)) throw new Error(`${nome} inválido: use, por exemplo, 10s, 500ms ou 2min.`);
  return v;
}

/** Aplica as migrações e as travas numa conexão própria, curta, com limite de espera. */
export async function migrarBanco(url: string, opcoes: OpcoesMigracao = {}): Promise<void> {
  const lock = _duracao(opcoes.lock_timeout ?? process.env.CSSO_MIGRAR_LOCK_TIMEOUT, LOCK_TIMEOUT_PADRAO, "lock_timeout");
  const comando = _duracao(
    opcoes.statement_timeout ?? process.env.CSSO_MIGRAR_STATEMENT_TIMEOUT,
    STATEMENT_TIMEOUT_PADRAO,
    "statement_timeout",
  );
  // max: 1 — os SET valem para a sessão, e a migração inteira roda nesta mesma conexão
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await sql.unsafe(`SET lock_timeout = '${lock}'`);
    await sql.unsafe(`SET statement_timeout = '${comando}'`);
    await migrate(drizzle(sql), { migrationsFolder: opcoes.pasta ?? path.join(aqui, "migracoes") });
    if (!opcoes.sem_travas) await sql.unsafe(readFileSync(path.join(aqui, "travas.sql"), "utf8"));
  } finally {
    await sql.end({ timeout: 5 });
  }
}
