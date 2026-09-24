/**
 * `globalSetup` do vitest: o banco-modelo que todo arquivo de teste clona.
 *
 * `csso_modelo` é recriado a cada execução (DROP + CREATE), migrado até a
 * versão do código e semeado — o `banco` fixture do conftest do Python, feito
 * uma vez só: migrar e semear custa segundos, clonar custa milissegundos.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as esquema from "../src/db/esquema/index.js";
import { migrarBanco } from "../src/db/migrar.js";
import { semear } from "../src/servicos/sementes.js";

export const MODELO = process.env.CSSO_MODELO ?? "csso_modelo";

/** O Postgres dos testes: o servidor do `.env`, sem o nome do banco. */
export function urlServidor(banco = "postgres"): string {
  const base = process.env.CSSO_TESTE_PG ?? "postgres://postgres:csso@localhost:55432/postgres";
  const u = new URL(base);
  u.pathname = "/" + banco;
  return u.toString();
}

export default async function preparar(): Promise<() => Promise<void>> {
  const admin = postgres(urlServidor(), { max: 1, prepare: false, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${MODELO} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${MODELO}`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const url = urlServidor(MODELO);
  await migrarBanco(url);
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await drizzle(sql, { schema: esquema }).transaction(async (tx) => {
      await semear(tx);
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
  return async () => {
    // o modelo é desta execução só: fica para trás se não for apagado
    const adm = postgres(urlServidor(), { max: 1, prepare: false, onnotice: () => {} });
    try {
      await adm.unsafe(`DROP DATABASE IF EXISTS ${MODELO} WITH (FORCE)`);
      // clones que um arquivo não apagou (falha no meio, afterAll que não rodou)
      const sufixo = MODELO.replace(/^csso_modelo_?/, "");
      const sobras = await adm<{ datname: string }[]>`
        SELECT datname FROM pg_database WHERE datname LIKE ${"csso_t_" + sufixo + "_%"}`;
      for (const { datname } of sobras) {
        await adm.unsafe(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
      }
    } finally {
      await adm.end({ timeout: 5 });
    }
  };
}
