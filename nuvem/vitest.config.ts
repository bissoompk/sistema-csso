/**
 * Testes contra o Postgres local (Docker `csso-pg`).
 *
 * O `globalSetup` monta UMA vez o banco-modelo (`csso_modelo`: migrado e
 * semeado); cada arquivo de teste clona o modelo num banco próprio
 * (`CREATE DATABASE ... TEMPLATE`, `testes/ajuda.ts`), então os arquivos rodam
 * em paralelo sem se enxergar — como o `tmp_path` de cada teste do pytest.
 */
import { defineConfig } from "vitest/config";

// Um modelo por EXECUÇÃO, e não um nome fixo: duas suítes rodando ao mesmo
// tempo (dois terminais, dois agentes) derrubavam o modelo uma da outra no
// meio da clonagem. O nome vai para os workers pelo `env` abaixo.
process.env.CSSO_MODELO ??= `csso_modelo_${process.pid}`;

export default defineConfig({
  test: {
    include: ["testes/**/*.test.ts"],
    globalSetup: ["testes/modelo.ts"],
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // o teardown do `globalSetup` apaga TODOS os clones da execução (centenas:
    // há arquivos com banco novo por teste) — ver `testes/ajuda.ts`
    teardownTimeout: 600_000,
    env: {
      NODE_ENV: "test",
      CSSO_CHAVE_SECRETA: "chave-de-teste-nao-e-segredo",
      CSSO_AMBIENTE: "teste",
      CSSO_COOKIE_SEGURO: "auto",
      CSSO_MODELO: process.env.CSSO_MODELO,
    },
  },
});
