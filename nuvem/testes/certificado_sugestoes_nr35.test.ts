import { describe, expect, it } from "vitest";
import { CAMPOS_CERTIFICADO, SUGESTOES_NR35, campo_de_marca, sugerir_campo, sugerir_campo_da_turma } from "../src/servicos/certificado.js";

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

  it("as três caixas de modalidade imprimem X só no tipo da turma e não bloqueiam", () => {
    expect(sugerir_campo(marcador("MOD_INICIAL"))).toBe("turma_marca_inicial");
    expect(sugerir_campo(marcador("MOD_PERIODICO"))).toBe("turma_marca_periodico");
    expect(sugerir_campo(marcador("MOD_EVENTUAL"))).toBe("turma_marca_eventual");
    const saida = (tipo: string | null) =>
      ["turma_marca_inicial", "turma_marca_periodico", "turma_marca_eventual"].map((k) =>
        CAMPOS_CERTIFICADO[k]!.obter({ turma_tipo_capacitacao: tipo } as never),
      );
    expect(saida("PERIODICO")).toEqual(["", "X", ""]);
    expect(saida("INICIAL")).toEqual(["X", "", ""]);
    expect(saida(null)).toEqual(["", "", ""]);
    expect(campo_de_marca("turma_marca_eventual")).toBe(true);
    expect(campo_de_marca("turma_local")).toBe(false);
  });

  it("a nota final sem o símbolo serve ao modelo que já imprime o %", () => {
    expect(sugerir_campo(marcador("NOTA_FINAL"))).toBe("nota_final_percentual_numero");
    const campo = CAMPOS_CERTIFICADO.nota_final_percentual_numero!;
    expect(campo.obter({ nota_final: "9.5" } as never)).toBe("95");
    expect(campo.obter({ nota_final: null } as never)).toBe("");
  });
});
