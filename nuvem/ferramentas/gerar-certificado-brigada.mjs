/**
 * Gera o modelo "Brigada CBMMG v1" (lote 4, 25/11/2026) em
 * `modelos-docx/certificados/certificado_brigada_cbmmg_v1.docx`, e a entrada dele no
 * `manifesto.json` (as outras entradas ficam como estão).
 *
 *   node ferramentas/gerar-certificado-brigada.mjs
 *
 * Parte de `modelos-docx/origem/Modelo_Certificado_Brigadista_Organico_CSSO.docx` só para herdar o
 * pacote (estilos, tema, página A4 paisagem) e as imagens: o fundo da frente com a marca e o fundo
 * do verso. O texto é o do Anexo I da Portaria CBMMG nº 54/2020 com as decisões do coordenador
 * (`docs/especificacoes/brigada-cbmmg/REFERENCIAS.md`). A assinatura fixa do coordenador do
 * modelo de origem NÃO vem: quem assina é o instrutor responsável pela formação.
 *
 * O texto fixo daqui e o do PDF (`certificado_pdf.ts`, `desenhar_brigada`) têm de ser o mesmo: o
 * teste de paridade (`certificado_brigada.test.ts`) compara frente e verso, palavra a palavra.
 *
 * Sintaxe do docxtemplater: `{campo}`, `{#lista}…{/lista}`, `{^campo}…{/campo}`.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PizZip from "pizzip";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const PASTA = path.resolve(aqui, "../modelos-docx");
const ORIGEM = path.join(PASTA, "origem/Modelo_Certificado_Brigadista_Organico_CSSO.docx");
const ARQUIVO = "certificados/certificado_brigada_cbmmg_v1.docx";
const LARGURA = 16838 - 2 * 1900; // A4 paisagem menos as margens do modelo de origem

const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const run = (texto, { b = false, sz = 22, cor = "" } = {}) =>
  `<w:r><w:rPr>${b ? "<w:b/>" : '<w:b w:val="0"/>'}${cor ? `<w:color w:val="${cor}"/>` : ""}<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr>` +
  `<w:t xml:space="preserve">${esc(texto)}</w:t></w:r>`;
const par = (runs, { jc = "center", antes = 0, depois = 0, borda_cima = false, quebra = false, recuo = 0 } = {}) =>
  `<w:p><w:pPr>${quebra ? "<w:pageBreakBefore/>" : ""}` +
  `${borda_cima ? '<w:pBdr><w:top w:val="single" w:sz="6" w:space="2" w:color="404040"/></w:pBdr>' : ""}` +
  `<w:spacing w:before="${antes}" w:after="${depois}" w:line="276" w:lineRule="auto"/>` +
  `${recuo ? `<w:ind w:left="${recuo}" w:right="${recuo}"/>` : ""}<w:jc w:val="${jc}"/></w:pPr>${runs}</w:p>`;
const BORDAS = ["top", "left", "bottom", "right", "insideH", "insideV"]
  .map((l) => `<w:${l} w:val="single" w:sz="4" w:space="0" w:color="808080"/>`)
  .join("");
const celula = (w, conteudo, { fundo = "" } = {}) =>
  `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${fundo ? `<w:shd w:val="clear" w:color="auto" w:fill="${fundo}"/>` : ""}` +
  `<w:vAlign w:val="center"/></w:tcPr>${conteudo}</w:tc>`;
const linha = (celulas, { cabecalho = false } = {}) =>
  `<w:tr><w:trPr><w:cantSplit/>${cabecalho ? "<w:tblHeader/>" : ""}</w:trPr>${celulas.join("")}</w:tr>`;

const FUNDO = "E8EEF4";

/** O parágrafo do fundo e da marca (frente) e o desenho do fundo (verso), do modelo de origem. */
function desenhos_da_origem(xml) {
  const corpo = xml.slice(xml.indexOf("<w:body>") + 8);
  const paragrafos = corpo.split("</w:p>");
  const frente = paragrafos.find((p) => p.includes('r:embed="rId7"'));
  const verso = paragrafos.find((p) => p.includes('r:embed="rId9"'));
  if (!frente || !verso) throw new Error("o modelo de origem mudou: não achei os desenhos rId7/rId9");
  const runs_frente = frente.match(/<w:r>\s*<w:drawing>[\s\S]*?<\/w:drawing>\s*<\/w:r>/g);
  const run_verso = verso.match(/<w:r>\s*<w:drawing>[\s\S]*?<\/w:drawing>\s*<\/w:r>/g);
  return { frente: runs_frente.join(""), verso: run_verso[0] };
}

function frente(desenhos) {
  return (
    par(desenhos.frente, { depois: 120 }) +
    par(run("CERTIFICADO", { b: true, sz: 48, cor: "0D4573" }), { depois: 200 }) +
    par(
      run("Certificamos que ") +
        run("{participante_nome}", { b: true }) +
        run(", portador(a) do CPF {participante_cpf}{participante_identidade_trecho}, concluiu com êxito a Formação do Curso de ") +
        run("{treinamento_nome}", { b: true }) +
        run(
          ", com carga horária de {treinamento_carga_horaria}, {citacao_legal}, promovido pelo Centro de Formação " +
            "{brigada_centro_nome}, CNPJ {brigada_centro_cnpj}, realizado no endereço situado à {brigada_endereco}.",
        ),
      { jc: "both", depois: 120, recuo: 400 },
    ) +
    par(run("Local de atuação do brigadista: {brigada_local_atuacao}."), { jc: "both", depois: 80, recuo: 400 }) +
    par(run("Curso realizado no período de {turma_data_inicio} a {turma_data_fim}."), { jc: "both", depois: 200, recuo: 400 }) +
    par(run("{cidade}, {certificado_data_extenso}."), { jc: "right", depois: 120, recuo: 400 }) +
    par(run("{brigada_instrutor_rubrica}"), { antes: 60 }) +
    par(run("{brigada_instrutor_linha}", { sz: 20 }), { borda_cima: true, recuo: 3200, depois: 200 }) +
    par(run("{certificado_qrcode}"), { jc: "left" }) +
    par(
      run(
        "Código do Certificado: {certificado_rotulo} · {certificado_frase_validade} · Verifique autenticidade em: {certificado_url_validacao}",
        { sz: 16, cor: "404040" },
      ),
      { jc: "left" },
    )
  );
}

function verso(desenhos) {
  const g = [Math.round(LARGURA * 0.6), Math.round(LARGURA * 0.2)];
  g.push(LARGURA - g[0] - g[1]);
  const cab = (w, t, jc = "left") => celula(w, par(run(t, { b: true, sz: 20 }), { jc, antes: 40, depois: 40 }), { fundo: FUNDO });
  const cel = (w, runs, jc = "left") => celula(w, par(runs, { jc, antes: 30, depois: 30 }));
  const quadro =
    `<w:tbl><w:tblPr><w:tblW w:w="${LARGURA}" w:type="dxa"/><w:jc w:val="center"/><w:tblLayout w:type="fixed"/>` +
    `<w:tblBorders>${BORDAS}</w:tblBorders>` +
    `<w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
    `<w:tblGrid>${g.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>` +
    linha([cab(g[0], "Disciplina"), cab(g[1], "Carga", "center"), cab(g[2], "Nota", "center")], { cabecalho: true }) +
    linha([
      // o agrupador em negrito; a linha teórica/prática, normal
      cel(g[0], run("{#brigada_quadro}{#agrupador}{rotulo}{/agrupador}", { b: true, sz: 20 }) + run("{^agrupador}{rotulo}{/agrupador}", { sz: 20 })),
      cel(g[1], run("{tempos}", { sz: 20 }), "center"),
      cel(g[2], run("{nota}{/brigada_quadro}", { sz: 20 }), "center"),
    ]) +
    `</w:tbl>`;
  return (
    par(desenhos.verso, { quebra: true }) +
    par(run("DISCIPLINAS E NOTAS", { b: true, sz: 32, cor: "0D4573" }), { depois: 200 }) +
    quadro +
    par(run("NOTA FINAL {brigada_nota_final}", { b: true, sz: 26 }), { antes: 240, depois: 120 }) +
    par(run("Cada tempo (t) equivale a 50 minutos.", { sz: 20 }), { depois: 240 }) +
    par(run("Código do Certificado: {certificado_rotulo} · Verifique autenticidade em: {certificado_url_validacao}", { sz: 16, cor: "404040" }), {
      jc: "left",
    })
  );
}

export const MARCADORES = [
  "brigada_centro_cnpj",
  "brigada_centro_nome",
  "brigada_endereco",
  "brigada_instrutor_linha",
  "brigada_instrutor_rubrica",
  "brigada_local_atuacao",
  "brigada_nota_final",
  "brigada_quadro",
  "certificado_data_extenso",
  "certificado_frase_validade",
  "certificado_qrcode",
  "certificado_rotulo",
  "certificado_url_validacao",
  "citacao_legal",
  "cidade",
  "participante_cpf",
  "participante_identidade_trecho",
  "participante_nome",
  "treinamento_carga_horaria",
  "treinamento_nome",
  "turma_data_fim",
  "turma_data_inicio",
];

const zip = new PizZip(readFileSync(ORIGEM));
const doc = zip.file("word/document.xml").asText();
const abertura = /^[\s\S]*?<w:body>/.exec(doc)[0];
const secao = /<w:sectPr[\s\S]*?<\/w:sectPr>/.exec(doc.slice(doc.lastIndexOf("<w:sectPr")))[0];
const desenhos = desenhos_da_origem(doc);
zip.file("word/document.xml", `${abertura}${frente(desenhos)}${verso(desenhos)}${secao}</w:body></w:document>`);
// a data fixa em cada parte do pacote: gerar de novo dá o mesmo arquivo (o SHA-256 vai ao manifesto)
const DATA_FIXA = new Date("2026-11-25T00:00:00Z");
for (const f of Object.values(zip.files)) f.date = DATA_FIXA;
const bytes = zip.generate({ type: "nodebuffer", compression: "DEFLATE" });
writeFileSync(path.join(PASTA, ARQUIVO), bytes);

const sha = createHash("sha256").update(bytes).digest("hex");
const caminho_manifesto = path.join(PASTA, "manifesto.json");
const manifesto = JSON.parse(readFileSync(caminho_manifesto, "utf8"));
manifesto[ARQUIVO] = { sha256_origem: sha, sha256_convertido: sha, marcadores: MARCADORES };
writeFileSync(caminho_manifesto, JSON.stringify(manifesto, null, 2) + "\n");
console.log(`${ARQUIVO} gerado (${bytes.length} bytes, SHA-256 ${sha.slice(0, 12)}…)`);
