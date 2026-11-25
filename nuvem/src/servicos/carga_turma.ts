/**
 * A carga da turma dia a dia e a conferência com o horário (lote 3, 24/11/2026).
 *
 * - **Carga por dia** (`turma_carga_dia`), na unidade-base da turma (minutos em HORAS, tempos em
 *   TEMPOS). A turma em TEMPOS sempre a tem gravada: quem abre a turma informa quantos tempos tem
 *   cada dia, e a divisão automática é só o valor inicial do formulário. A de HORAS só grava quando
 *   o dia não é a divisão automática. A soma tem de ser igual à carga da turma.
 * - **Limite do dia** (T5): a presença de um dia não passa da carga daquele dia.
 * - **Conferência com o horário** (T2): com hora de início e de término, a carga não passa de
 *   dias × duração do dia, nem um dia passa da duração. Em TEMPOS a conta usa 50 minutos por tempo,
 *   só para comparar — a frase sai em tempos. Acima do limite, só com justificativa.
 */
import { eq } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import { turma_carga_dia as tabela_carga_dia } from "../db/esquema/index.js";
import * as carga from "../dominio/carga.js";
import type { Unidade } from "../dominio/carga.js";
import { Turma as T } from "../dominio/treinamento.js";
import * as auditoria from "./auditoria.js";
import * as datas_br from "./datas_br.js";
import type { UsuarioAtual } from "./rbac.js";
import * as textos from "./textos.js";
import { RegraDaTurma, type TurmaCarregada } from "./turma.js";

export const TURMA_CARGA_POR_DIA = "TURMA_CARGA_POR_DIA";

/** Os dias corridos entre início e fim. */
export function dias(turma: { data_inicio: string; data_fim: string }): string[] {
  const saida: string[] = [];
  for (let d = turma.data_inicio; d <= turma.data_fim; d = datas_br.somar_dias(d, 1)) saida.push(d);
  return saida;
}

/** A divisão automática da carga pelos dias, na unidade-base. */
export function automatica(turma: { data_inicio: string; data_fim: string }, total: number): [string, number][] {
  const ds = dias(turma);
  const partes = carga.dividir(total, ds.length);
  return ds.map((d, i) => [d, partes[i]!]);
}

/**
 * A carga de cada dia: a gravada, quando cobre exatamente os dias da turma e soma a carga; senão,
 * a divisão automática (turma antiga, ou datas mudadas sem a carga por dia refeita).
 */
export function carga_por_dia(turma: TurmaCarregada): [string, number][] {
  const total = T.carga_base(turma);
  const ds = dias(turma);
  const gravadas = turma.carga_dias ?? [];
  if (gravadas.length === ds.length) {
    const mapa = new Map(gravadas.map((c) => [c.data, c.quantidade]));
    const soma = gravadas.reduce((s, c) => s + c.quantidade, 0);
    if (soma === total && ds.every((d) => mapa.has(d))) return ds.map((d) => [d, mapa.get(d)!]);
  }
  return automatica(turma, total);
}

/** A carga daquele dia, na unidade-base (0 quando o dia não é da turma). */
export function carga_do_dia(turma: TurmaCarregada, dia: string): number {
  return carga_por_dia(turma).find(([d]) => d === dia)?.[1] ?? 0;
}

/** "08:00:00" a "12:30:00" -> 270. `null` sem os dois horários. */
export function minutos_do_horario(hora_inicio: string | null | undefined, hora_fim: string | null | undefined): number | null {
  if (!hora_inicio || !hora_fim) return null;
  const min = (h: string) => {
    const [hh = "0", mm = "0"] = h.split(":");
    return Number(hh) * 60 + Number(mm);
  };
  const d = min(hora_fim) - min(hora_inicio);
  return d > 0 ? d : null;
}

/** O que cabe num dia do horário, na unidade da turma: "4 tempos", "4h30". */
function cabe_no_dia(minutos: number, unidade: Unidade): number {
  return unidade === "TEMPOS" ? Math.floor(minutos / carga.MINUTOS_POR_TEMPO) : minutos;
}

/**
 * T2: a carga cabe no horário? Devolve a frase do excesso, ou `null` quando cabe (ou a turma não
 * tem horário completo). Em TEMPOS, a frase fala em tempos — os 50 minutos são só a régua.
 */
export function excesso_sobre_horario(d: {
  unidade: Unidade;
  total: number;
  por_dia: ReadonlyArray<[string, number]>;
  hora_inicio: string | null | undefined;
  hora_fim: string | null | undefined;
}): string | null {
  const duracao = minutos_do_horario(d.hora_inicio, d.hora_fim);
  if (duracao === null) return null;
  const n = d.por_dia.length;
  const por_dia_cabe = cabe_no_dia(duracao, d.unidade);
  const limite = por_dia_cabe * n;
  const horario = `${hora_curta(d.hora_inicio!)} às ${hora_curta(d.hora_fim!)}`;
  const regua = d.unidade === "TEMPOS" ? ` (a ${carga.MINUTOS_POR_TEMPO} minutos por tempo)` : "";
  if (d.total > limite) {
    return (
      `A carga da turma (${carga.exibir_base(d.total, d.unidade)}) passa do que o horário comporta: ` +
      `das ${horario} cabem ${carga.exibir_base(por_dia_cabe, d.unidade)} por dia${regua}, ` +
      `e ${n} ${n === 1 ? "dia dá" : "dias dão"} ${carga.exibir_base(limite, d.unidade)}.`
    );
  }
  const acima = d.por_dia.filter(([, q]) => q > por_dia_cabe);
  if (acima.length) {
    const lista = acima.map(([dia, q]) => `${datas_br.numerica(dia)} (${carga.exibir_base(q, d.unidade)})`).join(", ");
    return (
      `A carga de ${acima.length === 1 ? "um dia passa" : "alguns dias passa"} do que o horário comporta ` +
      `(${carga.exibir_base(por_dia_cabe, d.unidade)} das ${horario}${regua}): ${lista}.`
    );
  }
  return null;
}

/** Recusa o excesso sem justificativa; devolve a justificativa limpa (ou `null`). */
export function exigir_justificativa_do_excesso(
  excesso: string | null,
  justificativa: string | null | undefined,
): string | null {
  const limpa = textos.exigir_texto_limpo((justificativa ?? "").trim(), "justificativa da carga") || null;
  if (excesso !== null && limpa === null) {
    throw new RegraDaTurma(`${excesso} Confira a carga e o horário, ou escreva a justificativa da carga.`);
  }
  return limpa;
}

/**
 * Confere a carga por dia digitada: cobre exatamente os dias, cada dia é inteiro e não negativo,
 * e a soma é a carga. Devolve na ordem dos dias.
 */
export function conferir_por_dia(
  turma: { data_inicio: string; data_fim: string },
  unidade: Unidade,
  total: number,
  mapa: ReadonlyMap<string, number>,
): [string, number][] {
  const ds = dias(turma);
  const faltando = ds.filter((d) => !mapa.has(d));
  if (faltando.length) {
    throw new RegraDaTurma(`Informe a carga de cada dia da turma: falta ${faltando.map(datas_br.numerica).join(", ")}.`);
  }
  const fora = [...mapa.keys()].filter((d) => !ds.includes(d));
  if (fora.length) throw new RegraDaTurma(`${fora.map(datas_br.numerica).join(", ")} não é dia da turma.`);
  const lista = ds.map((d): [string, number] => [d, mapa.get(d)!]);
  for (const [d, q] of lista) {
    if (!Number.isInteger(q) || q < 0) {
      throw new RegraDaTurma(`A carga de ${datas_br.numerica(d)} tem de ser ${unidade === "TEMPOS" ? "um número inteiro de tempos" : "zero ou mais"}.`);
    }
  }
  const soma = lista.reduce((s, [, q]) => s + q, 0);
  if (soma !== total) {
    const conta = lista.map(([, q]) => (unidade === "TEMPOS" ? String(q) : carga.para_campo(q, unidade))).join(" + ");
    throw new RegraDaTurma(
      `A soma dos dias (${conta} = ${carga.exibir_base(soma, unidade)}) tem de ser igual à carga da turma ` +
        `(${carga.exibir_base(total, unidade)}).`,
    );
  }
  return lista;
}

/**
 * Grava a carga por dia (já conferida). Em HORAS, a divisão automática não ocupa linha. A trilha
 * registra quando muda. `presencas_por_dia` (o maior lançamento de cada dia) impede deixar um dia
 * abaixo do que já foi lançado nele.
 */
export async function gravar_por_dia(
  tx: Executor,
  usuario: UsuarioAtual,
  turma: TurmaCarregada,
  lista: [string, number][],
  opcoes: {
    presencas_por_dia?: ReadonlyMap<string, number>;
    comentario?: string | null;
    /** a carga por dia de antes, quando a turma em memória já tem as datas novas */
    antes?: [string, number][];
  } = {},
): Promise<void> {
  const unidade = T.unidade(turma);
  for (const [d, q] of lista) {
    const lancado = opcoes.presencas_por_dia?.get(d) ?? 0;
    if (lancado > q) {
      throw new RegraDaTurma(
        `Em ${datas_br.numerica(d)} já há presença lançada de ${carga.exibir_base(lancado, unidade)}: ` +
          `a carga do dia não pode ficar abaixo disso (${carga.exibir_base(q, unidade)}). Corrija a presença antes.`,
      );
    }
  }
  const antes = opcoes.antes ?? carga_por_dia(turma);
  const auto = automatica(turma, lista.reduce((s, [, q]) => s + q, 0));
  const igual_auto = lista.every(([, q], i) => auto[i]![1] === q);
  const grava = unidade === "TEMPOS" || !igual_auto;
  await tx.delete(tabela_carga_dia).where(eq(tabela_carga_dia.turma_id, turma.id));
  turma.carga_dias = [];
  if (grava && lista.length) {
    turma.carga_dias = await tx
      .insert(tabela_carga_dia)
      .values(lista.map(([data, quantidade]) => ({ turma_id: turma.id, data, quantidade })))
      .returning();
  }
  const texto = (l: ReadonlyArray<[string, number]>) =>
    l.map(([d, q]) => `${datas_br.numerica(d)}: ${carga.exibir_base(q, unidade)}`).join("; ");
  const mudou = antes.length !== lista.length || antes.some(([d, q], i) => lista[i]![0] !== d || lista[i]![1] !== q);
  if (mudou) {
    await auditoria.registrar(tx, {
      entidade: "turma",
      entidade_id: turma.id,
      tipo_evento: TURMA_CARGA_POR_DIA,
      descricao: `${turma.codigo}: carga por dia — ${texto(lista)}` + (antes.length ? ` (antes: ${texto(antes)})` : ""),
      comentario: opcoes.comentario ?? null,
      usuario,
    });
  }
}

/** O maior lançamento de cada dia entre os inscritos (para não deixar o dia abaixo dele). */
export function maior_lancamento_por_dia(
  inscricoes: ReadonlyArray<{ presencas: ReadonlyArray<{ data: string; presente: boolean; quantidade: number }> }>,
): Map<string, number> {
  const saida = new Map<string, number>();
  for (const i of inscricoes) {
    for (const p of i.presencas) {
      if (p.presente && p.quantidade > (saida.get(p.data) ?? 0)) saida.set(p.data, p.quantidade);
    }
  }
  return saida;
}

/** Lê a carga por dia do formulário (`carga_dia_AAAA-MM-DD`). Vazio em todos = `null`. */
export function ler_do_formulario(
  turma: { data_inicio: string; data_fim: string },
  unidade: Unidade,
  campo: (nome: string) => string,
): Map<string, number> | null {
  const mapa = new Map<string, number>();
  let algum = false;
  for (const d of dias(turma)) {
    const bruto = campo(`carga_dia_${d}`);
    if (bruto.trim()) algum = true;
    try {
      const q = carga.ler(bruto, unidade, `a carga de ${datas_br.numerica(d)}`);
      mapa.set(d, q ?? 0);
    } catch (e) {
      if (e instanceof carga.CargaInvalida) throw new RegraDaTurma(e.message);
      throw e;
    }
  }
  return algum ? mapa : null;
}

function hora_curta(hora: string): string {
  const [h, m] = hora.split(":");
  return `${Number(h)}h${m && m !== "00" ? m : ""}`;
}
