/**
 * A carga do treinamento em HORAS ou em TEMPOS (lote 3, 24/11/2026).
 *
 * - A carga do catálogo e a da turma continuam na coluna `carga_horaria_horas`, que passa a
 *   significar "quantidade na unidade do treinamento": 8 (horas) ou 10 (tempos).
 * - A presença do dia é um INTEIRO na unidade-base: MINUTOS para HORAS, TEMPOS para TEMPOS. Sem
 *   décimo de hora, sem perda: 4,5 h são 270 min, que dão 135 + 135.
 * - Os 50 minutos por tempo servem SÓ para conferir a carga com o horário da turma. Nada em tempos
 *   é gravado nem exibido em horas.
 * - Toda tela, mensagem, documento e trilha mostra a carga por `exibir` / `exibir_base`. Um teste
 *   (`carga_exibicao_unica.test.ts`) varre o código e os modelos e falha se alguém escrever "h" ou
 *   "horas" ao lado da carga sem passar por aqui.
 */

export type Unidade = "HORAS" | "TEMPOS";
export const UNIDADES: readonly Unidade[] = ["HORAS", "TEMPOS"];
export const ROTULO_UNIDADE: Readonly<Record<Unidade, string>> = { HORAS: "Horas", TEMPOS: "Tempos" };

/** Só para comparar a carga em tempos com o horário da turma; nunca gravado nem exibido. */
export const MINUTOS_POR_TEMPO = 50;

export class CargaInvalida extends Error {}

export function unidade_de(valor: string | null | undefined): Unidade {
  return valor === "TEMPOS" ? "TEMPOS" : "HORAS";
}

/** '4.5' (horas) -> 270; '10' (tempos) -> 10. A coluna tem uma casa: 0,1 h = 6 min, sempre inteiro. */
export function para_base(carga: string | number | null | undefined, unidade: Unidade): number {
  if (carga === null || carga === undefined || carga === "") return 0;
  const [inteira = "0", fracao = ""] = String(carga).trim().split(".");
  if (unidade === "TEMPOS") return Number(inteira);
  const decimos = Number(inteira) * 10 + Number((fracao + "0").slice(0, 1));
  return decimos * 6;
}

/** O inverso, para gravar a carga de HORAS na coluna de uma casa: 270 -> '4.5'. */
export function de_base(base: number, unidade: Unidade): string {
  if (unidade === "TEMPOS") return String(base);
  const decimos = Math.round(base / 6);
  return decimos % 10 === 0 ? String(decimos / 10) : `${Math.trunc(decimos / 10)}.${decimos % 10}`;
}

/** Minutos de relógio que a quantidade ocupa — só para conferir com o horário. */
export function minutos_de_relogio(base: number, unidade: Unidade): number {
  return unidade === "TEMPOS" ? base * MINUTOS_POR_TEMPO : base;
}

/** "8 horas", "1 hora", "4h30", "45 min"; "10 tempos", "1 tempo". */
export function exibir_base(base: number, unidade: Unidade): string {
  if (unidade === "TEMPOS") return `${base} ${base === 1 ? "tempo" : "tempos"}`;
  const h = Math.trunc(base / 60);
  const m = base % 60;
  if (m === 0) return `${h} ${h === 1 ? "hora" : "horas"}`;
  if (h === 0) return `${m} min`;
  return `${h}h${String(m).padStart(2, "0")}`;
}

/** A carga do catálogo ou da turma, como sai em toda tela e documento. */
export function exibir(carga: string | number | null | undefined, unidade: Unidade | string | null | undefined): string {
  if (carga === null || carga === undefined || carga === "") return "—";
  const u = unidade_de(unidade as string);
  return exibir_base(para_base(carga, u), u);
}

/** O valor curto que vai dentro de um campo de digitação: "4h30", "8", "3". */
export function para_campo(base: number, unidade: Unidade): string {
  if (unidade === "TEMPOS") return String(base);
  const h = Math.trunc(base / 60);
  const m = base % 60;
  return m === 0 ? String(h) : `${h}h${String(m).padStart(2, "0")}`;
}

/**
 * O que se digita, na unidade-base. HORAS aceita "8", "4,5", "4.5", "4h30", "4h", "4:30", "0h45"
 * e "45 min"; TEMPOS aceita só inteiro. `null` quando vazio. Lança `CargaInvalida` com a frase
 * para a tela.
 */
export function ler(texto: string | null | undefined, unidade: Unidade, o_que = "a carga"): number | null {
  const t = (texto ?? "").trim().toLowerCase().replace(/\s+/g, "");
  if (!t) return null;
  if (/^-/.test(t)) throw new CargaInvalida(`${capitaliza(o_que)} ${concorda(o_que, "não pode ser negativo", "não pode ser negativa", "não podem ser negativos", "não podem ser negativas")}.`);
  if (unidade === "TEMPOS") {
    if (!/^\d+$/.test(t)) {
      throw new CargaInvalida(`${capitaliza(o_que)} ${concorda(o_que, "é inválido", "é inválida", "são inválidos", "são inválidas")}: informe um número inteiro de tempos.`);
    }
    return Number(t);
  }
  let m = /^(\d+)(?:h|:)(\d{1,2})?(?:min)?$/.exec(t);
  if (m) {
    const min = Number(m[2] ?? "0");
    if (min >= 60) throw new CargaInvalida(`Em ${o_que}, os minutos vão de 0 a 59.`);
    return Number(m[1]) * 60 + min;
  }
  m = /^(\d+)min$/.exec(t);
  if (m) return Number(m[1]);
  m = /^(\d*)(?:[.,](\d+))?$/.exec(t);
  if (m && (m[1] || m[2])) {
    // horas decimais: só o que dá minuto inteiro (0,25 h = 15 min; 0,1 h = 6 min)
    const num = Number(`${m[1] || "0"}.${m[2] ?? "0"}`) * 60;
    const arred = Math.round(num);
    if (Math.abs(num - arred) > 1e-9) {
      throw new CargaInvalida(`${capitaliza(o_que)} em horas não dá minuto inteiro: escreva como 4h30.`);
    }
    return arred;
  }
  throw new CargaInvalida(
    `${capitaliza(o_que)} ${concorda(o_que, "é inválido", "é inválida", "são inválidos", "são inválidas")}: informe um número. ` +
      "Em horas, vale 8, 4,5 ou 4h30.",
  );
}

/** A concordância pelo artigo do rótulo ("a carga", "as horas do dia", "os tempos do dia"). */
function concorda(rotulo: string, o: string, a: string, os: string, as: string): string {
  const artigo = rotulo.trim().split(" ")[0]!.toLowerCase();
  return ({ o, a, os, as } as Record<string, string>)[artigo] ?? a;
}

/**
 * A carga do CATÁLOGO ou da TURMA digitada: na unidade, e já no texto da coluna de uma casa.
 * Em HORAS, só múltiplos de 6 minutos cabem na coluna (0,1 h).
 */
export function ler_carga(texto: string | null | undefined, unidade: Unidade): string | null {
  const base = ler(texto, unidade, unidade === "TEMPOS" ? "a carga em tempos" : "a carga horária");
  if (base === null) return null;
  if (base <= 0) throw new CargaInvalida("A carga tem de ser maior que zero.");
  if (unidade === "HORAS" && base % 6 !== 0) {
    throw new CargaInvalida("A carga em horas vai de 6 em 6 minutos (um décimo de hora): 4h30 cabe; 4h20, não.");
  }
  return de_base(base, unidade);
}

/** A divisão automática pelos dias, na unidade-base: a sobra vai para os primeiros dias. */
export function dividir(total: number, dias: number): number[] {
  if (dias <= 0) return [];
  const parte = Math.trunc(total / dias);
  const sobra = total % dias;
  return Array.from({ length: dias }, (_, i) => parte + (i < sobra ? 1 : 0));
}

/** Somas separadas por unidade: "32 horas · 10 tempos" (horas e tempos nunca se somam). */
export function somar_por_unidade(itens: ReadonlyArray<{ base: number; unidade: Unidade }>): Record<Unidade, number> {
  const soma: Record<Unidade, number> = { HORAS: 0, TEMPOS: 0 };
  for (const i of itens) soma[i.unidade] += i.base;
  return soma;
}

export function exibir_somas(soma: Record<Unidade, number>): string {
  const partes: string[] = [];
  if (soma.HORAS > 0) partes.push(exibir_base(soma.HORAS, "HORAS"));
  if (soma.TEMPOS > 0) partes.push(exibir_base(soma.TEMPOS, "TEMPOS"));
  return partes.length ? partes.join(" · ") : exibir_base(0, "HORAS");
}

/** Percentual de `parte` sobre `total`, duas casas, meio para cima — a regra de `frequencia_de`. */
export function percentual(parte: number, total: number): string {
  if (total <= 0) return "0.00";
  const num = BigInt(parte) * 10_000n;
  const den = BigInt(total);
  let q = num / den;
  if ((num % den) * 2n >= den) q += 1n;
  return `${q / 100n}.${(q % 100n).toString().padStart(2, "0")}`;
}

function capitaliza(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
