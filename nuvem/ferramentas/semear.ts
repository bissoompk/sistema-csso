/**
 * Semeia o banco (idempotente): RBAC, organização, domínios, textos, emissores
 * e catálogos de EPI. O `sementes.semear` que o Python rodava no `lifespan`.
 *
 *     npm run db:semear
 *
 * Numa transação só: ou entra tudo, ou nada.
 */
import { carregarEnvLocal } from "./env-local.js";

carregarEnvLocal();
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL ausente.");
  process.exit(1);
}
const { obterBanco, fecharBanco } = await import("../src/db/cliente.js");
const { semear } = await import("../src/servicos/sementes.js");
try {
  await obterBanco().transaction(async (tx) => {
    await semear(tx);
  });
  console.log("[semear] sementes conferidas.");
} finally {
  await fecharBanco();
}
