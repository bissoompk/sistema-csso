/**
 * NUVEM: o certificado em PDF com o QR da validação, desenhado sem
 * LibreOffice (`servicos/certificado_pdf.ts`), e o PNG do QR para o .docx.
 */
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import PizZip from "pizzip";
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { ContextoCertificado } from "../src/servicos/certificado.js";
import { gerar_pdf } from "../src/servicos/certificado_pdf.js";
import { carimbar_qr } from "../src/servicos/docx_baixo_nivel.js";
import { extrair_texto } from "../src/servicos/documento.js";
import { matriz_qr, qr_png } from "../src/servicos/qr.js";

function contexto(extra: Record<string, unknown> = {}): ContextoCertificado {
  return ContextoCertificado.descongelar({
    participante_nome: "Maria Aparecida de Souza Ção",
    participante_identificador: "PTC-7F3K9Q2M",
    participante_vinculo: "Externo",
    participante_organizacao: "",
    participante_siape: "",
    participante_lotacao: "",
    treinamento_nome: "Brigada de incêndio",
    treinamento_norma: "NR-23",
    treinamento_conteudo: "Teoria do fogo\nUso de extintores\nAbandono de área",
    validade_meses: 12,
    turma_codigo: "TUR-2026-0001",
    turma_data_inicio: "2026-10-01",
    turma_data_fim: "2026-10-02",
    carga_horaria: "16",
    turma_local: "Auditório do Campus JK",
    turma_unidade_promotora: "Coordenadoria de Segurança e Saúde Ocupacional",
    turma_campus: "JK",
    data_base_vencimento: "2026-10-02",
    nota_final: null,
    frequencia_percentual: "100",
    nota_minima: null,
    frequencia_minima: "75",
    instrutores: [{ nome: "Vitalina Escobar Rangel", titulo: "Bombeira civil", registro: "" }],
    numero: 7,
    ano: 2026,
    data_emissao: "2026-10-19",
    chave_validacao: "CSSO-2026-K7QMX-3FTB9-H",
    data_vencimento: "2027-10-02",
    url_validacao: "https://cssosisa.netlify.app/validar/CSSO-2026-K7QMX-3FTB9-H",
    setor_sigla: "CSSO/Sisa",
    setor_nome: "Coordenadoria de Segurança e Saúde Ocupacional",
    setor_endereco: "",
    cidade: "Diamantina",
    modelo_id: null,
    modelo_arquivo: "certificado_padrao_v1.docx",
    modelo_sha256: null,
    modelo_versao: 1,
    mapa_tags: {},
    assinante: { nome: "Fabrício Andrade", titulo: "Eng. Seg. do Trabalho", registro: "", rubrica_sha256: null },
    ...extra,
  } as Record<string, unknown>);
}

describe("certificado em PDF", () => {
  it("frente e verso (conteúdo programático) por certificado", async () => {
    const pdf = await PDFDocument.load(await gerar_pdf([contexto()]));
    expect(pdf.getPageCount()).toBe(2);
    const [largura, altura] = [pdf.getPage(0).getWidth(), pdf.getPage(0).getHeight()];
    expect(largura).toBeGreaterThan(altura); // paisagem, como o .docx
    expect(pdf.getTitle()).toBe("Certificado 7/2026");
  });

  it("sem conteúdo programático, só a frente; o lote junta todos", async () => {
    const um = await PDFDocument.load(await gerar_pdf([contexto({ treinamento_conteudo: "" })]));
    expect(um.getPageCount()).toBe(1);
    const lote = await PDFDocument.load(await gerar_pdf([contexto(), contexto({ numero: 8, treinamento_conteudo: "" })]));
    expect(lote.getPageCount()).toBe(3);
  });

  it("caractere fora da fonte vira '?' em vez de derrubar a geração", async () => {
    const bytes = await gerar_pdf([contexto({ participante_nome: "Nguyễn 王 ≥ Ana" })]);
    expect(bytes.length).toBeGreaterThan(1000);
  });
});

describe("QR", () => {
  it("o PNG é válido, quadrado e preto e branco", () => {
    const url = "https://cssosisa.netlify.app/validar/CSSO-2026-K7QMX-3FTB9-H";
    const png = Buffer.from(qr_png(url, 4));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const largura = png.readUInt32BE(16);
    expect(png.readUInt32BE(20)).toBe(largura);
    expect(largura).toBe((matriz_qr(url).tamanho + 8) * 4);
    const idat = png.indexOf("IDAT");
    const dados = inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
    expect(dados.length).toBe(largura * (largura + 1));
    expect(new Set(dados.filter((_, i) => i % (largura + 1) !== 0))).toEqual(new Set([0, 255]));
  });
});

describe("QR carimbado no .docx", () => {
  const modelo = new Uint8Array(readFileSync("modelos-docx/certificados/certificado_padrao_v2.docx"));
  const png = qr_png("https://cssosisa.netlify.app/validar/CSSO-2026-K7QMX-3FTB9-H");

  it("entra como imagem ancorada na página, sem mudar o texto", () => {
    const saida = carimbar_qr(modelo, png, 22);
    const zip = new PizZip(saida);
    const xml = zip.file("word/document.xml")!.asText();
    expect(xml).toContain("<wp:anchor");
    expect(xml).toContain('relativeFrom="page"');
    expect(zip.file("word/media/csso_qr_validacao.png")).toBeTruthy();
    expect(zip.file("word/_rels/document.xml.rels")!.asText()).toContain("csso_qr_validacao.png");
    expect(zip.file("[Content_Types].xml")!.asText()).toMatch(/Extension="png"/i);
    expect(extrair_texto(saida)).toBe(extrair_texto(modelo));
  });
});
