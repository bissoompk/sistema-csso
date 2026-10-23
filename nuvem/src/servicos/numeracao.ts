/**
 * RN-03 — numeração sequencial reiniciada a cada ano.
 * Porte de `app/servicos/numeracao.py`.
 *
 * Nunca MAX(numero)+1, nunca SEQUENCE nativa, nunca UUID. O número é consumido
 * somente no ato que o gasta (emissão do parecer, abertura da turma);
 * cancelamento vira estado e não reaproveita o número.
 *
 * **Serialização no PostgreSQL.** No SQLite quem serializava era o `BEGIN
 * IMMEDIATE` (um escritor só no banco inteiro), e o laço de tentativas existia
 * para o SQLITE_BUSY. Aqui quem serializa é o `UPDATE ... RETURNING` na linha
 * do ano: ele toma a trava de linha, e a segunda transação que pedir número do
 * mesmo ano ESPERA o COMMIT (ou ROLLBACK) da primeira e então lê o valor já
 * incrementado. Não há "database is locked" para repetir, e por isso não há
 * laço de tentativas — um deadlock verdadeiro (40P01) derruba a requisição
 * inteira, que é o certo: repetir dentro da mesma transação abortada não é
 * possível no PostgreSQL. A função continua rodando na transação de quem chama
 * (nunca abre outra conexão — o número e o documento que o consome comitam
 * juntos, ou nenhum dos dois).
 */
import { sql } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import { RegraViolada } from "../nucleo/erros.js";

// Nome de tabela NÃO aceita parâmetro: ele entra no SQL por interpolação. Esta
// lista fechada é o que impede a função mais transacional do sistema de virar
// superfície de injeção. Declarar o par também impede consumir a sequência de
// um e conferir a ocupação no outro.
export const SEQUENCIAS: Readonly<Record<string, string>> = Object.freeze({
  parecer_sequencia: "parecer_tecnico",
  turma_sequencia: "turma",
  certificado_sequencia: "certificado",
  epi_requisicao_sequencia: "epi_requisicao",
  acidente_cat_sp_sequencia: "acidente_ocorrencia",
});

export const COLUNAS_ADMITIDAS: ReadonlySet<string> = new Set(["numero"]);

export class NumeracaoIndisponivel extends Error {}

/** Tabela fora de `SEQUENCIAS`. Nunca interpolar nome que veio de fora. */
export class SequenciaDesconhecida extends RegraViolada {}

function conferir(tabela_sequencia: string, tabela_alvo: string, coluna: string): void {
  const esperado = Object.hasOwn(SEQUENCIAS, tabela_sequencia) ? SEQUENCIAS[tabela_sequencia] : undefined;
  if (esperado === undefined) {
    throw new SequenciaDesconhecida(`tabela de sequencia nao declarada: '${tabela_sequencia}'`);
  }
  if (esperado !== tabela_alvo) {
    throw new SequenciaDesconhecida(`'${tabela_sequencia}' numera '${esperado}', nao '${tabela_alvo}'`);
  }
  if (!COLUNAS_ADMITIDAS.has(coluna)) {
    throw new SequenciaDesconhecida(`coluna de numeracao nao admitida: '${coluna}'`);
  }
}

/**
 * Consome o próximo número do ano dentro da transação corrente.
 *
 * Números já gravados na tabela alvo são pulados — inclusive os RESERVADO que
 * a migração da planilha criou.
 */
export async function proximo_numero(
  tx: Executor,
  ano: number,
  opcoes: { tabela_sequencia: string; tabela_alvo: string; coluna?: string },
): Promise<number> {
  const coluna = opcoes.coluna ?? "numero";
  conferir(opcoes.tabela_sequencia, opcoes.tabela_alvo, coluna);
  // seguros: os três nomes acabaram de ser conferidos contra a lista fechada
  const seq = sql.raw(opcoes.tabela_sequencia);
  const alvo = sql.raw(opcoes.tabela_alvo);
  const col = sql.raw(coluna);

  await tx.execute(sql`INSERT INTO ${seq} (ano, ultimo_numero) VALUES (${ano}, 0) ON CONFLICT (ano) DO NOTHING`);
  for (;;) {
    const linhas = await tx.execute<{ ultimo_numero: number }>(
      sql`UPDATE ${seq} SET ultimo_numero = ultimo_numero + 1 WHERE ano = ${ano} RETURNING ultimo_numero`,
    );
    const numero = linhas[0]?.ultimo_numero;
    if (numero === undefined || numero === null) {
      throw new NumeracaoIndisponivel(`nao foi possivel obter numero de ${opcoes.tabela_alvo} para ${ano}`);
    }
    const ocupado = await tx.execute(sql`SELECT 1 FROM ${alvo} WHERE ${col} = ${numero} AND ano = ${ano} LIMIT 1`);
    if (!ocupado.length) return Number(numero);
  }
}

export function proximo_numero_parecer(tx: Executor, ano: number): Promise<number> {
  return proximo_numero(tx, ano, { tabela_sequencia: "parecer_sequencia", tabela_alvo: "parecer_tecnico" });
}

export function proximo_numero_turma(tx: Executor, ano: number): Promise<number> {
  return proximo_numero(tx, ano, { tabela_sequencia: "turma_sequencia", tabela_alvo: "turma" });
}

/**
 * O número do certificado. Anular NÃO devolve o número à sequência: dois
 * papéis diferentes não podem circular como "27/2026".
 */
export function proximo_numero_certificado(tx: Executor, ano: number): Promise<number> {
  return proximo_numero(tx, ano, { tabela_sequencia: "certificado_sequencia", tabela_alvo: "certificado" });
}

/**
 * O número do protocolo `EPI-AAAA-NNNN`, consumido no ENVIO — não na criação
 * do rascunho (buraco na sequência a cada formulário abandonado). Cancelar
 * também não devolve o número.
 */
export function proximo_numero_requisicao_epi(tx: Executor, ano: number): Promise<number> {
  return proximo_numero(tx, ano, { tabela_sequencia: "epi_requisicao_sequencia", tabela_alvo: "epi_requisicao" });
}

/**
 * O número do protocolo `CAT-AAAA-NNNN` da ocorrência de acidente (D7),
 * consumido no ENVIO da comunicação. Cancelar não devolve o número, e os já
 * ocupados (os migrados da planilha antiga) são pulados.
 */
export function proximo_numero_cat_sp(tx: Executor, ano: number): Promise<number> {
  return proximo_numero(tx, ano, { tabela_sequencia: "acidente_cat_sp_sequencia", tabela_alvo: "acidente_ocorrencia" });
}

/** Após a importação: ultimo_numero = max(numero) por ano. */
export async function recontar_sequencia(tx: Executor): Promise<Map<number, number>> {
  const resultado = new Map<number, number>();
  const linhas = await tx.execute<{ ano: number; maximo: number | null }>(
    sql`SELECT ano, MAX(numero) AS maximo FROM parecer_tecnico GROUP BY ano`,
  );
  for (const { ano, maximo } of linhas) {
    const m = Number(maximo ?? 0);
    // o `MAX(a, b)` escalar do SQLite é o `GREATEST` do PostgreSQL
    await tx.execute(
      sql`INSERT INTO parecer_sequencia (ano, ultimo_numero) VALUES (${Number(ano)}, ${m})
          ON CONFLICT (ano) DO UPDATE
          SET ultimo_numero = GREATEST(parecer_sequencia.ultimo_numero, excluded.ultimo_numero)`,
    );
    resultado.set(Number(ano), m);
  }
  return resultado;
}

/** Relatório /relatorios: números não usados dentro do intervalo do ano. */
export async function lacunas_de_numeracao(tx: Executor, ano: number): Promise<number[]> {
  const usados = new Set(
    (await tx.execute<{ numero: number }>(sql`SELECT numero FROM parecer_tecnico WHERE ano = ${ano}`)).map((l) =>
      Number(l.numero),
    ),
  );
  const [teto] = await tx.execute<{ ultimo_numero: number }>(
    sql`SELECT ultimo_numero FROM parecer_sequencia WHERE ano = ${ano}`,
  );
  const limite = Math.max(0, ...usados, Number(teto?.ultimo_numero ?? 0));
  const lacunas: number[] = [];
  for (let n = 1; n <= limite; n++) if (!usados.has(n)) lacunas.push(n);
  return lacunas;
}

// ---------------------------------------------------------------------
// Portal do servidor (22/10/2026): o número impresso do certificado novo
// ---------------------------------------------------------------------
/**
 * `CSSO-NR35-2026-0001`: a sequência é por PREFIXO (sigla do setor promotor +
 * código curto do treinamento) e por ano, em `certificado_sequencia_prefixo`.
 *
 * Mesma disciplina de `proximo_numero`: nunca MAX()+1. O `UPDATE ... RETURNING`
 * na linha (prefixo, ano) toma a trava de linha; a segunda emissão do mesmo
 * prefixo ESPERA o COMMIT da primeira e lê o valor já incrementado — sem
 * buraco por concorrência. Rodando na transação (ou SAVEPOINT do lote) de quem
 * emite, o número volta junto com o ROLLBACK de uma emissão que falhou.
 *
 * Um número já gravado (`certificado.numero_impresso`) é pulado: protege o
 * caso de o código curto ter sido editado para um prefixo que já existiu.
 */
const _RE_PREFIXO = /^[A-Z0-9]{1,12}-[A-Z0-9]{2,10}$/;

export async function proximo_numero_impresso(
  tx: Executor,
  prefixo: string,
  ano: number,
  montar: (prefixo: string, ano: number, sequencia: number) => string,
): Promise<{ sequencia: number; numero_impresso: string }> {
  // O prefixo vai como parâmetro (não há interpolação), mas um prefixo fora do
  // formato abriria uma sequência que o CHECK de `certificado.numero_impresso`
  // recusaria depois — melhor recusar antes de gastar a linha.
  if (!_RE_PREFIXO.test(prefixo)) throw new NumeracaoIndisponivel(`prefixo de numero fora do formato: '${prefixo}'`);
  if (!Number.isInteger(ano) || ano < 1000 || ano > 9999) throw new NumeracaoIndisponivel(`ano invalido: ${ano}`);
  await tx.execute(
    sql`INSERT INTO certificado_sequencia_prefixo (prefixo, ano, ultimo_numero) VALUES (${prefixo}, ${ano}, 0)
        ON CONFLICT (prefixo, ano) DO NOTHING`,
  );
  for (;;) {
    const linhas = await tx.execute<{ ultimo_numero: number }>(
      sql`UPDATE certificado_sequencia_prefixo SET ultimo_numero = ultimo_numero + 1
          WHERE prefixo = ${prefixo} AND ano = ${ano} RETURNING ultimo_numero`,
    );
    const sequencia = linhas[0]?.ultimo_numero;
    if (sequencia === undefined || sequencia === null) {
      throw new NumeracaoIndisponivel(`nao foi possivel obter numero de certificado para ${prefixo}/${ano}`);
    }
    const numero_impresso = montar(prefixo, ano, Number(sequencia));
    const ocupado = await tx.execute(sql`SELECT 1 FROM certificado WHERE numero_impresso = ${numero_impresso} LIMIT 1`);
    if (!ocupado.length) return { sequencia: Number(sequencia), numero_impresso };
  }
}
