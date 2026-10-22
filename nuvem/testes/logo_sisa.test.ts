/**
 * A marca da Sisa nos documentos que o sistema gera — menos no certificado,
 * que segue o modelo cadastrado pelo setor (DESVIOS.md, "Marca da Sisa").
 *
 * - lista de presença v2 e comprovante de EPI v2: a marca no cabeçalho do
 *   Word, e o TEXTO idêntico ao do v1 (o hash do comprovante não diverge);
 * - parecer v3: a marca ao lado do brasão e da UFVJM; v1 e v2 intactos, para
 *   reimprimir o que foi emitido com eles;
 * - papel impresso pelo navegador: a marca só no papel (`.so-papel`).
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import PizZip from "pizzip";
import { describe, expect, it } from "vitest";

process.env.CSSO_DIR_ARQUIVOS = mkdtempSync(path.join(tmpdir(), "csso-logo-"));

import * as documento from "../src/servicos/documento";
import * as lista_presenca from "../src/servicos/lista_presenca";
import * as comprovante_epi from "../src/servicos/comprovante_epi";
import { converter_modelo_docxtpl, medir_imagem } from "../src/servicos/docx_baixo_nivel";
import { ORIGEM } from "../ferramentas/converter-modelos-docx";
import { renderizar } from "../src/web.js";

const NUVEM = path.resolve(__dirname, "..");
const LOGO = path.join(NUVEM, "public/estaticos/img/logo-sisa.png");

/** As imagens que o cabeçalho padrão do documento desenha, pelo nome da mídia. */
function imagens_do_cabecalho(bytes: Uint8Array): string[] {
  const zip = new PizZip(bytes);
  const doc = zip.file("word/document.xml")!.asText();
  const rels_doc = zip.file("word/_rels/document.xml.rels")!.asText();
  const ref = /<w:headerReference w:type="default" r:id="([^"]+)"\/>/.exec(doc);
  if (!ref) return [];
  const parte = new RegExp(`Id="${ref[1]}"[^>]*Target="([^"]+)"`).exec(rels_doc)![1]!;
  const xml = zip.file(`word/${parte}`)!.asText();
  const rels = zip.file(`word/_rels/${parte}.rels`)?.asText() ?? "";
  return [...xml.matchAll(/<a:blip r:embed="([^"]+)"/g)].map(
    (m) => new RegExp(`Id="${m[1]}"[^>]*Target="([^"]+)"`).exec(rels)![1]!,
  );
}

function dados_quaisquer(relativo: string): Record<string, unknown> {
  const { marcadores } = converter_modelo_docxtpl(new Uint8Array(readFileSync(path.join(ORIGEM, relativo))));
  return Object.fromEntries(marcadores.map((m) => [m, m === "participantes" ? [{ nome: "«item»" }] : `«${m}»`]));
}

describe("marca da Sisa nos .docx", () => {
  it("o arquivo da marca é PNG na proporção do logotipo (~2,6:1), reduzido para papel", () => {
    const m = medir_imagem(new Uint8Array(readFileSync(LOGO)));
    expect(m.extensao).toBe("png");
    expect(m.largura / m.altura).toBeCloseTo(2.6, 1);
    expect(m.largura).toBeLessThanOrEqual(800);
  });

  it("a lista de presença e o comprovante saem no v2", () => {
    expect(lista_presenca.MODELO).toBe("lista_presenca_v2.docx");
    expect(comprovante_epi.MODELO).toBe("comprovante_epi_v2.docx");
  });

  it.each([
    ["lista_presenca_v1.docx", "lista_presenca_v2.docx"],
    ["comprovante_epi_v1.docx", "comprovante_epi_v2.docx"],
  ])("%s → %s: a marca no cabeçalho e o texto idêntico", async (v1, v2) => {
    const dados = dados_quaisquer(v1);
    const antigo = await documento.renderizar_modelo(v1, dados);
    const novo = await documento.renderizar_modelo(v2, dados);
    expect(imagens_do_cabecalho(antigo.bytes)).toEqual([]);
    expect(imagens_do_cabecalho(novo.bytes)).toEqual(["media/logo_sisa.png"]);
    const zip = new PizZip(novo.bytes);
    expect(zip.file("word/media/logo_sisa.png")!.asUint8Array()).toEqual(new Uint8Array(readFileSync(LOGO)));
    expect(zip.file("[Content_Types].xml")!.asText()).toMatch(/<Default Extension="png" ContentType="image\/png"\/>/);
    expect(zip.file("[Content_Types].xml")!.asText()).toContain('PartName="/word/header1.xml"');
    // a marca é imagem: o hash do texto não muda, e a segunda via de um
    // comprovante impresso no v1 não acusa divergência
    expect(novo.hash_conteudo).toBe(antigo.hash_conteudo);
  });

  it("parecer v3: brasão, UFVJM e Sisa no cabeçalho; o texto do v2 sem mudança", async () => {
    const dados = dados_quaisquer(documento.MODELO_V3);
    const v2 = await documento.renderizar_modelo(documento.MODELO_V2, dados);
    const v3 = await documento.renderizar_modelo(documento.MODELO_V3, dados);
    expect(imagens_do_cabecalho(v2.bytes)).toEqual(["media/image1.jpeg", "media/image2.png"]);
    expect(imagens_do_cabecalho(v3.bytes)).toEqual(["media/image1.jpeg", "media/image2.png", "media/logo_sisa.png"]);
    // só uma célula vazia a mais no cabeçalho: o corpo é o mesmo
    const corpo = (b: Uint8Array) => documento.extrair_texto(b).split("\n").filter(Boolean);
    expect(corpo(v3.bytes)).toEqual(corpo(v2.bytes));
  });

  it("v1 e v2 do parecer ficam intactos (reimpressão do emitido — RN-15)", async () => {
    for (const modelo of [documento.MODELO_V1, documento.MODELO_V2]) {
      const r = await documento.renderizar_modelo(modelo, dados_quaisquer(modelo));
      expect(imagens_do_cabecalho(r.bytes)).not.toContain("media/logo_sisa.png");
      expect(r.modelo_arquivo).toBe(modelo);
    }
  });

  it("o certificado não ganha a marca: segue o modelo cadastrado pelo setor", () => {
    for (const modelo of ["certificado_padrao_v1.docx", "certificado_padrao_v2.docx"]) {
      const zip = new PizZip(readFileSync(path.join(NUVEM, "modelos-docx/certificados", modelo)));
      expect(Object.keys(zip.files).filter((n) => n.includes("logo_sisa"))).toEqual([]);
    }
  });
});

describe("marca da Sisa no papel impresso pelo navegador", () => {
  const base = readFileSync(path.join(NUVEM, "templates/base.html"), "utf8");
  const css = readFileSync(path.join(NUVEM, "public/estaticos/css/csso.css"), "utf8");

  it("base.html leva a marca em toda tela, fora da casca, só para o papel", () => {
    expect(base).toMatch(/<div class="so-papel marca-papel"><img src="\/estaticos\/img\/logo-sisa.png"/);
    // antes da lateral e do conteúdo: é o alto da primeira folha
    expect(base.indexOf('class="so-papel marca-papel"')).toBeLessThan(base.indexOf("{% set com_casca"));
  });

  it("na tela some; no papel aparece (menos sobre a prévia do parecer, que já é timbrada)", () => {
    expect(css).toContain(".so-papel { display: none; }");
    const impressao = css.slice(css.indexOf("@media print {"));
    expect(impressao).toMatch(/^@media print \{\s*\.so-papel \{ display: block; \}/);
    expect(impressao).toContain("body:has(.previa) .marca-papel { display: none; }");
  });

  it("a prévia do parecer mostra a marca só no v3, como o .docx", () => {
    const c = { agentes_nocivos: [] };
    const previa = (modelo_arquivo: string | null) =>
      renderizar("partes/previa_parecer.html", { parecer: { modelo_arquivo }, c });
    expect(previa(documento.MODELO_V3)).toContain('src="/estaticos/img/logo-sisa.png"');
    for (const antigo of [documento.MODELO_V1, documento.MODELO_V2, null]) {
      expect(previa(antigo)).not.toContain("logo-sisa");
    }
  });
});
