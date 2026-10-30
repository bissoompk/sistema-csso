/**
 * A lista de presença v3: A4 em retrato, uma coluna de assinatura por dia
 * (até 5), linhas em branco, observações e rodapé com a página.
 */
import PizZip from "pizzip";
import { describe, expect, it } from "vitest";
import * as documento from "../src/servicos/documento.js";
import * as lista from "../src/servicos/lista_presenca.js";

const contexto = (dias: string[]): Record<string, unknown> => ({
  ...Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`d${i + 1}`, dias[i] ?? ""])),
  horario: "08:00 às 12:00",
  extras: [{ ordem: 3, nome: "", identificador: "", vinculo: "" }],
  setor_sigla: "CSSO/Sisa",
  setor_nome: "Coordenadoria de Segurança e Saúde Ocupacional",
  cidade: "Diamantina",
  turma_codigo: "TUR-2026-0001",
  treinamento: "Brigada & <Incêndio>",
  periodo: "30/10/2026",
  carga_horaria: "8,3 horas",
  local: "Auditório",
  campus: "Campus JK",
  unidade_promotora: "CSSO",
  instrutores: "Instrutor de Teste — Técnico",
  frequencia_minima: "75%",
  nota_minima: "7",
  participantes: [
    { ordem: 1, nome: "Ana Ção", identificador: "PTC-1", vinculo: "Servidor" },
    { ordem: 2, nome: "Bia", identificador: "PTC-2", vinculo: "Externo" },
  ],
  total: 2,
  gerada_em: "30/10/2026",
});

describe("lista de presença v3", () => {
  it.each([1, 2, 3, 4, 5])("d%i: A4 retrato, rodapé com página e texto sem sobra de tag", async (n) => {
    const dias = ["30/10", "31/10", "01/11", "02/11", "03/11"].slice(0, n);
    const r = await documento.renderizar_modelo(lista.modelo_da_turma(n), contexto(dias));
    const zip = new PizZip(r.bytes);
    const xml = zip.file("word/document.xml")!.asText();
    expect(xml).toContain('w:w="11906" w:h="16838"');
    expect(xml).not.toContain("landscape");
    expect(xml.match(/<w:gridCol /g)!.length).toBe(4 + (4 + n) + 1 + 3); // dados, presença, observações, assinaturas
    expect(zip.file("word/footer1.xml")!.asText()).toMatch(/NUMPAGES/);
    expect(zip.file("word/footer1.xml")!.asText()).toContain("TUR-2026-0001");
    const texto = documento.extrair_texto(r.bytes);
    for (const t of ["LISTA DE PRESENÇA", "Brigada & <Incêndio>", "Ana Ção", "08:00 às 12:00", "Observações", "Responsável pela CSSO"]) {
      expect(texto).toContain(t);
    }
    for (const d of dias) expect(texto).toContain(d);
    expect(texto).not.toMatch(/[{}]/);
  });

  it("escolhe o modelo pela quantidade de dias, com teto de 5", () => {
    expect(lista.modelo_da_turma(0)).toBe("lista_presenca_v3_d1.docx");
    expect(lista.modelo_da_turma(3)).toBe("lista_presenca_v3_d3.docx");
    expect(lista.modelo_da_turma(12)).toBe("lista_presenca_v3_d5.docx");
  });

  it("lista os dias de data_inicio a data_fim", () => {
    expect(lista.dias_da_turma({ data_inicio: "2026-10-30", data_fim: "2026-10-30" })).toEqual(["30/10"]);
    expect(lista.dias_da_turma({ data_inicio: "2026-10-30", data_fim: "2026-11-02" })).toEqual(["30/10", "31/10", "01/11", "02/11"]);
  });
});
