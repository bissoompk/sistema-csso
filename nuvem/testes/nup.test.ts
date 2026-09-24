/**
 * NUP (CA-08) e as regras puras da carga do Trello.
 * Porte de `unitarios/test_nup.py`, `test_cartao_nao_processo.py`,
 * `test_depara_listas.py` e da parte pura de `test_separacao_backlog.py`.
 */
import { describe, expect, it } from "vitest";
import * as nup from "../src/servicos/nup.js";
import {
  DEPARA_LISTAS,
  DIAS_PARA_HISTORICO,
  _e_cartao_de_processo,
  _mapear_lista,
  classificar_backlog,
} from "../src/servicos/importacao_trello.js";
import { ESTADOS_PROCESSO } from "../src/dominio/estados.js";
import { somar_dias } from "../src/dominio/datas.js";

const NUPS_REAIS = [
  "23086.000608/2026-84", "23086.000540/2026-33", "23086.055766/2024-18", "23086.002365/2016-47",
  "23086.002359/2011-85", "23086.021284/2024-56", "23086.003498/2015-50", "23086.003496/2015-61",
  "23086.140575/2025-23", "23086.140572/2025-90", "23086.140267/2025-06", "23086.138170/2025-25",
  "23086.009245/2026-42", "23086.005413/2026-21", "23086.008530/2026-46", "23086.001198/2008-15",
];
// Estes quatro provam que a variante genérica de módulo 11 não foi usada.
const PROVAM_A_REGRA_ESPECIFICA = [
  "23086.055766/2024-18", "23086.003496/2015-61", "23086.005413/2026-21", "23086.001198/2008-15",
];

function dv_variante_generica(base15: string): string {
  const digito = (base: string, peso: number) => {
    let soma = 0;
    for (let i = 0; i < base.length; i++) soma += Number(base[i]) * (peso - i);
    const resto = soma % 11;
    return resto === 0 || resto === 1 ? 0 : 11 - resto;
  };
  const d1 = digito(base15, 16);
  return `${d1}${digito(base15 + d1, 17)}`;
}

describe("NUP (CA-08)", () => {
  it.each(NUPS_REAIS)("DV de %s", (v) => expect(nup.validar(v).valido).toBe(true));
  it("todos os dezesseis", () => expect(NUPS_REAIS.filter((v) => nup.validar(v).valido).length).toBe(16));
  it.each(PROVAM_A_REGRA_ESPECIFICA)("a variante genérica erraria %s", (v) => {
    const d = v.replace(/[./-]/g, "");
    expect(dv_variante_generica(d.slice(0, 15))).not.toBe(d.slice(15));
  });
  it("normaliza colagem", () => {
    expect(nup.normalizar("23086 021284 2024 56")).toBe("23086.021284/2024-56");
    expect(nup.normalizar("23086021284202456")).toBe("23086.021284/2024-56");
  });
  it("formato inválido não é válido", () => {
    const r = nup.validar("2308.21284/2024-56");
    expect(r.formato_ok).toBe(false);
    expect(r.valido).toBe(false);
  });
  it("DV inválido é aviso não bloqueante", () => {
    const r = nup.validar("23086.021284/2024-99");
    expect(r.formato_ok).toBe(true);
    expect(r.dv_ok).toBe(false);
    expect(r.aviso ?? "").toContain("dígito verificador");
  });
  it("extrai de texto livre", () => {
    expect(nup.extrair("Processo 23086.003498/2015-50 e tambem 23086.002359/2011-85.")).toEqual([
      "23086.003498/2015-50",
      "23086.002359/2011-85",
    ]);
  });
  it("NUP vazio e contagem de dígitos com a mensagem do Python", () => {
    expect(nup.validar("").aviso).toBe("NUP vazio");
    expect(nup.validar("123").aviso).toBe("NUP deve ter 17 digitos (encontrados 3): '123'");
    expect(() => nup.nup_dv("123")).toThrow("base do NUP deve ter exatamente 15 digitos");
  });
});

describe("cartões que não são processo", () => {
  const cartao = (name: string) => ({ name });
  it.each([
    "1-Modelo",
    "MODELO",
    "Laudos MODELO para Dr. Evanildo",
    "ADICIONAL DE INSALUBRIDADE ANTIGO",
    "Pessoal: Conversão de Tempo Especial em Comum - desativado",
    "Modelo de parecer",
    "PROCESSO ANTIGO - não usar",
  ])("recusa %s", (nome) => expect(_e_cartao_de_processo(cartao(nome), "23086.000608/2026-84", null)).toBe(false));
  it.each([
    "MARCÍLIO COELHO FERREIRA 01-2025",
    "Jaqueline G V P Miranda",
    "GENILTON DOS SANTOS",
    "Ana Mara Fonseca Nunes",
    "Christiane Motta Araujo",
  ])("aceita %s", (nome) => expect(_e_cartao_de_processo(cartao(nome), "23086.000608/2026-84", null)).toBe(true));
  it("sem NUP e sem servidor não é processo", () =>
    expect(_e_cartao_de_processo(cartao("FULANO DE TAL"), null, null)).toBe(false));
  it("sem NUP mas com servidor casado é processo", () =>
    expect(_e_cartao_de_processo(cartao("FULANO DE TAL"), null, {})).toBe(true));
  it("palavra parecida não recusa (Antigone)", () =>
    expect(_e_cartao_de_processo(cartao("ANTIGONE SILVA"), "23086.000608/2026-84", null)).toBe(true));
});

describe("de-para das listas do quadro real", () => {
  const LISTAS_REAIS: [string, number][] = [
    ["Painel Geral", 1], ["Painel de Controle", 5], ["Entrada", 2], ["Processos", 16], ["Delegar", 1],
    ["Não Iniciado", 3], ["A fazer", 5], ["Em andamento", 4], ["Aguardando", 4], ["Adicional Ocupacional", 381],
    ["Adicional Ocupacional - Campus Avançados", 10], ["Aposentadoria Especial = Concluídos", 50],
    ["Concluído 2026", 18], ["Concluído 2025", 35], ["Processos Geral - Informação", 6], ["Concluído 2024", 28],
    ["Adicional Ocupacional - Digitalizados", 12], ["Comissões", 6], ["Concluído 2023", 35], ["Concluído 2020", 2],
    ["Concluído - 2021", 38], ["Processos Concluidos - 2022", 53], ["Concluído 2022", 12],
  ];
  it("o quadro real tem 23 listas e 727 cartões", () => {
    expect(LISTAS_REAIS.length).toBe(23);
    expect(LISTAS_REAIS.reduce((a, [, n]) => a + n, 0)).toBe(727);
  });
  it.each(LISTAS_REAIS)("%s está mapeada", (nome) => expect(_mapear_lista(nome)).not.toBeNull());
  it("nenhum cartão seria rejeitado por lista", () =>
    expect(LISTAS_REAIS.filter(([n]) => _mapear_lista(n) === null).reduce((a, [, n]) => a + n, 0)).toBe(0));
  it.each([
    ["Concluído 2026", 2026],
    ["Concluído 2020", 2020],
    ["Concluído - 2021", 2021],
    ["Processos Concluidos - 2022", 2022],
  ] as const)("%s extrai o exercício", (nome, ano) => {
    const regra = _mapear_lista(nome)!;
    expect(regra.ano_referencia).toBe(ano);
    expect(regra.situacao).toBe("CONCLUIDO");
  });
  it("dois anos de 2022 convivem", () => {
    expect(_mapear_lista("Processos Concluidos - 2022")!.ano_referencia).toBe(2022);
    expect(_mapear_lista("Concluído 2022")!.ano_referencia).toBe(2022);
  });
  it.each(["Painel Geral", "Painel de Controle", "Processos Geral - Informação"])("%s não vira processo", (n) =>
    expect(_mapear_lista(n)!.ignorar).toBe(true));
  it.each([
    ["Adicional Ocupacional", "ADICIONAL_OCUPACIONAL"],
    ["Adicional Ocupacional - Digitalizados", "ADICIONAL_OCUPACIONAL"],
    ["Adicional Ocupacional - Campus Avançados", "ADICIONAL_OCUPACIONAL"],
    ["Aposentadoria Especial = Concluídos", "APOSENTADORIA_ESPECIAL"],
    ["Comissões", "CONSULTA_NORMATIVA"],
  ])("tipo por lista: %s", (n, t) => expect(_mapear_lista(n)!.tipo).toBe(t));
  it("repositórios são marcados", () => {
    for (const n of [
      "Adicional Ocupacional",
      "Adicional Ocupacional - Digitalizados",
      "Adicional Ocupacional - Campus Avançados",
      "Aposentadoria Especial = Concluídos",
    ]) {
      expect(_mapear_lista(n)!.repositorio).toBe(true);
    }
  });
  it("lista desconhecida continua sem mapeamento", () => {
    expect(_mapear_lista("Lista inventada agora")).toBeNull();
    expect(_mapear_lista("")).toBeNull();
    expect(_mapear_lista(null)).toBeNull();
  });
  it("o de-para não inventa estado fora da máquina", () => {
    for (const regra of Object.values(DEPARA_LISTAS)) {
      if (regra.ignorar) continue;
      expect(ESTADOS_PROCESSO as readonly string[]).toContain(regra.estado);
    }
  });
});

describe("separação do backlog", () => {
  const HOJE = "2026-08-11";
  const ANTIGO = "2021-05-20T10:00:00.000Z";
  const RECENTE = "2026-06-26T10:00:00.000Z";
  const cartao = (campos: Record<string, unknown> = {}) => ({
    name: "FULANO DE TAL",
    desc: "SEI 23086.000171/1993-41",
    dateLastActivity: ANTIGO,
    badges: { attachments: 0, checkItems: 0, comments: 0 },
    ...campos,
  });
  it("cadastro histórico é só nome e número", () => {
    const c = classificar_backlog(cartao(), HOJE);
    expect(c.historico).toBe(true);
    expect(c.motivo).toContain("somente nome e número");
  });
  it("sem descrição também é histórico", () => expect(classificar_backlog(cartao({ desc: "" }), HOJE).historico).toBe(true));
  it.each([
    [{ badges: { attachments: 1, checkItems: 0, comments: 0 } }, "tem anexo"],
    [{ badges: { attachments: 0, checkItems: 4, comments: 0 } }, "tem checklist"],
    [{ badges: { attachments: 0, checkItems: 0, comments: 2 } }, "tem comentário"],
    [{ due: "2026-04-18T00:00:00.000Z" }, "tem prazo em aberto"],
    [{ dateLastActivity: RECENTE }, "movimentado há 46 dias"],
  ] as const)("rastro de trabalho mantém na fila: %j", (campos, esperado) => {
    const c = classificar_backlog(cartao(campos), HOJE);
    expect(c.historico).toBe(false);
    expect(c.motivo).toContain(esperado);
  });
  it("prazo já cumprido não conta", () =>
    expect(classificar_backlog(cartao({ due: "2021-04-18T00:00:00.000Z", dueComplete: true }), HOJE).historico).toBe(true));
  it("descrição com conteúdo conta", () => {
    const c = classificar_backlog(
      cartao({
        desc: "SEI 23086.000171/1993-41 — aguardando o formulário do art. 17 assinado pela chefia do laboratório",
      }),
      HOJE,
    );
    expect(c.historico).toBe(false);
    expect(c.motivo).toContain("descrição com conteúdo");
  });
  it("a descrição padrão do cadastro não conta", () => {
    for (const texto of [
      "SEI 23086.000171/1993-41",
      "sei 23086.000519/2011-51",
      "  SEI  23086.002359/2011-85  ",
    ]) {
      expect(classificar_backlog(cartao({ desc: texto }), HOJE).historico).toBe(true);
    }
  });
  it("fronteira de um ano", () => {
    const limite = somar_dias(HOJE, -DIAS_PARA_HISTORICO);
    const dentro = limite + "T12:00:00.000Z";
    const fora = somar_dias(limite, -2) + "T12:00:00.000Z";
    expect(classificar_backlog(cartao({ dateLastActivity: dentro }), HOJE).historico).toBe(false);
    expect(classificar_backlog(cartao({ dateLastActivity: fora }), HOJE).historico).toBe(true);
  });
  it("cartão sem data de atividade", () =>
    expect(classificar_backlog(cartao({ dateLastActivity: null }), HOJE).historico).toBe(true));
  it("anexo pela lista e não só pelo badge", () =>
    expect(classificar_backlog(cartao({ attachments: [{ name: "laudo.pdf" }] }), HOJE).historico).toBe(false));
  it("o motivo é legível para o coordenador", () =>
    expect(
      classificar_backlog(cartao({ dateLastActivity: RECENTE, due: "2026-04-18T00:00:00.000Z" }), HOJE).motivo,
    ).toBe("tem prazo em aberto; movimentado há 46 dias"));
});
