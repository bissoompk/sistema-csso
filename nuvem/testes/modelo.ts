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

/**
 * O retrato do modelo DENTRO dele (esquema `_csso_modelo`), que todo clone
 * herda: uma cópia de cada tabela de `public` como saiu da semeadura, o estado
 * das sequências e uma impressão digital do esquema.
 *
 * É o que deixa `bancoLimpo()` devolver um banco virgem SEM clonar outro:
 * `_csso_modelo.restaurar()` apaga os dados de `public`, recoloca os do retrato
 * e as sequências, com os gatilhos desligados (`session_replication_role =
 * replica` — as travas de append-only não disparam, como na restauração de
 * backup). Custa dezenas de milissegundos; clonar e depois apagar um banco
 * custava ~0,6 s, e o `DROP DATABASE` força um CHECKPOINT que, com a suíte
 * inteira escrevendo, levava segundos e travava os outros arquivos.
 *
 * Se um teste mexeu no ESQUEMA (criou tabela, gatilho ou função, desligou um
 * gatilho e não religou), a impressão digital não bate, `restaurar()` devolve
 * falso e `bancoLimpo()` clona um banco novo, como antes.
 */
const RETRATO = `
CREATE SCHEMA _csso_modelo;
DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('CREATE TABLE _csso_modelo.%I AS TABLE public.%I', t, t);
  END LOOP;
END $$;
CREATE TABLE _csso_modelo._sequencias AS
  SELECT format('public.%I', sequencename) AS nome, last_value, start_value
    FROM pg_sequences WHERE schemaname = 'public';
CREATE FUNCTION _csso_modelo.impressao() RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT md5(
    coalesce((SELECT string_agg(relname || ':' || relkind::text, ',' ORDER BY relname)
                FROM pg_class WHERE relnamespace = 'public'::regnamespace), '') || '|' ||
    coalesce((SELECT string_agg(c.relname || '.' || t.tgname || ':' || t.tgenabled::text, ',' ORDER BY c.relname, t.tgname)
                FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
               WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace), '') || '|' ||
    coalesce((SELECT string_agg(proname || '(' || oidvectortypes(proargtypes) || ')', ',' ORDER BY proname, oidvectortypes(proargtypes))
                FROM pg_proc WHERE pronamespace = 'public'::regnamespace), '') || '|' ||
    coalesce((SELECT string_agg(c.relname || '.' || count_cols::text, ',' ORDER BY c.relname)
                FROM (SELECT attrelid, count(*) AS count_cols FROM pg_attribute
                       WHERE attnum > 0 AND NOT attisdropped GROUP BY attrelid) a
                JOIN pg_class c ON c.oid = a.attrelid
               WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'), ''))
$f$;
CREATE TABLE _csso_modelo._impressao AS SELECT _csso_modelo.impressao() AS v;
CREATE FUNCTION _csso_modelo.restaurar() RETURNS boolean LANGUAGE plpgsql AS $f$
DECLARE t text; s record;
BEGIN
  IF _csso_modelo.impressao() <> (SELECT v FROM _csso_modelo._impressao) THEN
    RETURN false;
  END IF;
  SET LOCAL session_replication_role = replica;
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('DELETE FROM public.%I', t);
    EXECUTE format('INSERT INTO public.%I OVERRIDING SYSTEM VALUE SELECT * FROM _csso_modelo.%I', t, t);
  END LOOP;
  FOR s IN SELECT * FROM _csso_modelo._sequencias LOOP
    PERFORM setval(s.nome, coalesce(s.last_value, s.start_value), s.last_value IS NOT NULL);
  END LOOP;
  RETURN true;
END
$f$;
`;

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
    await sql.unsafe(RETRATO);
  } finally {
    await sql.end({ timeout: 5 });
  }
  return async () => {
    // o modelo é desta execução só: fica para trás se não for apagado
    const adm = postgres(urlServidor(), { max: 8, prepare: false, onnotice: () => {} });
    try {
      await adm.unsafe(`DROP DATABASE IF EXISTS ${MODELO} WITH (FORCE)`);
      // clones que um arquivo não apagou (falha no meio, afterAll que não rodou)
      const sufixo = MODELO.replace(/^csso_modelo_?/, "");
      const sobras = await adm<{ datname: string }[]>`
        SELECT datname FROM pg_database WHERE datname LIKE ${"csso_t_" + sufixo + "_%"}`;
      // Em paralelo: cada DROP DATABASE espera um checkpoint, e pedidos
      // simultâneos são atendidos pelo MESMO checkpoint.
      const fila = sobras.map((s) => s.datname);
      await Promise.all(
        Array.from({ length: 8 }, async () => {
          for (let n = fila.shift(); n !== undefined; n = fila.shift()) {
            await adm.unsafe(`DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`).catch(() => {});
          }
        }),
      );
    } finally {
      await adm.end({ timeout: 5 });
    }
  };
}
