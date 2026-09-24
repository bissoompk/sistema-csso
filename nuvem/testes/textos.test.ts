/** CA-03 (UORG), RN-19 (identificador opaco) e RN-21. Porte de `test_textos.py`. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as textos from "../src/servicos/textos";

describe("textos", () => {
  it("ca03 uorg famed", () => {
    expect(textos.uorg_formatado("250 - FACULDADE DE MEDICINA DE DIAMANTINA")).toBe(
      "250 - Faculdade De Medicina De Diamantina",
    );
  });

  it("ca03 uorg iect", () => {
    expect(textos.uorg_formatado("260 - INSTITUTO DE ENG., CIENCIA E TECNOLOGIA")).toBe(
      "260 - Instituto De Eng., Ciencia E Tecnologia",
    );
  });

  it("title do Python: letra depois de apóstrofo e dígito sobe", () => {
    expect(textos.title_python("d'agua 3a ÁGUA")).toBe("D'Agua 3A Água");
  });

  it("código e nome da uorg", () => {
    const bruto = "234 - DEPARTAMENTO DE ZOOTECNIA";
    expect(textos.codigo_uorg(bruto)).toBe("234");
    expect(textos.nome_uorg(bruto)).toBe("DEPARTAMENTO DE ZOOTECNIA");
  });

  it("aspas curvas alternam", () => {
    expect(textos.aspas_curvas('"Manipulação de álcalis cáusticos."')).toBe("“Manipulação de álcalis cáusticos.”");
  });

  it("slug ascii para nome de arquivo", () => {
    expect(textos.slug_ascii("Marco Antônio Alves Schetino")).toBe("Marco_Antonio_Alves_Schetino");
    expect(textos.nome_arquivo_parecer(8, 2026, "SEST/DASA/PROGEP", "Talita")).toBe(
      "Parecer_Tecnico_08-2026_SEST_Talita",
    );
  });

  it("normalizar_fluxo colapsa quebra", () => {
    expect(textos.normalizar_fluxo("linha um\n  linha   dois \n")).toBe("linha um linha dois");
  });

  it.each(["servidora gestante afastada", "consta CID-10 no atestado", "informar o CPF do servidor"])(
    "rn21 bloqueia dado de saúde: %s",
    (texto) => {
      expect(() => textos.exigir_texto_limpo(texto, "observacoes")).toThrow(textos.TextoProibido);
    },
  );

  it("rn21 deixa passar texto técnico", () => {
    const limpo =
      "Exposição a agentes químicos no Laboratório de Química; avaliação qualitativa conforme Anexo 13 da NR-15.";
    expect(textos.exigir_texto_limpo(limpo, "observacoes")).toBe(limpo);
  });

  it("rn21 doença continua barrada no contexto padrão", () => {
    expect(() => textos.exigir_texto_limpo("servidor afastado por doença", "observacoes")).toThrow(textos.TextoProibido);
    expect(() => textos.exigir_texto_limpo("quadro de enfermidade cronica", "observacoes")).toThrow(textos.TextoProibido);
  });

  it("rn21 doença relacionada ao trabalho passa no contexto de acidente", () => {
    const narrativa =
      "Ocorrencia registrada na especie doença relacionada ao trabalho, com exposicao a ruido continuo no Setor de Marcenaria desde 2019.";
    expect(textos.exigir_texto_limpo(narrativa, "descricao_evento", textos.CONTEXTO_NEXO_OCUPACIONAL)).toBe(narrativa);
    expect(textos.termos_proibidos_em("doenca sem acento", textos.CONTEXTO_NEXO_OCUPACIONAL)).toEqual([]);
  });

  it.each([
    "doença relacionada ao trabalho, CID-10 registrado no prontuario",
    "doença relacionada ao trabalho conforme diagnóstico do medico assistente",
    "doença relacionada ao trabalho, ver atestado médico anexo",
    "servidora gestante com doença relacionada ao trabalho",
    "doença relacionada ao trabalho; enfermidade degenerativa previa",
    "doença relacionada ao trabalho - CPF 000.000.000-00",
  ])("rn21 contexto de acidente dispensa só a palavra da espécie: %s", (texto) => {
    expect(() => textos.exigir_texto_limpo(texto, "descricao_evento", textos.CONTEXTO_NEXO_OCUPACIONAL)).toThrow(
      textos.TextoProibido,
    );
  });

  it("rn21 dispensa não vaza para o contexto padrão", () => {
    expect(textos.TERMOS_PROIBIDOS).toContain("doença");
    expect(textos.termos_proibidos_em("doença relacionada ao trabalho")).toEqual(["doenca", "doença"]);
  });

  it("rn21 contexto desconhecido falha alto", () => {
    expect(() => textos.termos_proibidos_em("qualquer texto", "acidentes")).toThrow(/contexto de RN-21 desconhecido/);
  });

  it("rn21 contexto padrão é o default", () => {
    expect(textos.termos_proibidos_em("doença")).toEqual(textos.termos_proibidos_em("doença", textos.CONTEXTO_PADRAO));
  });

  it("rn21: a palavra é inteira, não pedaço (o \\b do Python é Unicode)", () => {
    expect(textos.termos_proibidos_em("cpfxyz e gestantes")).toEqual([]);
    expect(textos.termos_proibidos_em("o cpf.")).toEqual(["cpf"]);
  });

  it("rn21: a recusa fala português e nomeia o campo da TELA", () => {
    let frase = "";
    try {
      textos.exigir_texto_limpo("consta atestado médico", "comentário");
    } catch (e) {
      frase = (e as Error).message;
    }
    expect(frase).toContain("comentário");
    expect(frase).not.toContain("'comentario'");
    expect(frase).toContain("contém termo proibido");
    expect(frase).toContain("Estado de saúde, gestação, CID e diagnóstico");
    expect(frase).toContain("RN-21");
    expect(frase).toContain("LGPD art. 11");
  });

  it("rn21: a recusa diz a saída", () => {
    let frase = "";
    try {
      textos.exigir_texto_limpo("servidora gestante", "observações");
    } catch (e) {
      frase = (e as Error).message;
    }
    expect(frase).toContain("agente");
    expect(frase).toContain("ambiente");
    expect(frase).toContain("não a pessoa");
  });

  it("rn21: o campo recebe rótulo de tela e não nome de coluna (varredura de src/)", () => {
    const coluna = /exigir_texto_limpo\(\s*[^,)]+,\s*["'`]([a-z0-9_]+)["'`]/g;
    const achados: string[] = [];
    const varrer = (dir: string) => {
      for (const nome of readdirSync(dir)) {
        const p = path.join(dir, nome);
        if (statSync(p).isDirectory()) varrer(p);
        else if (p.endsWith(".ts")) {
          const texto = readFileSync(p, "utf8");
          for (const m of texto.matchAll(coluna)) {
            if (m[1] !== "texto") achados.push(`${nome}: campo=${m[1]}`);
          }
        }
      }
    };
    varrer(path.resolve(__dirname, "../src"));
    expect(achados).toEqual([]);
    // sonda da sonda
    expect('exigir_texto_limpo(valor, "justificativa_art9")'.match(coluna)).not.toBeNull();
    expect('exigir_texto_limpo(valor, "justificativa do art. 9º")'.match(coluna)).toBeNull();
  });

  it("rn19 identificador opaco não revela matrícula", () => {
    const opaco = textos.identificador_opaco(42, "sessao-abc");
    expect(opaco.startsWith("SRV-") && opaco.length === 8).toBe(true);
    expect(opaco).not.toContain("42");
    expect(textos.identificador_opaco(42, "outra-sessao")).not.toBe(opaco);
  });

  it("rn19 o opaco é o mesmo SHA-256 do Python (sessões convivem)", () => {
    // hashlib.sha256(b"sessao-abc:42").hexdigest()[:4]
    expect(textos.identificador_opaco(42, "sessao-abc")).toBe(
      "SRV-" + require("node:crypto").createHash("sha256").update("sessao-abc:42").digest("hex").slice(0, 4),
    );
  });

  it("parece_cpf", () => {
    expect(textos.parece_cpf("000.000.000-00")).toBe(true);
    expect(textos.parece_cpf("1110654")).toBe(false);
  });
});
