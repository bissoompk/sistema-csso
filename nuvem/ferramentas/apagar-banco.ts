/**
 * O gesto destrutivo, num lugar só: apaga as TABELAS de `public` e o esquema
 * `drizzle`, e migra de novo (migrações + travas). Quem usa: `ambiente-teste`
 * (recriar o banco de teste) e `producao-iniciar` (a implantação).
 *
 * Apaga as tabelas, e não o esquema `public`: no Supabase o `public` vem com
 * permissões para os papéis da plataforma que um `CREATE SCHEMA public` novo
 * não teria (ver a seção RLS no fim de `src/db/travas.sql`).
 *
 * **A trava de produção mora aqui dentro**, antes do DROP, e não em quem
 * chama: banco com a marca `instalacao` (gravada por `producao-iniciar`) não
 * é apagado por caminho nenhum desta base de código. Não há parâmetro que a
 * desligue.
 */
import { BancoDeProducao } from "../src/servicos/instalacao.js";

export async function apagarEMigrar(url: string, oQue = "Apagar o banco"): Promise<void> {
  const postgres = (await import("postgres")).default;
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    // conferir a marca e apagar na MESMA transação, com a tabela da marca
    // travada: entre olhar e apagar ninguém a grava
    await sql.begin(async (tx) => {
      const [existe] = await tx`SELECT to_regclass('public.instalacao') IS NOT NULL AS ok`;
      if (existe?.ok) {
        await tx`LOCK TABLE public.instalacao IN ACCESS EXCLUSIVE MODE`;
        const [marca] = await tx`SELECT identidade, marcada_em, marcada_por FROM public.instalacao LIMIT 1`;
        if (marca) {
          const quando = new Date(marca.marcada_em as Date).toISOString().slice(0, 10);
          throw new BancoDeProducao(
            `${oQue} recusado: este banco está marcado como PRODUÇÃO (${marca.identidade}, desde ${quando}, ` +
              `por ${marca.marcada_por}). Ele guarda dado real de servidor e nenhuma ferramenta o apaga. Ver PRODUCAO.md.`,
          );
        }
      }
      await tx.unsafe(`
        DROP SCHEMA IF EXISTS drizzle CASCADE;
        DO $$
        DECLARE t record;
        BEGIN
          FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
            EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', t.tablename);
          END LOOP;
        END $$;`);
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
  const { migrarBanco } = await import("../src/db/migrar.js");
  await migrarBanco(url);
}
