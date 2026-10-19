/**
 * O banco: Postgres do Supabase, via postgres.js + Drizzle.
 *
 * **Uma conexão por instância de função.** Cada instância do Netlify Functions
 * é um processo curto e muitas podem existir ao mesmo tempo; quem segura o
 * número de conexões reais do Postgres é o *pooler* do Supabase.
 *
 * **Consulta preparada, salvo no pooler em modo transação.** O Drizzle chama
 * `sql.unsafe`, que no postgres.js sai com `prepare: false` — e consulta com
 * parâmetro sem preparar custa DUAS idas ao banco (descreve, depois executa) e
 * não segue em paralelo com outra. Com a função num continente e o banco em
 * outro (Netlify em Ohio, Supabase em São Paulo), era o grosso do tempo de cada
 * tela. Preparada, a consulta custa uma ida da segunda vez em diante na mesma
 * conexão, e `Promise.all` dentro da transação vira uma ida só. O modo transação
 * do pooler (porta 6543) não aceita *prepared statement* nomeado: lá fica como
 * antes. Produção usa o modo sessão (porta 5432) — PRODUCAO.md.
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
/** Quem quer ver cada consulta que sai (a medição de idas ao banco dos testes). */
let _observador: ((consulta: string) => void) | null = null;
export function observarConsultas(f: ((consulta: string) => void) | null): void {
  _observador = f;
}
let _db: Banco | null = null;

/** Preparar só não vale no pooler em modo transação (porta 6543). */
export function preparaConsultas(alvo: string): boolean {
  try {
    return new URL(alvo).port !== "6543";
  } catch {
    return false;
  }
}

/**
 * O cliente com `prepare: true` em todo `unsafe` — inclusive no da transação e
 * no do savepoint, que o postgres.js cria por conta própria.
 */
function preparando(sql: postgres.Sql | postgres.TransactionSql): any {
  return new Proxy(sql, {
    get(alvo: any, nome, receptor) {
      if (nome === "unsafe") {
        return (consulta: string, args: unknown[] = [], opcoes: Record<string, unknown> = {}) =>
          alvo.unsafe(consulta, args, { prepare: true, ...opcoes });
      }
      if (nome === "begin" || nome === "savepoint") {
        return (...args: any[]) => {
          const f = args[args.length - 1];
          args[args.length - 1] = (c: postgres.TransactionSql) => f(preparando(c));
          return alvo[nome](...args);
        };
      }
      return Reflect.get(alvo, nome, receptor);
    },
  });
}

function conectar(alvo: string, max: number): postgres.Sql {
  const sql = postgres(alvo, {
    prepare: preparaConsultas(alvo),
    max,
    // dois minutos: a conexão (e as consultas preparadas nela) sobrevive ao
    // intervalo entre um clique e outro de quem está usando o sistema
    idle_timeout: 120,
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
    debug: (_conexao, consulta) => _observador?.(consulta),
  });
  return preparaConsultas(alvo) ? preparando(sql) : sql;
}

export function obterBanco(url?: string): Banco {
  if (_db) return _db;
  const alvo = url ?? obterConfig().bancoUrl;
  if (!alvo) throw new Error("DATABASE_URL nao configurada.");
  _sql = conectar(alvo, Number(process.env.CSSO_POOL_MAX ?? 1));
  _db = drizzle(_sql, { schema: esquema });
  return _db;
}

/**
 * Um banco AVULSO, fora do singleton, para ferramenta que precisa falar com um
 * banco que não é o do processo (`producao-iniciar`): `obterBanco(url)` devolve
 * o banco já aberto e IGNORA a `url` — o que, numa ferramenta que apaga,
 * seria o erro que não se desfaz. Quem abre fecha (`fechar`).
 */
export function abrirBancoAvulso(url: string): { db: Banco; fechar: () => Promise<void> } {
  const sql = conectar(url, 1);
  return { db: drizzle(sql, { schema: esquema }), fechar: () => sql.end({ timeout: 5 }) };
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
