/**
 * A máquina de estados da ocorrência de acidente (G): toda aresta declarada
 * passa, toda outra é recusada, e os terminais não têm saída. Não usa banco.
 */
import { describe, expect, it } from "vitest";
import {
  ACIDENTE_CANCELAVEL,
  ACIDENTE_ENCERRADO,
  ESTADOS_ACIDENTE,
  ROTULO_ACIDENTE,
  TRANSICOES_ACIDENTE,
  TransicaoInvalida,
  exigir_transicao_acidente,
} from "../src/dominio/estados";

const VALIDAS: readonly (readonly [string, string])[] = [
  ["RECEBIDA", "EM_TRIAGEM"],
  ["RECEBIDA", "CANCELADA"],
  ["EM_TRIAGEM", "AGUARDANDO_COMPLEMENTACAO"],
  ["EM_TRIAGEM", "EM_INVESTIGACAO"],
  ["EM_TRIAGEM", "CANCELADA"],
  ["AGUARDANDO_COMPLEMENTACAO", "EM_TRIAGEM"],
  ["AGUARDANDO_COMPLEMENTACAO", "CANCELADA"],
  ["EM_INVESTIGACAO", "RELATORIO_EMITIDO"],
  ["RELATORIO_EMITIDO", "ENCAMINHADA_SIASS"],
  ["RELATORIO_EMITIDO", "CONCLUIDA"],
  ["ENCAMINHADA_SIASS", "CONCLUIDA"],
];

describe("máquina de estados da ocorrência de acidente", () => {
  it("cada aresta declarada passa", () => {
    for (const [de, para] of VALIDAS) expect(() => exigir_transicao_acidente(de, para)).not.toThrow();
  });

  it("toda outra combinação é recusada (inclusive ficar no mesmo estado)", () => {
    const validas = new Set(VALIDAS.map(([de, para]) => `${de}>${para}`));
    for (const de of ESTADOS_ACIDENTE) {
      for (const para of ESTADOS_ACIDENTE) {
        if (validas.has(`${de}>${para}`)) continue;
        expect(() => exigir_transicao_acidente(de, para), `${de} -> ${para}`).toThrow(TransicaoInvalida);
      }
    }
  });

  it("a tabela de transições é exatamente a lista acima", () => {
    const declaradas = Object.entries(TRANSICOES_ACIDENTE).flatMap(([de, para]) => [...para].map((p) => `${de}>${p}`));
    expect(declaradas.sort()).toEqual(VALIDAS.map(([de, para]) => `${de}>${para}`).sort());
  });

  it("estado desconhecido não abre porta", () => {
    expect(() => exigir_transicao_acidente("INVENTADO", "CONCLUIDA")).toThrow(TransicaoInvalida);
    expect(() => exigir_transicao_acidente("RECEBIDA", "INVENTADO")).toThrow(TransicaoInvalida);
  });

  it("os terminais (concluída e cancelada) não têm saída; reabrir é ocorrência nova", () => {
    expect([...ACIDENTE_ENCERRADO].sort()).toEqual(["CANCELADA", "CONCLUIDA"]);
    for (const t of ACIDENTE_ENCERRADO) expect(TRANSICOES_ACIDENTE[t]!.size).toBe(0);
  });

  it("só se cancela antes de a investigação começar", () => {
    expect([...ACIDENTE_CANCELAVEL].sort()).toEqual(["AGUARDANDO_COMPLEMENTACAO", "EM_TRIAGEM", "RECEBIDA"]);
    for (const e of ESTADOS_ACIDENTE) {
      const pode_cancelar = TRANSICOES_ACIDENTE[e]!.has("CANCELADA");
      expect(pode_cancelar).toBe(ACIDENTE_CANCELAVEL.has(e));
    }
  });

  it("todo estado tem rótulo, e a mensagem de recusa nomeia a situação", () => {
    for (const e of ESTADOS_ACIDENTE) expect(ROTULO_ACIDENTE[e]).toBeTruthy();
    expect(() => exigir_transicao_acidente("RECEBIDA", "CONCLUIDA")).toThrow(/Recebida/);
  });
});
