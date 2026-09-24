/**
 * Leva o banco à versão do código: migrações do Drizzle e depois as travas.
 *
 *     npm run db:migrar
 *
 * Roda na publicação do Netlify (`ferramentas/preparar-publicacao.mjs`) e nos
 * testes. As travas (`src/db/travas.sql`) são reaplicadas toda vez porque são
 * idempotentes (CREATE OR REPLACE) — o que está no arquivo é o que vale.
 */
import { carregarEnvLocal } from "./env-local.js";
import { migrarBanco } from "../src/db/migrar.js";

carregarEnvLocal();
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL ausente.");
  process.exit(1);
}
await migrarBanco(url);
console.log("[migrar] banco na versão do código.");
