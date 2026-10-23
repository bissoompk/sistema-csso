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
  it("as listas têm 44, 199, 30 e 30 itens; a natureza da lesão espera a lista oficial", async () => {
    expect(PARTES_DO_CORPO).toHaveLength(44);
    expect(AGENTES_CAUSADORES).toHaveLength(199);
    expect(AGENTES_DA_DOENCA).toHaveLength(30);
    expect(SITUACOES_GERADORAS).toHaveLength(30);
    expect(NATUREZAS_DA_LESAO).toHaveLength(0);
    expect(await contar()).toEqual({ partes: 44, agentes: 199, doenca: 30, situacoes: 30, naturezas: 0 });
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
        expect(l.rotulo_legado, `ordem ${l.ordem}`).toMatch(new RegExp(`^${l.ordem}\\. `));
        expect(l.rotulo.trim()).toBe(l.rotulo);
        expect(l.rotulo.length).toBeGreaterThan(1);
      }
    }
  });

  it("a ordem vai de 1 ao total, sem buraco, e o rótulo legado não repete", () => {
    for (const lista of [PARTES_DO_CORPO, AGENTES_CAUSADORES, AGENTES_DA_DOENCA, SITUACOES_GERADORAS]) {
      expect(lista.map((i) => i[0])).toEqual(Array.from({ length: lista.length }, (_, i) => i + 1));
      const legados = lista.map((i) => i[i.length - 1] as string);
      expect(new Set(legados).size).toBe(lista.length);
    }
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
