/**
 * Testes contra o Postgres local (Docker `csso-pg`).
 *
 * O `globalSetup` monta UMA vez o banco-modelo (`csso_modelo`: migrado e
 * semeado); cada arquivo de teste clona o modelo num banco próprio
 * (`CREATE DATABASE ... TEMPLATE`, `testes/ajuda.ts`), então os arquivos rodam
 * em paralelo sem se enxergar — como o `tmp_path` de cada teste do pytest.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["testes/**/*.test.ts"],
    globalSetup: ["testes/modelo.ts"],
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: "test",
      CSSO_CHAVE_SECRETA: "chave-de-teste-nao-e-segredo",
      CSSO_AMBIENTE: "teste",
      CSSO_COOKIE_SEGURO: "auto",
    },
  },
});
