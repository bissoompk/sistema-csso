/**
 * CA-01 / CA-02 / CA-05 — o teste de ouro do parecer 1/2025, e os outros
 * modelos. Porte de `testes/integracao/test_parecer_ouro.py`, da parte de
 * documento de `test_servicos_diversos.py` e de `test_pdf.py` (a metade que
 * vale sem LibreOffice).
 *
 * O CA-01 compara o texto extraído do .docx com
 * `testes/fixtures/ouro_parecer_1_2025.txt` — a transcrição do PDF assinado,
 * que está no repositório (o PDF em `entrada/` não está, e não precisa: o
 * teste do Python também compara com a transcrição).
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import PizZip from "pizzip";
import { beforeAll, describe, expect, it } from "vitest";

process.env.CSSO_DIR_ARQUIVOS = mkdtempSync(path.join(tmpdir(), "csso-docs-"));

import * as documento from "../src/servicos/documento";
import * as pdf from "../src/servicos/pdf";
import { converter_modelo_docxtpl, ModeloIncompativel, medir_imagem } from "../src/servicos/docx_baixo_nivel";
import { normalizar_fluxo } from "../src/servicos/textos";
import { definirArmazenamento, obterArmazenamento } from "../src/servicos/armazenamento";
import { MODELOS, ORIGEM } from "../ferramentas/converter-modelos-docx";

const RAIZ = path.resolve(__dirname, "../..");
const OURO = path.join(RAIZ, "testes/fixtures/ouro_parecer_1_2025.txt");

function contexto_1_2025(): documento.ContextoParecer {
  return new documento.ContextoParecer({
    numero_parecer: 1,
    ano: 2025,
    data_emissao: "2025-02-11",
    cidade: "Diamantina",
    sigla_unidade_emissora: "SEST/DASA/PROGEP",
    nome_extenso_emissor: "Serviço Especializado em Segurança do Trabalho",
    endereco_emissor: "Rodovia MGT 367 - Km 583, nº 5000 - Alto da Jacuba - CEP 39100-000",
    telefone_emissor: "Fone: (38) 3532-1200 e (38) 3532-6000",
    laudo_de: "concessão",
    unidade: "Faculdade de Medicina de Diamantina",
    postos: ["Laboratório Escola de análises Clínicas (LEAC)", "Laboratório de Doenças Infecciosas e Parasitárias"],
    uorg_bruto: "250 - FACULDADE DE MEDICINA DE DIAMANTINA",
    tipo_laudo: "Adicional de Insalubridade",
    numero_processo_sei: "23086.021284/2024-56",
    nome_servidor: "Marco Antônio Alves Schetino",
    matricula: "1110654",
    cargo: "TECNICO DE LABORATORIO AREA",
    funcao: "",
    laudo_siape: "26255-000.125/2019",
    agentes_nocivos: ["Contato permanente com material infecto-contagiante"],
    tipo_risco: "Agente Biológico",
    percentual_aplicavel: "Médio (10%)",
    portaria_localizacao: "PORTARIA/FAMED Nº 35, DE 17 DE SETEMBRO DE 2024",
    fundamentacao_legal:
      "“Trabalhos e operações em contato permanente com material infecto-contagiante, " +
      "em: laboratórios de análise clínica e histopatologia”\n" +
      "Anexo 14 da NR 15 e Instrução Normativa 15/2022.",
    alteracao:
      "Qualquer alteração na execução das atividades técnicas do servidor, bem como " +
      "mudanças em sua carga horária, deverá ser comunicada ao Serviço Especializado " +
      "em Segurança do Trabalho – SEST.",
    recomendacao_tecnica:
      "Reconhecer o direito ao adicional de insalubridade caracterizado pela " +
      "exposição ao Agente Biológico, a partir da data da Portaria de " +
      "Localização: 17 de setembro de 2024",
    reavaliacao: null,
    pro_reitor: "MARINA FERREIRA DA COSTA",
    pro_reitor_cargo: "Pró-reitora de Gestão de Pessoas",
    tratamento_destinatario: "A sua senhoria, a senhora:",
    assinante_nome: "Fabrício Raimundi Andrade",
    assinante_matricula: "2165804",
    assinante_titulo: "Eng. Seg. do Trabalho",
  });
}

const ASSERCOES_NOMEADAS = [
  "Parecer técnico no 1/2025",
  "Serviço Especializado em Segurança do Trabalho",
  "Diamantina, 11 de fevereiro de 2025",
  "MARINA FERREIRA DA COSTA",
  "Faculdade de Medicina de Diamantina",
  "Laboratório Escola de análises Clínicas (LEAC)",
  "Laboratório de Doenças Infecciosas e Parasitárias",
  "250 - Faculdade De Medicina De Diamantina",
  "Adicional de Insalubridade",
  "23086.021284/2024-56",
  "Marco Antônio Alves Schetino",
  "1110654",
  "TECNICO DE LABORATORIO AREA",
  "Nº 26255-000.125/2019",
  "Agente Biológico",
  "Contato permanente com material infecto-contagiante*",
  "Médio (10%)",
  "PORTARIA/FAMED Nº 35, DE 17 DE SETEMBRO DE 2024",
  "Anexo 14 da NR 15 e Instrução Normativa 15/2022",
  "Art. 17 da IN 15/2022",
  "a partir da data da Portaria de Localização: 17 de setembro de 2024",
  "Fabrício Raimundi Andrade",
  "Mat. SIAPE 2165804",
  "LT Nº 1/2025",
  "IN 15/2022",
];

let docx_1_2025: documento.DocumentoRenderizado;
let texto_1_2025: string;

beforeAll(async () => {
  definirArmazenamento(null);
  docx_1_2025 = await documento.renderizar(contexto_1_2025(), null, documento.MODELO_V1);
  texto_1_2025 = documento.extrair_texto(docx_1_2025.bytes);
});

describe("parecer — o ouro do 1/2025 (CA-01)", () => {
  it("gera o parecer 1/2025 igual ao assinado", () => {
    expect(normalizar_fluxo(texto_1_2025)).toBe(normalizar_fluxo(readFileSync(OURO, "utf8")));
  });

  it.each(ASSERCOES_NOMEADAS)("asserção nomeada: %s", (trecho) => {
    expect(normalizar_fluxo(texto_1_2025)).toContain(normalizar_fluxo(trecho));
  });

  it("o hash do conteúdo é o mesmo que o Python registrava para este parecer", () => {
    // `documento.renderizar(contexto_1_2025(), ...)["hash_conteudo"]` no Python
    // (docxtpl 0.20 + python-docx 1.2): emitir na nuvem não muda a impressão
    // digital do mesmo documento
    expect(docx_1_2025.hash_conteudo).toBe("8e48389888f5a08a8fe1b72509ca2682ecf45e925246c578dae160c9059458b9");
  });

  it("defeito do v1 preservado (RN-02)", () => {
    expect(normalizar_fluxo(texto_1_2025)).toContain("Nº do Laudo Técnico: Nº 1/2025");
  });

  it("o v2 corrige o rótulo", async () => {
    const r = await documento.renderizar(contexto_1_2025(), null, documento.MODELO_V2);
    const fluxo = normalizar_fluxo(documento.extrair_texto(r.bytes));
    expect(fluxo).toContain("Nº do Parecer Técnico: Nº 1/2025");
    expect(fluxo).not.toContain("Nº do Laudo Técnico:");
  });

  it("a célula de posto tem exatamente duas linhas (dois parágrafos, como o RichText com \\a)", () => {
    const xml = new PizZip(docx_1_2025.bytes).file("word/document.xml")!.asText();
    const i = xml.indexOf("Laboratório Escola de análises Clínicas (LEAC)");
    const celula = xml.slice(xml.lastIndexOf("<w:tc>", i), xml.indexOf("</w:tc>", i));
    const paragrafos = [...celula.matchAll(/<w:p[ >].*?<\/w:p>/gs)]
      .map((p) => [...p[0].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((t) => t[1]).join("").trim())
      .filter(Boolean);
    expect(paragrafos).toEqual([
      "Laboratório Escola de análises Clínicas (LEAC)",
      "Laboratório de Doenças Infecciosas e Parasitárias",
    ]);
  });

  it("ca02: condicional de reavaliação ausente", () => {
    expect(texto_1_2025).not.toContain("avaliados quantitativamente");
  });

  it("ca02: condicional de reavaliação presente", async () => {
    const c = contexto_1_2025();
    c.numero_parecer = 8;
    c.ano = 2026;
    c.data_emissao = "2026-06-18";
    c.fundamentacao_legal =
      "“Fabricação e manipulação de ácido oxálico, nítrico sulfúrico, clorídrico, fosfórico, pícrico.”\n" +
      "“Manipulação de álcalis cáusticos.”\nAnexo 13 da NR 15 e Instrução Normativa 15/2022.";
    c.reavaliacao =
      "Os agentes químicos devem ser avaliados quantitativamente para fins de prevenção e controle do risco. " +
      "Após a realização da avaliação quantitativa dos agentes químicos um novo laudo deverá ser elaborado.";
    const r = await documento.renderizar(c, null, documento.MODELO_V1);
    const fluxo = normalizar_fluxo(documento.extrair_texto(r.bytes));
    expect(fluxo).toContain("avaliados quantitativamente");
    expect(fluxo).toContain("Anexo 13 da NR 15 e Instrução Normativa 15/2022.*");
  });

  it("cabeçalho espelho CSSO 2026", async () => {
    const c = contexto_1_2025();
    c.numero_parecer = 12;
    c.ano = 2026;
    c.data_emissao = "2026-07-01";
    c.sigla_unidade_emissora = "CSSO/Sisa";
    c.nome_extenso_emissor = "Coordenadoria de Segurança e Saúde Ocupacional";
    const r = await documento.renderizar(c, null, documento.MODELO_V1);
    const fluxo = normalizar_fluxo(documento.extrair_texto(r.bytes));
    expect(fluxo).toContain("Coordenadoria de Segurança e Saúde Ocupacional");
    expect(fluxo).toContain("Parecer técnico no 12/2026 – CSSO/Sisa");
  });

  it("o hash do modelo é o do modelo de ORIGEM, e é registrado", async () => {
    expect(docx_1_2025.modelo_arquivo).toBe(documento.MODELO_V1);
    const origem = readFileSync(path.join(ORIGEM, documento.MODELO_V1));
    expect(docx_1_2025.modelo_sha256).toBe(createHash("sha256").update(origem).digest("hex"));
    expect(docx_1_2025.hash_conteudo).toHaveLength(64);
  });

  it("rn04 lista o que falta", async () => {
    const c = contexto_1_2025();
    c.matricula = "";
    c.percentual_aplicavel = "";
    const erro = await documento.renderizar(c, null, documento.MODELO_V1).catch((e) => e);
    expect(erro).toBeInstanceOf(documento.DadosIncompletos);
    expect(erro.faltantes).toContain("matricula SIAPE");
    expect(erro.faltantes).toContain("percentual aplicavel");
  });

  it("grava no armazenamento quando recebe destino", async () => {
    const chave = documento.caminho_saida(1, 2025, "SEST/DASA/PROGEP", "Marco Antônio");
    expect(chave).toBe("documentos/2025/Parecer_Tecnico_01-2025_SEST_Marco_Antonio.docx");
    const r = await documento.renderizar(contexto_1_2025(), chave, documento.MODELO_V1);
    expect(r.arquivo).toBe(chave);
    expect(await obterArmazenamento().ler(chave)).toEqual(r.bytes);
  });

  it("congelar e descongelar devolvem o mesmo contexto (RN-15)", () => {
    const c = contexto_1_2025();
    const congelado = JSON.parse(JSON.stringify(c.congelar()));
    expect(congelado.data_emissao).toBe("2025-02-11");
    expect(documento.ContextoParecer.descongelar(congelado).como_dicionario().data_extenso).toBe("11 de fevereiro de 2025");
  });

  it("modelo ausente: erro com a dica", async () => {
    await expect(documento.renderizar_modelo("nao_existe.docx", {}, { dica: "Rode X." })).rejects.toThrow(/nao_existe.docx.*Rode X\./);
  });
});

describe("os outros modelos (lista de presença, comprovante de EPI, certificado)", () => {
  const PNG_40x20 = Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAACgAAAAUCAIAAABwJOjsAAAAJElEQVR4nO3NMQ0AAAwEofdvupVxCwk7uy3RrGKxWCwWi8WJB336HQ594lo5AAAAAElFTkSuQmCC",
      "base64",
    ),
  );
  const comum = { setor_nome: "Coordenadoria de Segurança & Saúde <CSSO>", setor_sigla: "CSSO/Sisa", cidade: "Diamantina" };

  it("lista de presença: o laço de linha repete a linha do participante", async () => {
    const r = await documento.renderizar_modelo("lista_presenca_v1.docx", {
      ...comum,
      campus: "JK",
      carga_horaria: "8 h",
      frequencia_minima: "75%",
      gerada_em: "24/09/2026 10:00",
      local: "Auditório",
      nota_minima: "7,0",
      periodo: "01/09 a 02/09/2026",
      total: "3",
      treinamento: "NR-35",
      turma_codigo: "T-2026-0001",
      unidade_promotora: "CSSO",
      instrutores: documento.rich_multilinha("Fulano de Tal\nBeltrana Silva"),
      participantes: [
        { ordem: "1", nome: "Ana", identificador: "PTC-1", vinculo: "Servidor" },
        { ordem: "2", nome: "Bruno", identificador: "PTC-2", vinculo: "Externo" },
        { ordem: "3", nome: "Carla", identificador: "PTC-3", vinculo: "Servidor" },
      ],
    });
    const t = documento.extrair_texto(r.bytes);
    expect(t).toContain("1\nAna\nPTC-1\nServidor\n\n2\nBruno\nPTC-2\nExterno\n\n3\nCarla\nPTC-3\nServidor\n\n");
    expect(t).toContain("Fulano de Tal\nBeltrana Silva");
    // o & e o < saem como texto (o docxtpl sem autoescape os perdia)
    expect(t).toContain("Coordenadoria de Segurança & Saúde <CSSO>");
    expect(t).not.toMatch(/[{}]/);
  });

  it("comprovante de EPI", async () => {
    const r = await documento.renderizar_modelo("comprovante_epi_v1.docx", {
      ...comum,
      titulo: "Comprovante de entrega de EPI",
      servidor_nome: "Maria",
      siape: "1234567",
      normas: documento.rich_multilinha("NR-6\nIN 15/2022") ?? "—",
      termo: documento.rich_multilinha("Declaro que recebi.\nE me comprometo.") ?? "",
    });
    const t = documento.extrair_texto(r.bytes);
    expect(t).toContain("Comprovante de entrega de EPI");
    expect(t).toContain("NR-6\nIN 15/2022");
    expect(t).not.toMatch(/[{}]/);
  });

  it("certificado com a rubrica em linha (imagem embutida sem módulo pago)", async () => {
    const chave = "anexos/ru/rubrica-teste";
    await obterArmazenamento().gravar(chave, PNG_40x20, "image/png");
    const r = await documento.renderizar_modelo(
      "certificado_padrao_v1.docx",
      { ...comum, nome_do_aluno: "Ana Souza", rubrica: new documento.ImagemEmLinha({ chave, largura_mm: 30 }) },
      { pasta: "certificados" },
    );
    const zip = new PizZip(r.bytes);
    const xml = zip.file("word/document.xml")!.asText();
    expect(xml).toContain('<wp:extent cx="1080000" cy="540000"/>'); // 30 mm, proporção 2:1
    const rId = /r:embed="([^"]+)"/.exec(xml)![1];
    const rels = zip.file("word/_rels/document.xml.rels")!.asText();
    const alvo = new RegExp(`Id="${rId}"[^>]*Target="([^"]+)"`).exec(rels)![1]!;
    expect(zip.file(`word/${alvo}`)!.asUint8Array()).toEqual(PNG_40x20);
    expect(zip.file("[Content_Types].xml")!.asText()).toMatch(/Extension="png"/i);
    expect(documento.extrair_texto(r.bytes)).toContain("Ana Souza");
  });

  it("rubrica que sumiu do armazenamento vira vazio, e não erro", async () => {
    const r = await documento.renderizar_modelo(
      "certificado_padrao_v1.docx",
      { ...comum, rubrica: new documento.ImagemEmLinha({ chave: "anexos/zz/sumiu", largura_mm: 30 }) },
      { pasta: "certificados" },
    );
    expect(new PizZip(r.bytes).file("word/document.xml")!.asText()).not.toContain("<w:drawing>");
    expect(await new documento.ImagemEmLinha({ chave: "anexos/zz/sumiu" }).existe()).toBe(false);
  });

  it("mede PNG e JPEG pelo cabeçalho", () => {
    expect(medir_imagem(PNG_40x20)).toMatchObject({ extensao: "png", largura: 40, altura: 20 });
  });
});

describe("conversão dos modelos docxtpl", () => {
  it.each(MODELOS)("%s: a cópia em modelos-docx/ está atualizada e sem sintaxe Jinja", (relativo) => {
    const origem = new Uint8Array(readFileSync(path.join(ORIGEM, relativo)));
    const manifesto = JSON.parse(readFileSync(path.resolve(__dirname, "../modelos-docx/manifesto.json"), "utf8"));
    expect(manifesto[relativo]?.sha256_origem, "rode ferramentas/converter-modelos-docx.ts").toBe(
      createHash("sha256").update(origem).digest("hex"),
    );
    const convertido = new PizZip(readFileSync(path.resolve(__dirname, "../modelos-docx", relativo)));
    for (const nome of Object.keys(convertido.files).filter((n) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(n))) {
      const texto = convertido.file(nome)!.asText().replace(/<[^>]+>/g, "");
      expect(texto).not.toMatch(/\{\{|\{%|%\}|\}\}/);
    }
  });

  it.each(MODELOS)("%s: renderizado com qualquer dado, nenhuma tag sobra", async (relativo) => {
    const { marcadores } = converter_modelo_docxtpl(new Uint8Array(readFileSync(path.join(ORIGEM, relativo))));
    const dados = Object.fromEntries(marcadores.map((m) => [m, m === "participantes" ? [{ nome: "«item»" }] : `«${m}»`]));
    const r = await documento.renderizar_modelo(path.basename(relativo), dados, {
      pasta: relativo.includes("/") ? path.dirname(relativo) : null,
    });
    const t = documento.extrair_texto(r.bytes);
    expect(t).not.toMatch(/[{}]/);
    for (const m of marcadores.filter((m) => m !== "participantes" && m !== "reavaliacao")) expect(t).toContain(`«${m}»`);
  });

  it("recusa o que não sabe converter, em vez de gerar documento errado", () => {
    const zip = new PizZip();
    zip.file("word/document.xml", '<w:document><w:body><w:p><w:r><w:t>{{ a + b }}</w:t></w:r></w:p></w:body></w:document>');
    expect(() => converter_modelo_docxtpl(zip.generate({ type: "uint8array" }))).toThrow(ModeloIncompativel);
    const solta = new PizZip();
    solta.file("word/document.xml", "<w:document><w:body><w:p><w:r><w:t>chave { solta</w:t></w:r></w:p></w:body></w:document>");
    expect(() => converter_modelo_docxtpl(solta.generate({ type: "uint8array" }))).toThrow(/chave solta/);
  });

  it("junta a tag que o Word partiu entre runs", async () => {
    const zip = new PizZip();
    zip.file(
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    );
    zip.file(
      "word/document.xml",
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Olá {{ no</w:t></w:r><w:r><w:t>me }}!</w:t></w:r></w:p></w:body></w:document>',
    );
    const { bytes, marcadores } = converter_modelo_docxtpl(zip.generate({ type: "uint8array" }));
    expect(marcadores).toEqual(["nome"]);
    const saida = await documento.renderizar_bytes(bytes, { nome: "Maria" });
    expect(new PizZip(saida).file("word/document.xml")!.asText().replace(/<[^>]+>/g, "")).toBe("Olá Maria!");
  });
});

describe("documento: miudezas (test_servicos_diversos)", () => {
  it("primeira maiúscula", () => {
    expect(documento.primeira_maiuscula("departamento de zootecnia")).toBe("Departamento de zootecnia");
    expect(documento.primeira_maiuscula("")).toBe("");
    expect(documento.primeira_maiuscula(null)).toBe("");
  });

  it("RichText vazio vira null", () => {
    expect(documento.rich_multilinha(null)).toBeNull();
    expect(documento.rich_multilinha("")).toBeNull();
    expect(documento.rich_multilinha("   ")).toBeNull();
    expect(documento.rich_multilinha("uma linha")).not.toBeNull();
  });

  it("sha256 de texto é estável", () => {
    expect(documento.sha256_texto("abc")).toBe(documento.sha256_texto("abc"));
    expect(documento.sha256_texto("abc")).toHaveLength(64);
  });
});

describe("pdf (sem LibreOffice na nuvem)", () => {
  it("não há LibreOffice: o .docx sai com o aviso de sempre, e a falha é 'indisponível'", () => {
    expect(pdf.disponivel()).toBe(false);
    const r = pdf.converter();
    expect(r).toEqual({ gerado: false, caminho: null, aviso: pdf.AVISO_SEM_PDF, indisponivel: true });
    expect(pdf.AVISO_SEM_PDF).toContain("Salvar como PDF");
  });

  it("converter_fora_da_transacao não comita nada e devolve o mesmo", () => {
    expect(pdf.converter_fora_da_transacao(undefined as never)).toEqual(pdf.converter());
  });
});
