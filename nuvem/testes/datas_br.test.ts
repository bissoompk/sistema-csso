/**
 * CA-04 — datas por extenso sem locale do SO. Porte de
 * `testes/unitarios/test_datas_br.py` e da parte de datas de
 * `test_servicos_diversos.py`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as datas_br from "../src/servicos/datas_br";
import { ambiente } from "../src/web";

describe("datas_br", () => {
  it("ca04 por extenso", () => {
    expect(datas_br.por_extenso("2025-02-11")).toBe("11 de fevereiro de 2025");
  });

  it("ca04 por extenso capitalizado", () => {
    expect(datas_br.por_extenso_capitalizado("2025-02-11")).toBe("11 de Fevereiro de 2025");
  });

  it("não usa Intl com pt-BR nem toLocale* (o setlocale do Python)", () => {
    const fonte = readFileSync(new URL("../src/servicos/datas_br.ts", import.meta.url), "utf8");
    const codigo = fonte
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("*") && !l.trimStart().startsWith("//"));
    expect(codigo.some((l) => /toLocale(Date)?String\(|pt-BR/.test(l))).toBe(false);
  });

  it("março com cedilha", () => {
    expect(datas_br.por_extenso("2024-03-05")).toBe("05 de março de 2024");
    expect(datas_br.por_extenso_capitalizado("2026-02-09")).toBe("09 de Fevereiro de 2026");
  });

  it("numérica", () => {
    expect(datas_br.numerica("2026-05-01")).toBe("01/05/2026");
  });

  it.each([
    ["17 de setembro de 2024", "2024-09-17"],
    ["05 DE MARÇO DE 2024", "2024-03-05"],
    ["09 de Fevereiro de 2026", "2026-02-09"],
    ["12 de novembro de 2024", "2024-11-12"],
    ["01/05/2026", "2026-05-01"],
    ["2026-06-18", "2026-06-18"],
    ["nada disso", null],
  ])("analisar(%s)", (entrada, esperado) => {
    expect(datas_br.analisar(entrada)).toBe(esperado);
  });

  it("rn18: a planilha não desloca o dia", () => {
    // o exceljs entrega 11/02/2026 00:00 como o instante UTC dessa meia-noite
    expect(datas_br.data_de_planilha(new Date(Date.UTC(2026, 1, 11, 0, 0)))).toBe("2026-02-11");
  });

  it("meses entre", () => {
    expect(datas_br.meses_entre("2024-03-05", "2026-05-01")).toBe(26);
  });

  it.each([
    ["2025-01-31", 1, "2025-02-28"],
    ["2024-01-31", 1, "2024-02-29"],
    ["2025-08-31", 6, "2026-02-28"],
    ["2025-03-31", 1, "2025-04-30"],
    ["2024-02-29", 12, "2025-02-28"],
    ["2024-02-29", 48, "2028-02-29"],
    ["2026-05-01", 0, "2026-05-01"],
    ["2024-01-31", 0, "2024-01-31"],
    ["2025-12-01", 1, "2026-01-01"],
    ["2025-12-31", 2, "2026-02-28"],
    ["2025-07-15", 24, "2027-07-15"],
    ["2025-11-30", 13, "2026-12-30"],
    ["2026-03-31", -1, "2026-02-28"],
    ["2026-01-15", -1, "2025-12-15"],
    ["2026-01-31", -12, "2025-01-31"],
    ["2025-03-31", -13, "2024-02-29"],
  ])("somar_meses(%s, %i) = %s", (origem, meses, esperado) => {
    expect(datas_br.somar_meses(origem, meses)).toBe(esperado);
  });

  it("somar_meses não é reversível quando trunca", () => {
    const ida = datas_br.somar_meses("2024-01-31", 1);
    expect(ida).toBe("2024-02-29");
    expect(datas_br.somar_meses(ida, -1)).toBe("2024-01-29");
  });

  it("somar_meses preserva o dia quando ele existe", () => {
    for (let mes = 0; mes < 13; mes++) expect(datas_br.somar_meses("2025-01-15", mes).slice(8)).toBe("15");
  });

  // --- test_servicos_diversos ---
  it("por extenso com cidade", () => {
    expect(datas_br.por_extenso_cidade("Diamantina", "2025-02-11")).toBe("Diamantina, 11 de fevereiro de 2025");
  });

  it("índice do mês aceita acento e caixa", () => {
    expect(datas_br.indice_mes("MARÇO")).toBe(3);
    expect(datas_br.indice_mes("marco")).toBe(3);
    expect(datas_br.indice_mes("brumário")).toBeNull();
  });

  it("analisar aceita Date, nulo e vazio", () => {
    expect(datas_br.analisar(new Date(Date.UTC(2026, 0, 2, 15, 30)))).toBe("2026-01-02");
    expect(datas_br.analisar(null)).toBeNull();
    expect(datas_br.analisar("  ")).toBeNull();
  });

  it("data de planilha com texto e nulo", () => {
    expect(datas_br.data_de_planilha(null)).toBeNull();
    expect(datas_br.data_de_planilha("11/02/2026")).toBe("2026-02-11");
    expect(datas_br.data_de_planilha("2026-02-11")).toBe("2026-02-11");
  });

  it("local e formatado (America/Sao_Paulo)", () => {
    const momento = new Date(Date.UTC(2026, 5, 18, 15, 0));
    expect(datas_br.local(momento)!.hora).toBe(12);
    expect(datas_br.local_formatado(momento)).toBe("18/06/2026 12:00");
    expect(datas_br.local_formatado(null)).toBe("");
    expect(datas_br.local(null)).toBeNull();
    expect(datas_br.local_formatado(momento, false)).toHaveLength(10);
  });

  it("dias desde", () => {
    const agora = new Date(Date.UTC(2026, 5, 18));
    expect(datas_br.dias_desde(null)).toBe(0);
    expect(datas_br.dias_desde(new Date(agora.getTime() - 7 * 86_400_000), agora)).toBe(7);
    expect(datas_br.dias_desde(new Date(agora.getTime() + 3 * 86_400_000), agora)).toBe(0);
  });

  it("hoje é o dia de Diamantina, não o do UTC", () => {
    // 23h30 de 10/02 em Brasília = 02h30 de 11/02 em UTC
    expect(datas_br.hoje(new Date(Date.UTC(2026, 1, 11, 2, 30)))).toBe("2026-02-10");
  });
});

describe("filtros de template", () => {
  const r = (tpl: string, ctx: Record<string, unknown>) => ambiente.renderString(tpl, ctx);
  it("data, data_extenso e momento", () => {
    expect(r("{{ d | data }}", { d: "2026-02-11" })).toBe("11/02/2026");
    expect(r("{{ d | data }}", { d: null })).toBe("");
    expect(r("{{ d | data_extenso }}", { d: "2026-02-11" })).toBe("11 de fevereiro de 2026");
    expect(r("{{ m | momento }}", { m: new Date(Date.UTC(2026, 5, 18, 15, 0)) })).toBe("18/06/2026 12:00");
    expect(r("{{ m | momento }}", { m: null })).toBe("");
  });
});
