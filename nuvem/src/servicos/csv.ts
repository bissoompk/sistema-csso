/**
 * O `csv.writer(delimiter=";")` do Python (QUOTE_MINIMAL, `\r\n`), num lugar só.
 * Eram três cópias (relatórios, indicadores de EPI, exportação completa).
 *
 * **Injeção de fórmula** (revisão de segurança, 25/09/2026): o Excel executa
 * como fórmula a célula que começa por `= + - @` (e por tabulação ou `\r`,
 * que ele descarta antes de olhar). Um nome de servidor, uma observação ou
 * um nome de arquivo digitado como `=HYPERLINK("http://…")` virava link — ou
 * comando, no Excel antigo com DDE — no computador de quem abrisse o
 * relatório. O campo assim sai com um apóstrofo na frente, que o Excel
 * esconde e trata como texto (recomendação da OWASP). Número de verdade
 * (`-3`, `+1,5`) passa intacto: não é fórmula e o apóstrofo o estragaria.
 */

const INICIO_DE_FORMULA = /^[=+\-@\t\r]/;
const NUMERO = /^[+-]?\d+([.,]\d+)?$/;

export function neutralizar_formula(s: string): string {
  return INICIO_DE_FORMULA.test(s) && !NUMERO.test(s) ? `'${s}` : s;
}

export function campo_csv(v: unknown): string {
  const s = neutralizar_formula(v === null || v === undefined ? "" : String(v));
  return /[;"\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function linha_csv(campos: unknown[]): string {
  return campos.map(campo_csv).join(";") + "\r\n";
}
