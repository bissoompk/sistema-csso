/**
 * Lote 3 (24/11/2026): a carga em HORAS ou TEMPOS — conversão, leitura do digitado, a função única
 * de exibição (T13), a divisão sem perda (T3) e as somas separadas. Sem banco.
 */
import { describe, expect, it } from "vitest";
import * as carga from "../src/dominio/carga.js";
import { carga_do_congelado } from "../src/servicos/certificado.js";
import { excesso_sobre_horario } from "../src/servicos/carga_turma.js";

describe("exibir: a função única", () => {
  it("horas inteiras, uma hora, horas e minutos, só minutos", () => {
    expect(carga.exibir("8", "HORAS")).toBe("8 horas");
    expect(carga.exibir("8.0", "HORAS")).toBe("8 horas");
    expect(carga.exibir("1", "HORAS")).toBe("1 hora");
    expect(carga.exibir("4.5", "HORAS")).toBe("4h30");
    expect(carga.exibir("2.3", "HORAS")).toBe("2h18");
    expect(carga.exibir_base(45, "HORAS")).toBe("45 min");
    expect(carga.exibir_base(135, "HORAS")).toBe("2h15");
  });
  it("tempos nunca saem em horas", () => {
    expect(carga.exibir("10", "TEMPOS")).toBe("10 tempos");
    expect(carga.exibir("1", "TEMPOS")).toBe("1 tempo");
    expect(carga.exibir_base(3, "TEMPOS")).not.toMatch(/h|hora|min/);
  });
  it("sem unidade (dado antigo) é HORAS; vazio é travessão", () => {
    expect(carga.exibir("16", null)).toBe("16 horas");
    expect(carga.exibir(null, "HORAS")).toBe("—");
  });
});

describe("ler: o que se digita", () => {
  it("horas: 8, 4,5, 4.5, 4h30, 4h, 4:30, 0h45, 45 min", () => {
    const casos: [string, number][] = [
      ["8", 480], ["4,5", 270], ["4.5", 270], ["4h30", 270], ["4h", 240], ["4:30", 270], ["0h45", 45], ["45 min", 45], [",5", 30],
    ];
    for (const [t, min] of casos) expect(carga.ler(t, "HORAS"), t).toBe(min);
  });
  it("tempos: só inteiro", () => {
    expect(carga.ler("10", "TEMPOS")).toBe(10);
    expect(() => carga.ler("2,5", "TEMPOS")).toThrow(/número inteiro de tempos/);
    expect(() => carga.ler("2h", "TEMPOS")).toThrow(carga.CargaInvalida);
  });
  it("vazio é nulo; negativo e lixo são recusados com a concordância do rótulo", () => {
    expect(carga.ler("  ", "HORAS")).toBeNull();
    expect(() => carga.ler("-1", "HORAS", "as horas do dia")).toThrow("As horas do dia não podem ser negativas.");
    expect(() => carga.ler("-1", "TEMPOS", "os tempos do dia")).toThrow("Os tempos do dia não podem ser negativos.");
    expect(() => carga.ler("x", "HORAS", "a carga horária")).toThrow("A carga horária é inválida: informe um número.");
    expect(() => carga.ler("4h75", "HORAS")).toThrow(/0 a 59/);
    expect(() => carga.ler("0,01", "HORAS")).toThrow(/minuto inteiro/);
  });
  it("a carga do catálogo ou da turma: maior que zero; em horas, de 6 em 6 minutos (a coluna tem uma casa)", () => {
    expect(carga.ler_carga("4h30", "HORAS")).toBe("4.5");
    expect(carga.ler_carga("8", "HORAS")).toBe("8");
    expect(carga.ler_carga("10", "TEMPOS")).toBe("10");
    expect(() => carga.ler_carga("0", "HORAS")).toThrow(/maior que zero/);
    expect(() => carga.ler_carga("4h20", "HORAS")).toThrow(/6 em 6 minutos/);
  });
});

describe("conversão e divisão sem perda (T3)", () => {
  it("horas da coluna viram minutos inteiros, e voltam", () => {
    expect(carga.para_base("4.5", "HORAS")).toBe(270);
    expect(carga.para_base("2.3", "HORAS")).toBe(138);
    expect(carga.para_base("0.1", "HORAS")).toBe(6);
    expect(carga.de_base(270, "HORAS")).toBe("4.5");
    expect(carga.de_base(480, "HORAS")).toBe("8");
  });
  it("4,5 h em dois dias: 135 + 135 (antes, 2,3 + 2,2); 3 tempos em dois dias: 2 + 1", () => {
    expect(carga.dividir(270, 2)).toEqual([135, 135]);
    expect(carga.dividir(3, 2)).toEqual([2, 1]);
    expect(carga.dividir(10, 3)).toEqual([4, 3, 3]);
  });
  it("quem falta um dos dois dias fica com 50%", () => {
    expect(carga.percentual(135, 270)).toBe("50.00");
  });
  it("o percentual em minutos é o mesmo das horas de antes (mesma razão, mesmo arredondamento)", () => {
    // os valores da turma 0008 do banco de teste: 2,3 h e 2,2 h de 4,5 h
    const antes = (h: number, total: number) => {
      // a conta antiga: horas × 10000 / carga, meio para cima, em centésimos
      const num = BigInt(Math.round(h * 10)) * 10_000n;
      const den = BigInt(Math.round(total * 10));
      let q = num / den;
      if ((num % den) * 2n >= den) q += 1n;
      return `${q / 100n}.${(q % 100n).toString().padStart(2, "0")}`;
    };
    for (const [h, total] of [[2.3, 4.5], [2.2, 4.5], [4.5, 4.5], [5.9, 8], [6, 8], [16, 16], [0.1, 3]] as const) {
      expect(carga.percentual(Math.round(h * 60), Math.round(total * 60)), `${h}/${total}`).toBe(antes(h, total));
    }
  });
});

describe("somas separadas", () => {
  it("horas e tempos nunca se somam", () => {
    const s = carga.somar_por_unidade([
      { base: 480, unidade: "HORAS" },
      { base: 1440, unidade: "HORAS" },
      { base: 10, unidade: "TEMPOS" },
    ]);
    expect(s).toEqual({ HORAS: 1920, TEMPOS: 10 });
    expect(carga.exibir_somas(s)).toBe("32 horas · 10 tempos");
    expect(carga.exibir_somas({ HORAS: 0, TEMPOS: 0 })).toBe("0 horas");
    expect(carga.exibir_somas({ HORAS: 0, TEMPOS: 4 })).toBe("4 tempos");
  });
});

describe("o certificado escreve a carga", () => {
  it("o congelado de antes (sem unidade) sai como sempre saiu", () => {
    expect(carga_do_congelado({ carga_horaria: "4.5" })).toBe("4,5 horas");
    expect(carga_do_congelado({ carga_horaria: "16.0", carga_unidade: null })).toBe("16 horas");
  });
  it("o novo sai pela função única", () => {
    expect(carga_do_congelado({ carga_horaria: "4.5", carga_unidade: "HORAS" })).toBe("4h30");
    expect(carga_do_congelado({ carga_horaria: "10", carga_unidade: "TEMPOS" })).toBe("10 tempos");
  });
});

describe("conferência com o horário (T2)", () => {
  const dois_dias: [string, number][] = [["2026-12-01", 5], ["2026-12-02", 5]];
  it("tempos: 50 minutos por tempo só como régua, e a frase sai em tempos", () => {
    const f = excesso_sobre_horario({ unidade: "TEMPOS", total: 10, por_dia: dois_dias, hora_inicio: "08:00:00", hora_fim: "12:00:00" });
    expect(f).toContain("passa do que o horário comporta");
    expect(f).toContain("cabem 4 tempos por dia");
    expect(f).toContain("2 dias dão 8 tempos");
    expect(f).not.toMatch(/\d+h\d|\bhoras?\b/);
    // das 8h às 12h10 cabem 5 tempos: cabe
    expect(excesso_sobre_horario({ unidade: "TEMPOS", total: 10, por_dia: dois_dias, hora_inicio: "08:00:00", hora_fim: "12:10:00" })).toBeNull();
  });
  it("horas: o total e cada dia", () => {
    const dias: [string, number][] = [["2026-12-01", 135], ["2026-12-02", 135]];
    expect(excesso_sobre_horario({ unidade: "HORAS", total: 270, por_dia: dias, hora_inicio: "08:00:00", hora_fim: "10:15:00" })).toBeNull();
    const total = excesso_sobre_horario({ unidade: "HORAS", total: 300, por_dia: [["2026-12-01", 150], ["2026-12-02", 150]], hora_inicio: "08:00:00", hora_fim: "10:15:00" });
    expect(total).toContain("A carga da turma (5 horas) passa do que o horário comporta: das 8h às 10h15 cabem 2h15 por dia");
    const um_dia = excesso_sobre_horario({ unidade: "HORAS", total: 270, por_dia: [["2026-12-01", 180], ["2026-12-02", 90]], hora_inicio: "08:00:00", hora_fim: "10:15:00" });
    expect(um_dia).toContain("01/12/2026 (3 horas)");
  });
  it("sem horário completo, não há o que conferir", () => {
    expect(excesso_sobre_horario({ unidade: "HORAS", total: 9999, por_dia: dois_dias, hora_inicio: "08:00:00", hora_fim: null })).toBeNull();
  });
});
