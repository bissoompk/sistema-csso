import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const aqui = path.dirname(fileURLToPath(import.meta.url));

/** Aplica as migrações e as travas numa conexão própria, curta. */
export async function migrarBanco(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), { migrationsFolder: path.join(aqui, "migracoes") });
    await sql.unsafe(readFileSync(path.join(aqui, "travas.sql"), "utf8"));
  } finally {
    await sql.end({ timeout: 5 });
  }
}
