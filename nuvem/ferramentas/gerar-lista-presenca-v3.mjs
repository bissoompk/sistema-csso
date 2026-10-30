/**
 * Gera os modelos da lista de presença v3 (A4 retrato) em `modelos-docx/`:
 * `lista_presenca_v3_d1.docx` … `_d5.docx`, um por quantidade de colunas de
 * assinatura (uma por dia da turma, até 5). Parte do v2 só para herdar o
 * pacote (estilos, tema) e o logo no cabeçalho; o corpo e o rodapé são novos.
 *
 *   node ferramentas/gerar-lista-presenca-v3.mjs
 *
 * A sintaxe é a do docxtemplater (`{campo}`, `{#lista}…{/lista}`).
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PizZip from "pizzip";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const PASTA = path.resolve(aqui, "../modelos-docx");
const LARGURA = 10206; // A4 (11906) menos as margens de 850

const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const run = (texto, { b = false, sz = 18, cor = "" } = {}) =>
  `<w:r><w:rPr>${b ? "<w:b/>" : '<w:b w:val="0"/>'}${cor ? `<w:color w:val="${cor}"/>` : ""}<w:sz w:val="${sz}"/></w:rPr>` +
  `<w:t xml:space="preserve">${esc(texto)}</w:t></w:r>`;
const par = (runs, { jc = "left", antes = 0, depois = 0, keep = false } = {}) =>
  `<w:p><w:pPr>${keep ? "<w:keepNext/>" : ""}<w:spacing w:before="${antes}" w:after="${depois}"/><w:jc w:val="${jc}"/></w:pPr>${runs}</w:p>`;
const BORDAS = (cor = "808080", sz = 4) =>
  ["top", "left", "bottom", "right", "insideH", "insideV"].map((l) => `<w:${l} w:val="single" w:sz="${sz}" w:space="0" w:color="${cor}"/>`).join("");
const tabela = (grade, linhas, { bordas = true } = {}) =>
  `<w:tbl><w:tblPr><w:tblW w:w="${LARGURA}" w:type="dxa"/><w:tblLayout w:type="fixed"/>` +
  `${bordas ? `<w:tblBorders>${BORDAS()}</w:tblBorders>` : ""}` +
  `<w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
  `<w:tblGrid>${grade.map((g) => `<w:gridCol w:w="${g}"/>`).join("")}</w:tblGrid>${linhas.join("")}</w:tbl>`;
const celula = (w, conteudo, { span = 1, fundo = "", valign = "center", bordas = "" } = {}) =>
  `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ""}` +
  `${bordas ? `<w:tcBorders>${bordas}</w:tcBorders>` : ""}` +
  `${fundo ? `<w:shd w:val="clear" w:color="auto" w:fill="${fundo}"/>` : ""}<w:vAlign w:val="${valign}"/></w:tcPr>${conteudo}</w:tc>`;
const linha = (celulas, { altura = 0, cabecalho = false } = {}) =>
  `<w:tr><w:trPr><w:cantSplit/>${altura ? `<w:trHeight w:val="${altura}" w:hRule="atLeast"/>` : ""}${cabecalho ? "<w:tblHeader/>" : ""}</w:trPr>${celulas.join("")}</w:tr>`;

const FUNDO = "E8EEF4";

function identificacao() {
  const g = [1700, 3403, 1700, 3403];
  const rot = (t) => celula(g[0], par(run(t, { b: true, sz: 17 }), { antes: 40, depois: 40 }), { fundo: FUNDO });
  const val = (v, w = g[1], span = 1) => celula(w, par(run(v, { sz: 18 }), { antes: 40, depois: 40 }), { span });
  const rot2 = (t) => celula(g[2], par(run(t, { b: true, sz: 17 }), { antes: 40, depois: 40 }), { fundo: FUNDO });
  return tabela(g, [
    linha([rot("Treinamento"), celula(g[1] + g[2] + g[3], par(run("{treinamento}", { b: true, sz: 20 }), { antes: 40, depois: 40 }), { span: 3 })]),
    linha([rot("Turma"), val("{turma_codigo}"), rot2("Período"), val("{periodo}", g[3])]),
    linha([rot("Horário"), val("{horario}"), rot2("Carga horária"), val("{carga_horaria}", g[3])]),
    linha([rot("Local"), val("{local}"), rot2("Campus"), val("{campus}", g[3])]),
    linha([rot("Unidade promotora"), val("{unidade_promotora}", g[1] + g[2] + g[3], 3)]),
    linha([
      rot("Instrutor(es)"),
      celula(g[1] + g[2] + g[3], `<w:p><w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr><w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">{instrutores}</w:t></w:r></w:p>`, { span: 3 }),
    ]),
    linha([rot("Frequência mínima"), val("{frequencia_minima}"), rot2("Nota mínima"), val("{nota_minima}", g[3])]),
  ]);
}

function presenca(dias) {
  const fixas = [450, 3100, 1500, 1150]; // Nº, participante, identificador, vínculo
  const sobra = LARGURA - fixas.reduce((a, b) => a + b, 0);
  const larg = Math.floor(sobra / dias);
  const colunas = Array.from({ length: dias }, (_, i) => (i === dias - 1 ? sobra - larg * (dias - 1) : larg));
  const grade = [...fixas, ...colunas];
  const cab = (w, t, jc = "left") => celula(w, par(run(t, { b: true, sz: 16 }), { jc, antes: 40, depois: 40 }), { fundo: FUNDO });
  const cabecalho = linha(
    [
      cab(fixas[0], "Nº", "center"),
      cab(fixas[1], "Participante"),
      cab(fixas[2], "Identificador"),
      cab(fixas[3], "Vínculo"),
      ...colunas.map((w, i) => cab(w, `{d${i + 1}}`, "center")),
    ],
    { cabecalho: true },
  );
  const dado = (laco) => {
    const abre = `{#${laco}}`;
    const fecha = `{/${laco}}`;
    const c = (w, texto, jc = "left") => celula(w, par(run(texto, { sz: 18 }), { jc }));
    return linha(
      [
        c(fixas[0], `${abre}{ordem}`, "center"),
        c(fixas[1], "{nome}"),
        c(fixas[2], "{identificador}"),
        c(fixas[3], `{vinculo}${fecha}`),
        ...colunas.map((w) => c(w, "")),
      ],
      { altura: 560 },
    );
  };
  return tabela(grade, [cabecalho, dado("participantes"), dado("extras")]);
}

function fechamento() {
  const caixa = tabela(
    [LARGURA],
    [
      linha([celula(LARGURA, par(run("Observações", { b: true, sz: 16 }), { antes: 30 }) + par("") + par("") + par(""), { valign: "top" })], { altura: 1100 }),
    ],
  );
  const sem = '<w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/>';
  const traco = '<w:top w:val="single" w:sz="6" w:space="0" w:color="000000"/>';
  const meio = Math.floor((LARGURA - 600) / 2);
  const assinaturas = tabela(
    [meio, 600, meio],
    [
      linha([celula(meio, par(""), { bordas: sem }), celula(600, par(""), { bordas: sem }), celula(meio, par(""), { bordas: sem })], { altura: 700 }),
      linha([
        celula(meio, par(run("Assinatura do(s) instrutor(es)", { sz: 17 }), { jc: "center", antes: 40 }), { bordas: sem + traco }),
        celula(600, par(""), { bordas: sem }),
        celula(meio, par(run("Responsável pela CSSO", { sz: 17 }), { jc: "center", antes: 40 }), { bordas: sem + traco }),
      ]),
    ],
    { bordas: false },
  );
  return (
    par(run("{total} participante(s) inscrito(s) · linhas em branco para quem comparecer sem inscrição.", { sz: 16 }), { antes: 120, depois: 120 }) +
    caixa +
    par("", { depois: 120 }) +
    assinaturas
  );
}

function campo(instrucao) {
  return (
    `<w:r><w:rPr><w:sz w:val="16"/></w:rPr><w:fldChar w:fldCharType="begin"/></w:r>` +
    `<w:r><w:rPr><w:sz w:val="16"/></w:rPr><w:instrText xml:space="preserve"> ${instrucao} </w:instrText></w:r>` +
    `<w:r><w:rPr><w:sz w:val="16"/></w:rPr><w:fldChar w:fldCharType="separate"/></w:r>` +
    `<w:r><w:rPr><w:sz w:val="16"/></w:rPr><w:t>1</w:t></w:r>` +
    `<w:r><w:rPr><w:sz w:val="16"/></w:rPr><w:fldChar w:fldCharType="end"/></w:r>`
  );
}

const RODAPE =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
  `<w:p><w:pPr><w:pBdr><w:top w:val="single" w:sz="4" w:space="4" w:color="808080"/></w:pBdr><w:tabs><w:tab w:val="right" w:pos="${LARGURA}"/></w:tabs><w:spacing w:before="0" w:after="0"/></w:pPr>` +
  `${run("{turma_codigo} · lista gerada em {gerada_em}", { sz: 16, cor: "595959" })}` +
  `<w:r><w:tab/></w:r>${run("Página ", { sz: 16, cor: "595959" })}${campo("PAGE")}${run(" de ", { sz: 16, cor: "595959" })}${campo("NUMPAGES")}</w:p></w:ftr>`;

function corpo(dias) {
  return (
    par(run("{setor_nome}", { sz: 20 }), { jc: "center" }) +
    par(run("{setor_sigla} · {cidade}", { sz: 18 }), { jc: "center", depois: 80 }) +
    par(run("LISTA DE PRESENÇA", { b: true, sz: 30 }), { jc: "center", depois: 160 }) +
    identificacao() +
    par("", { depois: 120 }) +
    presenca(dias) +
    fechamento() +
    `<w:sectPr><w:headerReference w:type="default" r:id="rId9"/><w:footerReference w:type="default" r:id="rIdRod"/>` +
    `<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1300" w:right="850" w:bottom="900" w:left="850" w:header="400" w:footer="400" w:gutter="0"/>` +
    `<w:cols w:space="720"/><w:docGrid w:linePitch="360"/></w:sectPr>`
  );
}

const base = readFileSync(path.join(PASTA, "lista_presenca_v2.docx"));
for (let dias = 1; dias <= 5; dias++) {
  const zip = new PizZip(base);
  const doc = zip.file("word/document.xml").asText();
  const abertura = /^[\s\S]*?<w:body>/.exec(doc)[0];
  zip.file("word/document.xml", `${abertura}${corpo(dias)}</w:body></w:document>`);
  zip.file("word/footer1.xml", RODAPE);
  zip.file(
    "word/_rels/document.xml.rels",
    zip.file("word/_rels/document.xml.rels").asText().replace(
      "</Relationships>",
      `<Relationship Id="rIdRod" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`,
    ),
  );
  zip.file(
    "[Content_Types].xml",
    zip.file("[Content_Types].xml").asText().replace(
      "</Types>",
      `<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>`,
    ),
  );
  writeFileSync(path.join(PASTA, `lista_presenca_v3_d${dias}.docx`), zip.generate({ type: "nodebuffer", compression: "DEFLATE" }));
}
console.log("lista_presenca_v3_d1..d5 gerados em", PASTA);
