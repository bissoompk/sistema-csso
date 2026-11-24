/**
 * RN-21 no EPI (24/11/2026): o filtro de saúde ampliado vale onde se fala da PESSOA (observação da
 * entrega, parecer, justificativas, motivos e complementos, campos do pedido). No material (lote,
 * estoque) vale só a lista de sempre — "lesão", "dermatite", "laudo" estão na descrição normal de
 * um equipamento e não podem ser barrados ali.
 */
import { describe, expect, it } from "vitest";
import * as textos from "../src/servicos/textos.js";

const PESSOA = textos.CONTEXTO_EPI_PESSOA;
const MATERIAL = textos.CONTEXTO_EPI_MATERIAL;
const POSTO = textos.CONTEXTO_EPI_POSTO;

// descrições reais de catálogo e lote, como os fabricantes e o CA escrevem
const DESCRICOES_DE_EPI = [
  "Luva nitrílica descartável, protege contra lesões e dermatite de contato por agentes químicos.",
  "Creme de proteção para a pele (luva invisível) contra dermatoses ocupacionais.",
  "Óculos de segurança; laudo de ensaio nº 1234/2025 conforme ANSI Z87.1.",
  "Calçado de segurança com biqueira; evita lesão por impacto e afastamento por acidente.",
  "Respirador PFF2 contra poeiras e névoas; reduz o risco de doenças respiratórias ocupacionais.",
  "Protetor auricular tipo plug, atenuação 15 dB, previne perda auditiva induzida por ruído.",
  "Avental de raspa para soldador, protege contra queimaduras e ferimentos.",
  "Cinturão paraquedista para trabalho em altura, laudo de ensaio do fabricante anexo.",
  "Máscara para agentes biológicos; lote conferido, sem avaria.",
];

describe("EPI — material: sem falso positivo", () => {
  for (const d of DESCRICOES_DE_EPI) {
    it(d.slice(0, 50), () => {
      expect(textos.exigir_texto_limpo(d, "observação do lote", MATERIAL)).toBe(d);
    });
  }
  it("CPF e CID continuam recusados no material, com a mensagem do EPI", () => {
    expect(() => textos.exigir_texto_limpo("lote do CPF do fornecedor", "observação do lote", MATERIAL)).toThrow(/no EPI/);
    expect(() => textos.exigir_texto_limpo("ver CID-10 J45", "observação do lote", MATERIAL)).toThrow(textos.TextoProibido);
  });
});

describe("EPI — pessoa: termo de saúde recusado sem confirmação", () => {
  const CASOS = [
    "Aprovado. Servidora relata alergia ao látex.",
    "servidor com dermatite alérgica",
    "Servidor asmático, precisa de outro respirador",
    "pós-operatório do joelho, pede botina mais leve",
    "toma medicamento que dá sonolência",
    "afastamento médico em outubro",
    "laudo médico anexo ao pedido",
    "servidora gestante, afastada do setor",
    "CID J45",
  ];
  for (const t of CASOS) {
    it(t, () => {
      const f = () => textos.exigir_texto_limpo(t, "parecer da análise", PESSOA);
      expect(f).toThrow(textos.TextoProibido);
      expect(f).toThrow(/não podem ser registrados no EPI/);
      expect(f).toThrow(/LGPD art\. 11/);
    });
  }

  it("não há caixa de confirmação: o erro não é MencaoDeSaude", () => {
    let erro: unknown;
    try {
      textos.exigir_texto_limpo("servidora gestante", "rotina de trabalho", PESSOA, true);
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(textos.TextoProibido);
    expect(erro).not.toBeInstanceOf(textos.MencaoDeSaude);
  });

  it("o texto de trabalho e de risco passa", () => {
    for (const t of [
      "Aprovado. Trocar a luva por nitrílica, tamanho M.",
      "Manipula solvente orgânico no LEAC; risco de respingo nos olhos.",
      "Recusado: o CA do item pedido venceu; pedir o modelo novo.",
      "Trabalho em altura acima de 2 m, com risco de queda e de lesão.",
      "Devolveu por desgaste natural após o uso.",
    ]) {
      expect(textos.exigir_texto_limpo(t, "parecer da análise", PESSOA)).toBe(t);
    }
  });

  it("os termos ampliados não valem fora do EPI", () => {
    expect(textos.exigir_texto_limpo("relata alergia ao látex", "assunto")).toBe("relata alergia ao látex");
  });
});

describe("EPI — posto (rotina de trabalho e riscos declarados, 24/11/2026)", () => {
  it("o risco do posto passa nos dois campos", () => {
    for (const campo of ["rotina de trabalho", "riscos declarados"]) {
      for (const t of ["risco de dermatite de contato", "risco de lesão por corte", "Risco de dermatite de contato com solventes e risco de lesão por corte."]) {
        expect(textos.exigir_texto_limpo(t, campo, POSTO)).toBe(t);
      }
    }
  });
  it("a lista antiga continua recusada, com a mensagem do EPI", () => {
    for (const t of ["servidora gestante", "diagnóstico de asma", "CID J45", "CPF 123"]) {
      expect(() => textos.exigir_texto_limpo(t, "riscos declarados", POSTO)).toThrow(/no EPI/);
    }
  });
});
