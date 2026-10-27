/**
 * A tabela de sugestões por família do agente causador é um rascunho de partida
 * que a equipe revisa; o que este teste garante é que ela não tem buraco nem
 * sobreposição sobre a Tabela II (1 a 199) e que só usa tipos de ação que o
 * plano conhece.
 */
import { describe, expect, it } from "vitest";
import { TIPOS_ACAO } from "../src/dominio/acidente.js";
import { AGENTES_CAUSADORES } from "../src/dominio/acidente_catalogos.js";
import { FAMILIAS_DE_AGENTE, familia_do_agente, sugestoes_faltantes } from "../src/dominio/acidente_sugestoes.js";

describe("famílias de agente causador", () => {
  it("cada agente da Tabela II cai em exatamente uma família", () => {
    for (const [ordem] of AGENTES_CAUSADORES) {
      const dentro = FAMILIAS_DE_AGENTE.filter((f) => ordem >= f.de && ordem <= f.ate);
      expect(dentro, `agente ${ordem}`).toHaveLength(1);
    }
  });

  it("as faixas são contíguas, sem buraco e sem sobreposição, e cobrem 1 a 199", () => {
    const faixas = [...FAMILIAS_DE_AGENTE].sort((a, b) => a.de - b.de);
    expect(faixas[0]!.de).toBe(1);
    expect(faixas[faixas.length - 1]!.ate).toBe(Math.max(...AGENTES_CAUSADORES.map((a) => a[0])));
    faixas.forEach((f, i) => {
      expect(f.ate).toBeGreaterThanOrEqual(f.de);
      if (i > 0) expect(f.de).toBe(faixas[i - 1]!.ate + 1);
    });
  });

  it("só sugere tipos de ação que o plano conhece, sem repetir tipo na família", () => {
    for (const f of FAMILIAS_DE_AGENTE) {
      const tipos = f.sugestoes.map((s) => s.tipo);
      expect(f.sugestoes.length, f.codigo).toBeGreaterThan(0);
      expect(new Set(tipos).size, f.codigo).toBe(tipos.length);
      for (const t of tipos) expect(TIPOS_ACAO as readonly string[], f.codigo).toContain(t);
    }
  });

  it("acha a família pelo número e devolve nada para vazio ou fora da tabela", () => {
    expect(familia_do_agente(70)?.codigo).toBe("MAQUINAS");
    expect(familia_do_agente(1)?.codigo).toBe("SUPERFICIES");
    expect(familia_do_agente(199)?.codigo).toBe("MATERIAIS");
    expect(familia_do_agente(null)).toBeNull();
    expect(familia_do_agente(500)).toBeNull();
  });

  it("as faltantes são as que o plano ainda não cobre", () => {
    const f = familia_do_agente(104)!;
    expect(sugestoes_faltantes(f, ["PROCEDIMENTO"]).map((s) => s.tipo)).not.toContain("PROCEDIMENTO");
    expect(sugestoes_faltantes(f, [])).toHaveLength(f.sugestoes.length);
  });
});
