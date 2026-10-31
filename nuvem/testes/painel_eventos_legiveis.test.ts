/**
 * "Últimos eventos" do Painel: a descrição crua do Python vira frase, e os
 * eventos seguidos e iguais viram uma linha só, com a contagem.
 */
import { describe, expect, it } from "vitest";
import { agrupar_repetidos } from "../src/rotas/painel.js";
import { alteracao_da_descricao } from "../src/servicos/trilha_tela.js";

describe("alteracao_da_descricao", () => {
  it("None e aspas do repr saem da frase", () => {
    expect(alteracao_da_descricao("icone_setor: None -> 'person-badge'")).toBe("Ícone do setor: person-badge");
    expect(alteracao_da_descricao("cor_setor: 'azul' -> None")).toBe("Cor do setor: azul → (vazio)");
  });

  it("id e texto longo viram só o fato; outra forma volta como veio", () => {
    expect(alteracao_da_descricao("unidade_promotora_id: None -> 11")).toBe("Unidade promotora: preenchido");
    expect(alteracao_da_descricao("Segunda via do certificado CSSO-1")).toBe("Segunda via do certificado CSSO-1");
    expect(alteracao_da_descricao(null)).toBe("");
  });
});

describe("agrupar_repetidos", () => {
  const ev = (d: string, u = "A", t = "X") => ({ tipo_evento: t, descricao_tela: d, usuario_nome: u });

  it("junta só os vizinhos iguais, do mesmo autor", () => {
    const r = agrupar_repetidos([ev("a"), ev("a"), ev("a"), ev("b"), ev("a"), ev("a", "B")]);
    expect(r.map((e) => [e.descricao_tela, e.usuario_nome, e.repeticoes])).toEqual([
      ["a", "A", 3],
      ["b", "A", 1],
      ["a", "A", 1],
      ["a", "B", 1],
    ]);
  });
});
