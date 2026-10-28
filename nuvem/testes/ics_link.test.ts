/**
 * O link dentro do .ics do aviso de aceite: a turma divulgada leva à ficha
 * pública, a outra à lista do próprio servidor — nunca a `/turmas/{id}`, que é
 * da equipe e dá 403 para quem recebe.
 */
import { describe, expect, it } from "vitest";
import { link_da_turma } from "../src/servicos/ics.js";

describe("link_da_turma", () => {
  it("turma divulgada: ficha pública", () => {
    expect(link_da_turma("https://sisa.exemplo.br", { codigo: "T-2026-01", divulgada_em: new Date() })).toBe(
      "https://sisa.exemplo.br/cursos/T-2026-01",
    );
  });

  it("turma não divulgada: Meus treinamentos, e a barra final da base não duplica", () => {
    expect(link_da_turma("https://sisa.exemplo.br/", { codigo: "T-2026-01", divulgada_em: null })).toBe(
      "https://sisa.exemplo.br/turmas/minhas",
    );
    expect(link_da_turma("https://sisa.exemplo.br", { codigo: "T-2026-01" })).toBe("https://sisa.exemplo.br/turmas/minhas");
  });
});
