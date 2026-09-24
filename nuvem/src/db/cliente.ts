/**
 * O banco: Postgres do Supabase, via postgres.js + Drizzle.
 *
 * **Uma conexão por instância de função, e `prepare: false`.** Em produção a
 * URL é a do *pooler* do Supabase em modo transação (porta 6543): cada
 * instância do Netlify Functions é um processo curto e muitas podem existir ao
 * mesmo tempo, e quem segura o número de conexões reais do Postgres é o
 * pooler. Modo transação não aceita *prepared statement* nomeado — daí o
 * `prepare: false`.
 */
import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as esquema from "./esquema/index.js";
import { obterConfig } from "../config.js";

export type Esquema = typeof esquema;
export type Banco = PostgresJsDatabase<Esquema>;
/** A transação da requisição. Serviços recebem isto, nunca o `Banco` cru. */
export type Tx = Parameters<Parameters<Banco["transaction"]>[0]>[0];
/** Quem pode executar consulta: o banco ou uma transação aberta. */
export type Executor = Banco | Tx;

let _sql: postgres.Sql | null = null;
let _db: Banco | null = null;

export function obterBanco(url?: string): Banco {
  if (_db) return _db;
  const alvo = url ?? obterConfig().bancoUrl;
  if (!alvo) throw new Error("DATABASE_URL nao configurada.");
  _sql = postgres(alvo, {
    prepare: false,
    max: Number(process.env.CSSO_POOL_MAX ?? 1),
    idle_timeout: 20,
    connect_timeout: 15,
    // datas de negócio (`date`) ficam como texto AAAA-MM-DD: converter para
    // Date aplicaria fuso e o 11/02 viraria 10/02 (RN-18).
    types: {
      date: {
        to: 1082,
        from: [1082],
        serialize: (x: string) => x,
        parse: (x: string) => x,
      },
    },
    onnotice: () => {},
  });
  _db = drizzle(_sql, { schema: esquema });
  return _db;
}

export async function fecharBanco(): Promise<void> {
  if (_sql) await _sql.end({ timeout: 5 });
  _sql = null;
  _db = null;
}

export function sqlCru(): postgres.Sql {
  obterBanco();
  return _sql!;
}
