/**
 * Datas em português sem depender de locale do SO. Porte de
 * `app/servicos/datas_br.py`.
 *
 * No Python a lista literal de meses existia porque `setlocale(pt_BR)` falha
 * no Windows (CA-04 roda com LC_ALL=C). Aqui ela continua literal por outro
 * motivo igualmente bom: `Intl` com `pt-BR` depende do ICM embutido no Node da
 * função, e o texto que vai para o parecer não pode depender de build de
 * runtime.
 *
 * **Datas de negócio são texto `AAAA-MM-DD`** (colunas `date`, RN-18): nada
 * aqui converte uma delas para `Date`, que é instante e tem fuso. Só os
 * momentos (`timestamptz`, que chegam como `Date`) passam por fuso, e o fuso
 * de exibição é America/Sao_Paulo.
 */
import { FUSO_NEGOCIO, hoje_iso } from "../dominio/datas.js";

export const MESES: readonly string[] = [
  "janeiro",
  "fevereiro",
  "marco",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

// Com acento, como sai no documento.
export const MESES_ACENTUADOS: readonly string[] = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

export const FUSO_BR = FUSO_NEGOCIO;

/** Uma data civil (`AAAA-MM-DD`). */
export type Data = string;

/**
 * O "hoje" de negócio, no fuso de Diamantina — e não o UTC da função.
 * Reusa `hoje_iso` de `src/dominio/datas.ts` (uma regra só para o "hoje").
 */
export function hoje(agora: Date = new Date()): Data {
  return hoje_iso(FUSO_BR, agora);
}

function sem_acento(texto: string): string {
  return texto.normalize("NFD").replace(/\p{Mn}/gu, "");
}

const dois = (n: number) => String(n).padStart(2, "0");
const quatro = (n: number) => String(n).padStart(4, "0");

/** Monta 'AAAA-MM-DD' a partir de partes, conferindo que a data existe. */
export function montar(ano: number, mes: number, dia: number): Data {
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  if (
    !Number.isFinite(ano) ||
    d.getUTCFullYear() !== ano ||
    d.getUTCMonth() !== mes - 1 ||
    d.getUTCDate() !== dia
  ) {
    // o `date(...)` do Python levanta ValueError com data inexistente
    throw new RangeError(`data inexistente: ${ano}-${mes}-${dia}`);
  }
  return `${quatro(ano)}-${dois(mes)}-${dois(dia)}`;
}

/** As partes [ano, mes, dia] de uma data civil (aceita `Date`, lida em UTC). */
export function partes(quando: Data | Date): [number, number, number] {
  if (quando instanceof Date) {
    return [quando.getUTCFullYear(), quando.getUTCMonth() + 1, quando.getUTCDate()];
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(quando));
  if (!m) throw new RangeError(`data fora do formato AAAA-MM-DD: ${quando}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** 11 de fevereiro de 2025 (mes minusculo, dia com zero a esquerda). */
export function por_extenso(quando: Data): string {
  const [ano, mes, dia] = partes(quando);
  return `${dois(dia)} de ${MESES_ACENTUADOS[mes - 1]} de ${ano}`;
}

/** 11 de Fevereiro de 2025 (variante usada em parte dos pareceres). */
export function por_extenso_capitalizado(quando: Data): string {
  const [ano, mes, dia] = partes(quando);
  const nome = MESES_ACENTUADOS[mes - 1]!;
  return `${dois(dia)} de ${nome[0]!.toUpperCase()}${nome.slice(1)} de ${ano}`;
}

/** Diamantina, 11 de fevereiro de 2025 */
export function por_extenso_cidade(cidade: string, quando: Data): string {
  return `${cidade}, ${por_extenso(quando)}`;
}

export function numerica(quando: Data): string {
  const [ano, mes, dia] = partes(quando);
  return `${dois(dia)}/${dois(mes)}/${ano}`;
}

const RE_EXTENSO = /(\d{1,2})\s+de\s+([A-Za-zÀ-ÿ]+)\s+de\s+(\d{4})/i;
const RE_NUMERICA = /(\d{1,2})\/(\d{1,2})\/(\d{4})/;
const RE_ISO = /(\d{4})-(\d{2})-(\d{2})/;

export function indice_mes(nome: string): number | null {
  const alvo = sem_acento(nome).trim().toLowerCase();
  for (let i = 0; i < MESES.length; i++) {
    if (sem_acento(MESES[i]!) === alvo) return i + 1;
  }
  return null;
}

/**
 * Aceita '17 de setembro de 2024', '05 DE MARCO DE 2024', '01/05/2026', ISO e
 * o `Date` da planilha. Devolve null quando não reconhece.
 */
export function analisar(texto: unknown): Data | null {
  if (texto === null || texto === undefined) return null;
  if (texto instanceof Date) return data_de_planilha(texto);
  const bruto = String(texto).trim();
  if (!bruto) return null;

  let m = RE_EXTENSO.exec(bruto);
  if (m) {
    const mes = indice_mes(m[2]!);
    if (mes) return montar(Number(m[3]), mes, Number(m[1]));
  }
  m = RE_NUMERICA.exec(bruto);
  if (m) return montar(Number(m[3]), Number(m[2]), Number(m[1]));
  m = RE_ISO.exec(bruto);
  if (m) return montar(Number(m[1]), Number(m[2]), Number(m[3]));
  return null;
}

/**
 * RN-18: a planilha guarda 11/02/2026 00:00.
 *
 * O exceljs entrega a célula de data como `Date` cujo instante UTC é a
 * meia-noite do dia gravado. Ler as partes em UTC é tomar a data literalmente;
 * ler no fuso local (UTC-3) transformaria 11/fev em 10/fev.
 */
export function data_de_planilha(valor: unknown): Data | null {
  if (valor === null || valor === undefined) return null;
  if (valor instanceof Date) {
    if (Number.isNaN(valor.getTime())) return null;
    const [a, m, d] = partes(valor);
    return montar(a, m, d);
  }
  return analisar(String(valor));
}

/** Partes do momento (timestamptz) no fuso de exibição. */
export interface MomentoLocal {
  ano: number;
  mes: number;
  dia: number;
  hora: number;
  minuto: number;
  segundo: number;
}

/** Timestamp UTC do sistema exibido em America/Sao_Paulo. */
export function local(momento: Date | string | null | undefined): MomentoLocal | null {
  if (momento === null || momento === undefined) return null;
  const instante = momento instanceof Date ? momento : new Date(momento);
  if (Number.isNaN(instante.getTime())) return null;
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: FUSO_BR,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const p: Record<string, number> = {};
  for (const parte of fmt.formatToParts(instante)) {
    if (parte.type !== "literal") p[parte.type] = Number(parte.value);
  }
  return {
    ano: p.year!,
    mes: p.month!,
    dia: p.day!,
    hora: p.hour!,
    minuto: p.minute!,
    segundo: p.second!,
  };
}

export function local_formatado(momento: Date | string | null | undefined, com_hora = true): string {
  const dt = local(momento);
  if (!dt) return "";
  const data = `${dois(dt.dia)}/${dois(dt.mes)}/${dt.ano}`;
  return com_hora ? `${data} ${dois(dt.hora)}:${dois(dt.minuto)}` : data;
}

/** A data civil (AAAA-MM-DD) do momento, no fuso de exibição. */
export function data_local(momento: Date | string | null | undefined): Data | null {
  const dt = local(momento);
  return dt ? montar(dt.ano, dt.mes, dt.dia) : null;
}

export function dias_desde(momento: Date | null | undefined, referencia?: Date | null): number {
  if (!momento) return 0;
  const ref = referencia ?? new Date();
  // `timedelta.days` do Python é o piso da divisão
  const dias = Math.floor((ref.getTime() - momento.getTime()) / 86_400_000);
  return Math.max(0, dias);
}

export function meses_entre(inicio: Data, fim: Data): number {
  const [a1, m1] = partes(inicio);
  const [a2, m2] = partes(fim);
  return (a2 - a1) * 12 + (m2 - m1);
}

function dias_no_mes(ano: number, mes: number): number {
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

/**
 * Soma meses a uma data; quando o dia não existe no mês de destino, usa o
 * último dia desse mês.
 *
 * 31/01 + 1 mês não existe, e a escolha entre 28/02 e 03/03 é de negócio, não
 * de aritmética. Aqui o resultado *gruda no último dia do mês de destino*
 * (28/02, ou 29/02 em bissexto): validade de CA, reciclagem de treinamento e
 * previsão de troca de EPI são prazos contados "em meses", e o último dia do
 * mês é o limite daquele mês — não o primeiro do seguinte.
 *
 * Consequência assumida: NÃO é reversível quando houve truncamento.
 * `meses` negativo anda para trás pela mesma regra; zero devolve a data igual.
 */
export function somar_meses(quando: Data, meses: number): Data {
  const [ano0, mes0, dia] = partes(quando);
  const total = mes0 - 1 + meses;
  // `//` e `%` do Python são de piso: o `%` do JS não é, com negativo
  const ano = ano0 + Math.floor(total / 12);
  const mes = (((total % 12) + 12) % 12) + 1;
  return montar(ano, mes, Math.min(dia, dias_no_mes(ano, mes)));
}

export { somar_dias } from "../dominio/datas.js";

// ---------------------------------------------------------------------
// Para os filtros de template: `date` chega como 'AAAA-MM-DD'; timestamptz
// como `Date`. Um `Date` num filtro de DATA é lido no fuso de exibição.
// ---------------------------------------------------------------------
export function comoData(valor: unknown): Data | null {
  if (valor === null || valor === undefined || valor === "") return null;
  if (valor instanceof Date) return data_local(valor);
  const m = RE_ISO.exec(String(valor));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
