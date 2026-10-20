/**
 * Procura CPF gravado em qualquer coluna de texto do banco — e só CONTA.
 *
 *     npx tsx ferramentas/procurar-cpf.ts            # o banco do DATABASE_URL
 *
 * O sistema não tem coluna de CPF (ROPA §4.5) além das do certificado
 * (`COLUNAS_DO_CERTIFICADO`, 19/10/2026: "guardar CPF só para certificado"),
 * que esta ferramenta não conta — nem o CPF congelado no contexto do
 * certificado emitido. Desde a revisão de 25/09/2026
 * todo formulário, toda chamada da API e toda importação mascaram o CPF que
 * alguém digite num campo livre (`textos.mascarar_cpf`). O que esta ferramenta
 * responde é o que a máscara não alcança: o que já estava no banco antes dela
 * (uma carga antiga, um restore de backup do Python, um INSERT à mão) — rode-a
 * depois de carregar os dados reais e a cada restauração.
 *
 * Só leitura. Imprime `tabela.coluna: N linha(s)` e NUNCA o valor: a saída vai
 * para terminal, histórico de shell e colagem em conversa. Para ver a linha,
 * consulte o banco pelo `id`, sob o mesmo cuidado do dado.
 *
 * Não lê anexos (PDF digitalizado pode trazer CPF impresso — o sistema não
 * inspeciona o conteúdo de arquivo).
 */
import postgres from "postgres";
import { pathToFileURL } from "node:url";
import { carregarEnvLocal } from "./env-local.js";
import { mascarar_cpf } from "../src/servicos/textos.js";
import { sem_cpf_no_contexto } from "../src/servicos/cpf_certificado.js";

/** Onde o CPF mora DE PROPÓSITO (`src/servicos/cpf_certificado.ts`). */
export const COLUNAS_DO_CERTIFICADO: ReadonlySet<string> = new Set(["participante.cpf", "assinatura_instrutor.cpf"]);

// Candidatos no Postgres (sem lookbehind lá): a forma pontuada, ou onze
// dígitos soltos. A decisão final é a mesma de `textos.mascarar_cpf`.
const CANDIDATO = "(^|[^[:alnum:]_./-])[0-9]{3}[.]?[0-9]{3}[.]?[0-9]{3}-?[0-9]{2}([^[:alnum:]_]|$)";

export interface Achado {
  tabela: string;
  coluna: string;
  linhas: number;
}

export async function procurar_cpf(sql: postgres.Sql): Promise<Achado[]> {
  const colunas = await sql<{ tabela: string; coluna: string }[]>`
    SELECT c.table_name AS tabela, c.column_name AS coluna
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'public'
       AND c.data_type IN ('text', 'character varying', 'jsonb', 'json')
     ORDER BY 1, 2`;
  const achados: Achado[] = [];
  for (const { tabela, coluna } of colunas) {
    if (COLUNAS_DO_CERTIFICADO.has(`${tabela}.${coluna}`)) continue;
    // o contexto do certificado guarda o CPF que o modelo pediu; o resto dele não
    const do_certificado = tabela === "certificado" && coluna === "contexto_congelado";
    const valores = await sql.unsafe<{ v: string }[]>(
      `SELECT "${coluna.replaceAll('"', '""')}"::text AS v
         FROM public."${tabela.replaceAll('"', '""')}"
        WHERE "${coluna.replaceAll('"', '""')}"::text ~ $1`,
      [CANDIDATO],
    );
    const linhas = valores
      .map(({ v }) => (do_certificado ? JSON.stringify(sem_cpf_no_contexto(JSON.parse(v))) : v))
      .filter((v) => mascarar_cpf(v) !== v).length;
    if (linhas) achados.push({ tabela, coluna, linhas });
  }
  return achados;
}

async function principal(): Promise<void> {
  carregarEnvLocal();
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL ausente.");
    process.exit(1);
  }
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const achados = await procurar_cpf(sql);
    if (!achados.length) {
      console.log("[procurar-cpf] nenhum CPF em coluna de texto do banco.");
      return;
    }
    console.log("[procurar-cpf] CPF encontrado (só a contagem; o valor não se imprime):");
    for (const a of achados) console.log(`  ${a.tabela}.${a.coluna}: ${a.linhas} linha(s)`);
    process.exitCode = 2;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await principal();
