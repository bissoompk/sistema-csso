/**
 * Publicação (26/11/2026): a migração não espera sem fim por um bloqueio. Com uma tabela presa
 * por outra sessão, o `ALTER TABLE` falha pelo `lock_timeout`; as migrações pendentes rodam numa
 * transação só, então nada fica aplicado (o build falha e a versão anterior continua no ar).
 * Solto o bloqueio, a mesma migração passa.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrarBanco } from "../src/db/migrar.js";
import { urlServidor } from "./modelo.js";

const NOME = `csso_t_lock_${process.pid}_${Date.now()}`;
let pasta: string;

/** Uma pasta de migrações do Drizzle com duas migrações pequenas, na tabela `alvo`. */
function pasta_de_migracoes(): string {
  const raiz = mkdtempSync(path.join(tmpdir(), "csso-migr-"));
  mkdirSync(path.join(raiz, "meta"));
  const entradas = [
    { tag: "0000_coluna_a", sql: `ALTER TABLE "alvo" ADD COLUMN "a" integer;` },
    { tag: "0001_coluna_b", sql: `ALTER TABLE "alvo" ADD COLUMN "b" integer;` },
  ];
  entradas.forEach((x) => writeFileSync(path.join(raiz, `${x.tag}.sql`), x.sql));
  writeFileSync(
    path.join(raiz, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: entradas.map((x, i) => ({ idx: i, version: "7", when: 1_700_000_000_000 + i, tag: x.tag, breakpoints: true })),
    }),
  );
  return raiz;
}

async function colunas(sql: postgres.Sql): Promise<string[]> {
  const r = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'alvo' ORDER BY column_name`;
  return r.map((x) => x.column_name as string);
}

async function aplicadas(sql: postgres.Sql): Promise<number> {
  const [t] = await sql`SELECT to_regclass('drizzle.__drizzle_migrations') AS t`;
  if (!t!.t) return 0;
  const [n] = await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
  return n!.n as number;
}

beforeAll(async () => {
  const admin = postgres(urlServidor(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${NOME}`);
  await admin.end();
  const sql = postgres(urlServidor(NOME), { max: 1, onnotice: () => {} });
  await sql`CREATE TABLE alvo (id integer)`;
  await sql.end();
  pasta = pasta_de_migracoes();
});

afterAll(async () => {
  rmSync(pasta, { recursive: true, force: true });
  const admin = postgres(urlServidor(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${NOME} WITH (FORCE)`);
  await admin.end();
});

describe("migração com limite de espera de bloqueio", () => {
  it("tabela presa por outra sessão: falha no lock_timeout, nada aplicado; solta, a mesma migração passa", async () => {
    const preso = postgres(urlServidor(NOME), { max: 1, onnotice: () => {} });
    const conferir = postgres(urlServidor(NOME), { max: 1, onnotice: () => {} });
    try {
      // a outra sessão segura a tabela (como uma consulta longa da aplicação no ar)
      let soltar!: () => void;
      const solta = new Promise<void>((r) => (soltar = r));
      let preso_ok!: () => void;
      const pronto = new Promise<void>((r) => (preso_ok = r));
      const transacao = preso.begin(async (tx) => {
        await tx`LOCK TABLE alvo IN ACCESS SHARE MODE`;
        preso_ok();
        await solta;
      });
      await pronto;

      const inicio = Date.now();
      const erro = await migrarBanco(urlServidor(NOME), { pasta, sem_travas: true, lock_timeout: "1s" }).then(
        () => null,
        (e: unknown) => e as { code?: string; message?: string; cause?: { code?: string } },
      );
      const levou = Date.now() - inicio;
      expect(erro, "a migração deveria falhar").not.toBeNull();
      // o Drizzle embrulha o erro do Postgres: o código vem na causa
      expect(erro!.code ?? erro!.cause?.code).toBe("55P03"); // lock_not_available
      expect(levou).toBeLessThan(15_000);
      // a transação inteira voltou: nem a primeira coluna ficou, nem o registro da migração
      expect(await colunas(conferir)).toEqual(["id"]);
      expect(await aplicadas(conferir)).toBe(0);

      soltar();
      await transacao;
      await migrarBanco(urlServidor(NOME), { pasta, sem_travas: true, lock_timeout: "1s" });
      expect(await colunas(conferir)).toEqual(["a", "b", "id"]);
      expect(await aplicadas(conferir)).toBe(2);
    } finally {
      await preso.end({ timeout: 5 });
      await conferir.end({ timeout: 5 });
    }
  });

  it("os limites padrão são 10 s de bloqueio e 120 s por comando, e um valor torto é recusado", async () => {
    const { LOCK_TIMEOUT_PADRAO, STATEMENT_TIMEOUT_PADRAO } = await import("../src/db/migrar.js");
    expect([LOCK_TIMEOUT_PADRAO, STATEMENT_TIMEOUT_PADRAO]).toEqual(["10s", "120s"]);
    await expect(migrarBanco(urlServidor(NOME), { pasta, sem_travas: true, lock_timeout: "10s; DROP TABLE alvo" })).rejects.toThrow(
      /lock_timeout inválido/,
    );
  });
});
