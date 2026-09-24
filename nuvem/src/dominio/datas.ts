/**
 * O "hoje" de negocio, como 'AAAA-MM-DD'.
 *
 * No Python, `date.today()` lia o relogio da maquina do setor, que esta em
 * Diamantina. Na funcao da nuvem o fuso do processo e UTC: das 21h a meia-noite
 * de Brasilia, `new Date()` ja esta no dia seguinte, e uma pendencia com prazo
 * para hoje apareceria atrasada no fim do expediente. O fuso vai explicito.
 *
 * Comparar duas `DataPura` e comparar texto: 'AAAA-MM-DD' ordena
 * lexicograficamente na mesma ordem do calendario.
 */
export const FUSO_NEGOCIO = 'America/Sao_Paulo';

export function hoje_iso(fuso: string = FUSO_NEGOCIO, agora: Date = new Date()): string {
  // 'en-CA' formata como AAAA-MM-DD; e o jeito sem biblioteca de pedir a data
  // civil de um fuso a partir de um instante.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: fuso,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(agora);
}

/** `quando + timedelta(days=dias)` sobre 'AAAA-MM-DD', sem passar por fuso. */
export function somar_dias(data: string, dias: number): string {
  const [ano, mes, dia] = data.split('-').map(Number) as [number, number, number];
  const instante = new Date(Date.UTC(ano, mes - 1, dia + dias));
  return instante.toISOString().slice(0, 10);
}
