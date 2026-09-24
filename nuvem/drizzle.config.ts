import { defineConfig } from 'drizzle-kit';

// O esquema e o do Drizzle; as travas (triggers) NAO: o drizzle-kit nao enxerga
// trigger, e por isso elas vivem em `src/db/travas.sql`, idempotente, aplicado
// depois de cada `migrate` (ver o cabecalho daquele arquivo).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/esquema/index.ts',
  out: './src/db/migracoes',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
});
