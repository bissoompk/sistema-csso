import { describe, expect, it } from "vitest";
import { CAMPOS_CERTIFICADO, SUGESTOES_NR35, sugerir_campo, sugerir_campo_da_turma } from "../src/servicos/certificado.js";

const marcador = (m: string) => ({ marcador: m, rotulo: m, antes: "", depois: "", ocorrencia: 1 });

describe("sugestões do modelo de NR-35", () => {
  it("todo marcador do mapa aponta para um campo que existe", () => {
    for (const campo of Object.values(SUGESTOES_NR35)) expect(CAMPOS_CERTIFICADO[campo]).toBeDefined();
  });

  it("acerta o dado que o semelhança de nomes errava", () => {
    expect(sugerir_campo(marcador("DATA_REALIZACAO"))).toBe("turma_periodo_extenso");
    expect(sugerir_campo(marcador("DATA_RECICLAGEM"))).toBe("certificado_data_vencimento");
    expect(sugerir_campo(marcador("INSTRUTOR_QUALIFICACAO"))).toBe("instrutor_titulo");
    expect(sugerir_campo(marcador("RT_NOME"))).toBe("assinante_nome");
    expect(sugerir_campo(marcador("RT_QUALIFICACAO"))).toBe("assinante_titulo");
    expect(sugerir_campo(marcador("CODIGO_VERIFICACAO"))).toBe("certificado_chave");
  });

  it("horas por tema vão para campo da turma, sem dado do sistema", () => {
    for (const m of ["H_TEO_A", "H_PRA_G", "H_TEO_TOT", "H_PRA_TOT", "H_AVALIACAO"]) {
      expect(sugerir_campo(marcador(m))).toBeNull();
      expect(sugerir_campo_da_turma(m)).toBeTruthy();
    }
    expect(sugerir_campo_da_turma("H_TEO_A")).toContain("teoria");
    expect(sugerir_campo_da_turma("CARGO")).toBeNull();
  });
});
