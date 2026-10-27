/**
 * Catálogos fechados do módulo de acidentes: 44 partes do corpo, 199 agentes
 * causadores do acidente, 30 agentes da doença e 30 situações geradoras (as
 * listas que o legado trazia), semeados de forma idempotente, com o rótulo
 * corrigido e o texto original preservado em `rotulo_legado`.
 */
import { count } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { bancoLimpo, naTransacao } from "./ajuda";
import {
  acidente_agente_causador,
  acidente_agente_doenca,
  acidente_natureza_lesao,
  acidente_parte_corpo,
  acidente_situacao_geradora,
} from "../src/db/esquema/index";
import {
  AGENTES_CAUSADORES,
  AGENTES_DA_DOENCA,
  NATUREZAS_DA_LESAO,
  PARTES_DO_CORPO,
  SITUACOES_GERADORAS,
  rotulo_com_grupo,
} from "../src/dominio/acidente_catalogos";
import { semear_acidentes } from "../src/servicos/sementes";

const { db } = await bancoLimpo();

const TABELAS = {
  partes: acidente_parte_corpo,
  agentes: acidente_agente_causador,
  doenca: acidente_agente_doenca,
  situacoes: acidente_situacao_geradora,
  naturezas: acidente_natureza_lesao,
};

async function contar() {
  const r: Record<string, number> = {};
  for (const [nome, t] of Object.entries(TABELAS)) {
    const [l] = await db.select({ n: count() }).from(t);
    r[nome] = Number(l!.n);
  }
  return r;
}

describe("catálogos de acidente", () => {
  it("as listas têm 44, 199, 31 e 31 itens (a oficial do Anexo III.2) e a natureza da lesão, 29 (Tabela 17 do eSocial)", async () => {
    expect(PARTES_DO_CORPO).toHaveLength(44);
    expect(AGENTES_CAUSADORES).toHaveLength(199);
    expect(AGENTES_DA_DOENCA).toHaveLength(31);
    expect(SITUACOES_GERADORAS).toHaveLength(31);
    expect(NATUREZAS_DA_LESAO).toHaveLength(29);
    expect(await contar()).toEqual({ partes: 44, agentes: 199, doenca: 31, situacoes: 31, naturezas: 29 });
  });

  it("a natureza da lesão traz código oficial de 9 dígitos, único, e rótulo que cabe na coluna", () => {
    const codigos = NATUREZAS_DA_LESAO.map((n) => n[2]);
    expect(codigos.every((c) => /^\d{9}$/.test(c ?? ""))).toBe(true);
    expect(new Set(codigos).size).toBe(codigos.length);
    expect(NATUREZAS_DA_LESAO.map((n) => n[0])).toEqual(NATUREZAS_DA_LESAO.map((_, i) => i + 1));
    expect(NATUREZAS_DA_LESAO.every((n) => n[1].length > 0 && n[1].length <= 240)).toBe(true);
  });

  it("semear de novo não duplica nada", async () => {
    const antes = await contar();
    await naTransacao((tx) => semear_acidentes(tx));
    await naTransacao((tx) => semear_acidentes(tx));
    expect(await contar()).toEqual(antes);
  });

  it("o rótulo não leva o prefixo 'N. ', e o texto original fica em rotulo_legado", async () => {
    for (const t of [acidente_parte_corpo, acidente_agente_causador, acidente_agente_doenca, acidente_situacao_geradora]) {
      const linhas = await db.select().from(t);
      for (const l of linhas) {
        expect(l.rotulo, `ordem ${l.ordem}`).not.toMatch(/^\d+\.\s/);
        // ordem 0: item da tabela oficial que a planilha antiga não tinha
        if (l.ordem === 0) expect(l.rotulo_legado).toBeNull();
        else expect(l.rotulo_legado, `ordem ${l.ordem}`).toMatch(new RegExp(`^${l.ordem}\\. `));
        expect(l.rotulo.trim()).toBe(l.rotulo);
        expect(l.rotulo.length).toBeGreaterThan(1);
      }
    }
  });

  it("a ordem vai do início ao total, sem buraco, e o rótulo legado não repete", () => {
    for (const lista of [PARTES_DO_CORPO, AGENTES_CAUSADORES, AGENTES_DA_DOENCA, SITUACOES_GERADORAS]) {
      const comeco = lista[0]![0];
      expect(lista.map((i) => i[0])).toEqual(Array.from({ length: lista.length }, (_, i) => i + comeco));
      const legados = lista.map((i) => i[i.length - 1] as string | null).filter((l) => l !== null);
      expect(new Set(legados).size).toBe(legados.length);
    }
  });

  it("traz os itens da tabela oficial do Anexo III.2 que a planilha antiga não tinha", () => {
    expect(AGENTES_DA_DOENCA[0]![1]).toMatch(/^REAÇÃO DO CORPO A SEUS MOVIMENTOS - MOVIMENTO INVOLUNTÁRIO/);
    expect(SITUACOES_GERADORAS[0]![1]).toBe("IMPACTO DE PESSOA CONTRA OBJETO PARADO");
  });

  it("a grafia foi corrigida (sem os erros do legado)", () => {
    const todos = [...PARTES_DO_CORPO, ...AGENTES_CAUSADORES, ...AGENTES_DA_DOENCA, ...SITUACOES_GERADORAS]
      .map((i) => i[1])
      .join("\n");
    for (const erro of ["SUSBSTÂNCIA", "MASARICO", "DESLISANTE", "MULTIPLAS", "INGESTAO", "MANDIBULA"]) {
      expect(todos).not.toContain(erro);
    }
  });

  it("a classe do agente virou grupo, e o rótulo da tela a reconstitui", async () => {
    const linhas = await db.select().from(acidente_agente_causador);
    const com_grupo = linhas.filter((l) => l.grupo);
    expect(com_grupo.length).toBeGreaterThan(100);
    for (const l of com_grupo) expect(l.rotulo).not.toContain(` - ${l.grupo}`);
    const exemplo = com_grupo[0]!;
    expect(rotulo_com_grupo(exemplo)).toBe(`${exemplo.rotulo} - ${exemplo.grupo}`);
    expect(rotulo_com_grupo({ rotulo: "X", grupo: null })).toBe("X");
  });
});
