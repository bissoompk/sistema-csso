/**
 * O que o `docxtpl` e o `python-docx` faziam por baixo do `documento.py`, e o
 * docxtemplater não faz do mesmo jeito. Três peças:
 *
 * 1. **Conversão de modelo** (`converter_modelo_docxtpl`): os `.docx` do
 *    sistema foram escritos para o docxtpl (Jinja2 dentro do Word:
 *    `{{ x }}`, `{{r x }}`, `{%p if c %}`, `{%tr for p in l %}`). O
 *    docxtemplater usa `{x}`, `{#c}...{/c}`. A conversão refaz os passos de
 *    limpeza do `DocxTemplate.patch_xml` (tag quebrada entre runs, a run
 *    isolada do `{{r}}`, o elemento inteiro trocado pela tag nos `{%p}`/`{%tr}`)
 *    e traduz a sintaxe. Roda uma vez, na ferramenta
 *    `ferramentas/converter-modelos-docx.ts`, e o resultado mora em
 *    `modelos-docx/`.
 * 2. **Pós-processamento do render** (`resolver_listagem`,
 *    `embutir_imagens`): o `resolve_listing` do docxtpl (`\a` vira parágrafo
 *    novo com o mesmo pPr, `\n` vira `<w:br/>`, `\t` vira `<w:tab/>`) e a
 *    imagem em linha (o `InlineImage` do docxtpl; o módulo de imagem do
 *    docxtemplater é pago, então o `<w:drawing>` é montado aqui).
 * 3. **Extração de texto** (`extrair_texto_docx`): o `Document(...).paragraphs`
 *    / `tables` / `header` / `footer` do python-docx, com as mesmas regras de
 *    célula mesclada — o `hash_conteudo` e o CA-01 dependem de o texto sair
 *    igual.
 */
import PizZip from "pizzip";

// Marcadores de uso privado que atravessam o docxtemplater dentro de <w:t> e
// são resolvidos depois do render. `\a` (0x07) não é caractere XML válido, e
// por isso não pode ir cru como ia no docxtpl.
export const MARCA_PARAGRAFO = ""; // o `\a` do RichText
export const MARCA_PAGINA = ""; // o `\f`
export const MARCA_IMAGEM_INICIO = "";
export const MARCA_IMAGEM_FIM = "";
const MARCA_TR_INICIO = "";
const MARCA_TR_FIM = "";

/** As partes XML que o docxtpl renderiza (corpo, cabeçalhos, rodapés, notas). */
export function partes_renderizaveis(zip: PizZip): string[] {
  return Object.keys(zip.files).filter((n) =>
    /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(n),
  );
}

// =====================================================================
// 1. Conversão docxtpl -> docxtemplater
// =====================================================================
export class ModeloIncompativel extends Error {}

/** Os passos de limpeza do `DocxTemplate.patch_xml` (docxtpl 0.20). */
function limpar_como_docxtpl(xml: string): string {
  // {<tags>{ -> {{ (e o mesmo para %, #, e no fechamento)
  xml = xml.replace(/(?<=\{)(<[^>]*>)+(?=[{%#])|(?<=[%}#])(<[^>]*>)+(?=\})/gs, "");
  // {{<tags>coisa<tags>}} -> {{coisa}}: tira os fechamentos/aberturas de <w:t>
  // que o Word espalhou no meio da tag
  xml = xml.replace(/\{%(?:(?!%\}).)*|\{#(?:(?!#\}).)*|\{\{(?:(?!\}\}).)*/gs, (m) =>
    m.replace(/<\/w:t>.*?(<w:t>|<w:t [^>]*>)/gs, ""),
  );
  if (/\{%\s*(colspan|cellbg|vm|hm)\b/.test(xml)) {
    throw new ModeloIncompativel("o modelo usa colspan/cellbg/vm/hm do docxtpl, que o porte não converte");
  }
  if (/\{%-|-%\}/.test(xml)) {
    throw new ModeloIncompativel("o modelo usa controle de espaço do Jinja ({%- / -%}), que o porte não converte");
  }
  // <w:t> que contém tag preserva espaço
  xml = xml.replace(/<w:t>((?:(?!<w:t>).)*)(\{\{.*?\}\}|\{%.*?%\})/gs, '<w:t xml:space="preserve">$1$2');
  // {{r x}} ganha uma run só dela — SEM o rPr da run original, como no docxtpl
  // (o RichText sai com a formatação do parágrafo, não a da run do marcador)
  xml = xml.replace(
    /(\{\{r\s.*?\}\}|\{%r\s.*?%\})/gs,
    '</w:t></w:r><w:r><w:t xml:space="preserve">$1</w:t></w:r><w:r><w:t xml:space="preserve">',
  );
  // aspas tipográficas e entidades dentro das tags (o `clean_tags`)
  xml = xml.replace(/(?<=\{[{%])(.*?)(?=[}%]\})/gs, (m) =>
    m
      .replaceAll("&#8216;", "'")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("“", '"')
      .replaceAll("”", '"')
      .replaceAll("‘", "'")
      .replaceAll("’", "'"),
  );
  return xml;
}

/**
 * O elemento inteiro (`<w:tr>`, `<w:p>`, `<w:r>`) que contém `{%y ...%}` /
 * `{{y ...}}` dá lugar à tag. É o mesmo padrão do docxtpl; o que muda é o que
 * fica no lugar, porque o docxtemplater precisa da tag dentro de um `<w:t>`.
 */
function trocar_elementos(xml: string): string {
  for (const y of ["tr", "tc", "p", "r"]) {
    const padrao = new RegExp(
      `<w:${y}[ >](?:(?!<w:${y}[ >]).)*(\\{%|\\{\\{)${y} ([^}%]*(?:%\\}|\\}\\})).*?</w:${y}>`,
      "gs",
    );
    xml = xml.replace(padrao, (_m, abre: string, resto: string) => {
      const tag = `${abre} ${resto}`;
      if (y === "tc") throw new ModeloIncompativel("tag {%tc ...%} não é convertida pelo porte");
      if (y === "r") return `<w:r><w:t xml:space="preserve">${tag}</w:t></w:r>`;
      if (y === "p") return `<w:p><w:r><w:t xml:space="preserve">${tag}</w:t></w:r></w:p>`;
      // tr: some a linha inteira; a tag vai para a(s) linha(s) do meio depois
      return `${MARCA_TR_INICIO}${tag}${MARCA_TR_FIM}`;
    });
  }
  return xml;
}

const NOME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Traduz as tags Jinja que sobraram para a sintaxe do docxtemplater. */
function traduzir_tags(xml: string): { xml: string; marcadores: string[] } {
  const pilha: { tipo: "if" | "for"; nome: string; variavel?: string }[] = [];
  const marcadores = new Set<string>();
  const saida = xml.replace(/\{\{(.*?)\}\}|\{%(.*?)%\}/gs, (_m, expr?: string, stmt?: string) => {
    if (expr !== undefined) {
      let nome = expr.trim();
      const laco = [...pilha].reverse().find((p) => p.tipo === "for");
      if (laco?.variavel && nome.startsWith(laco.variavel + ".")) nome = nome.slice(laco.variavel.length + 1);
      if (!NOME.test(nome)) throw new ModeloIncompativel(`expressão não suportada no modelo: {{ ${expr.trim()} }}`);
      // campo do item do laço (`p.nome`) não é marcador do documento: é da lista
      if (!(laco?.variavel && expr.trim().startsWith(laco.variavel + "."))) marcadores.add(nome);
      return `{${nome}}`;
    }
    const s = stmt!.trim();
    let m: RegExpExecArray | null;
    if ((m = /^if\s+(not\s+)?([A-Za-z_]\w*)$/.exec(s))) {
      pilha.push({ tipo: "if", nome: m[2]! });
      marcadores.add(m[2]!);
      return m[1] ? `{^${m[2]}}` : `{#${m[2]}}`;
    }
    if ((m = /^for\s+([A-Za-z_]\w*)\s+in\s+([A-Za-z_]\w*)$/.exec(s))) {
      pilha.push({ tipo: "for", nome: m[2]!, variavel: m[1]! });
      marcadores.add(m[2]!);
      return `{#${m[2]}}`;
    }
    if (s === "endif" || s === "endfor") {
      const topo = pilha.pop();
      if (!topo || topo.tipo !== (s === "endif" ? "if" : "for")) {
        throw new ModeloIncompativel(`{% ${s} %} sem abertura correspondente`);
      }
      return `{/${topo.nome}}`;
    }
    throw new ModeloIncompativel(`instrução não suportada no modelo: {% ${s} %}`);
  });
  if (pilha.length) throw new ModeloIncompativel(`bloco não fechado: ${pilha.map((p) => p.nome).join(", ")}`);
  return { xml: saida, marcadores: [...marcadores] };
}

/**
 * O laço de linha: a linha do `{%tr for%}` e a do `{%tr endfor%}` somem, e a
 * abertura e o fechamento vão para o primeiro e o último `<w:t>` das linhas do
 * meio — o docxtemplater repete as linhas entre eles.
 */
function montar_lacos_de_linha(xml: string): string {
  const re = new RegExp(`${MARCA_TR_INICIO}(\\{#[^}]+\\})${MARCA_TR_FIM}(.*?)${MARCA_TR_INICIO}(\\{/[^}]+\\})${MARCA_TR_FIM}`, "gs");
  return xml.replace(re, (_m, abre: string, meio: string, fecha: string) => {
    const primeiro = /<w:t(?: [^>]*)?>/.exec(meio);
    const ultimo = meio.lastIndexOf("</w:t>");
    if (!primeiro || ultimo < 0) throw new ModeloIncompativel("laço de linha sem texto na linha repetida");
    const ini = primeiro.index + primeiro[0].length;
    return meio.slice(0, ini) + abre + meio.slice(ini, ultimo) + fecha + meio.slice(ultimo);
  });
}

/** Texto de todos os `<w:t>` de um XML (para conferir chave solta). */
function textos_de_wt(xml: string): string[] {
  return [...xml.matchAll(/<w:t(?: [^>]*)?>(.*?)<\/w:t>/gs)].map((m) => m[1]!);
}

export interface ModeloConvertido {
  bytes: Uint8Array;
  /** os nomes que o modelo lê (variáveis, condições e listas) */
  marcadores: string[];
}

/** Converte um `.docx` com sintaxe docxtpl para a do docxtemplater. */
export function converter_modelo_docxtpl(origem: Uint8Array): ModeloConvertido {
  const zip = new PizZip(origem);
  const marcadores = new Set<string>();
  for (const nome of partes_renderizaveis(zip)) {
    const original = zip.file(nome)!.asText();
    let xml = original;
    if (/\{\{|\{%|\{#/.test(original.replace(/<[^>]+>/g, ""))) {
      xml = limpar_como_docxtpl(xml);
      xml = trocar_elementos(xml);
      const traduzido = traduzir_tags(xml);
      xml = montar_lacos_de_linha(traduzido.xml);
      if (xml.includes(MARCA_TR_INICIO) || xml.includes(MARCA_TR_FIM)) {
        throw new ModeloIncompativel(`laço de linha mal formado em ${nome}`);
      }
      traduzido.marcadores.forEach((m) => marcadores.add(m));
    }
    // nada de sintaxe Jinja pode sobrar, e toda chave restante é tag válida:
    // chave solta no texto do modelo seria lida como tag pelo docxtemplater
    for (const t of textos_de_wt(xml)) {
      if (/\{\{|\{%|%\}|\}\}/.test(t)) throw new ModeloIncompativel(`tag Jinja não convertida em ${nome}: ${t}`);
      const resto = t.replace(/\{[#/^]?[A-Za-z_]\w*\}/g, "");
      if (/[{}]/.test(resto)) throw new ModeloIncompativel(`chave solta ou tag partida em ${nome}: ${t}`);
    }
    if (xml !== original) zip.file(nome, xml);
  }
  return {
    bytes: zip.generate({ type: "uint8array", compression: "DEFLATE" }),
    marcadores: [...marcadores].sort(),
  };
}

// =====================================================================
// 2. Depois do render: o `resolve_listing` do docxtpl e as imagens
// =====================================================================
/**
 * `\a` (aqui `MARCA_PARAGRAFO`) fecha o parágrafo e abre outro com o mesmo
 * pPr e o rPr da run; `\n` vira `<w:br/>`; `\t` vira `<w:tab/>`; `\f` quebra
 * página. Porte literal do `DocxTemplate.resolve_listing`.
 */
export function resolver_listagem(xml: string): string {
  const resolverTexto = (rPr: string, pPr: string, trecho: string): string => {
    let x = trecho.replaceAll(
      "\t",
      `</w:t></w:r><w:r>${rPr}<w:tab/></w:r><w:r>${rPr}<w:t xml:space="preserve">`,
    );
    x = x.replaceAll(
      MARCA_PARAGRAFO,
      `</w:t></w:r></w:p><w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">`,
    );
    x = x.replaceAll("\n", '</w:t><w:br/><w:t xml:space="preserve">');
    x = x.replaceAll(
      MARCA_PAGINA,
      `</w:t></w:r></w:p><w:p><w:r><w:br w:type="page"/></w:r></w:p><w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">`,
    );
    return x;
  };
  const resolverRun = (pPr: string, run: string): string => {
    const rPr = /<w:rPr>.*?<\/w:rPr>/s.exec(run)?.[0] ?? "";
    return run.replace(/<w:t(?: [^>]*)?>.*?<\/w:t>/gs, (t) => resolverTexto(rPr, pPr, t));
  };
  return xml.replace(/<w:p(?: [^>]*)?>.*?<\/w:p>/gs, (p) => {
    if (!/[\t\n]/.test(p)) return p;
    const pPr = /<w:pPr>.*?<\/w:pPr>/s.exec(p)?.[0] ?? "";
    return p.replace(/<w:r(?: [^>]*)?>.*?<\/w:r>/gs, (r) => resolverRun(pPr, r));
  });
}

export interface ImagemPronta {
  bytes: Uint8Array;
  extensao: "png" | "jpeg" | "gif";
  largura_emu: number;
  altura_emu: number;
}

/** Dimensões em pixels e DPI de PNG/JPEG/GIF, lidas do cabeçalho. */
export function medir_imagem(b: Uint8Array): { extensao: ImagemPronta["extensao"]; largura: number; altura: number; dpi_x: number; dpi_y: number } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // PNG: assinatura + IHDR; pHYs dá a densidade
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const largura = dv.getUint32(16);
    const altura = dv.getUint32(20);
    let dpi_x = 72;
    let dpi_y = 72;
    let pos = 8;
    while (pos + 8 <= b.length) {
      const tam = dv.getUint32(pos);
      const tipo = String.fromCharCode(b[pos + 4]!, b[pos + 5]!, b[pos + 6]!, b[pos + 7]!);
      if (tipo === "pHYs" && pos + 17 <= b.length && b[pos + 16] === 1) {
        dpi_x = Math.round(dv.getUint32(pos + 8) * 0.0254) || 72;
        dpi_y = Math.round(dv.getUint32(pos + 12) * 0.0254) || 72;
      }
      if (tipo === "IDAT" || tipo === "IEND") break;
      pos += 12 + tam;
    }
    return { extensao: "png", largura, altura, dpi_x, dpi_y };
  }
  // JPEG: procura o SOF; APP0/JFIF dá a densidade
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let pos = 2;
    let dpi_x = 72;
    let dpi_y = 72;
    while (pos + 4 <= b.length) {
      if (b[pos] !== 0xff) {
        pos++;
        continue;
      }
      const marca = b[pos + 1]!;
      const tam = dv.getUint16(pos + 2);
      if (marca === 0xe0 && String.fromCharCode(...b.slice(pos + 4, pos + 9)) === "JFIF\0") {
        const unidade = b[pos + 11];
        const dx = dv.getUint16(pos + 12);
        const dy = dv.getUint16(pos + 14);
        if (unidade === 1 && dx && dy) [dpi_x, dpi_y] = [dx, dy];
        if (unidade === 2 && dx && dy) [dpi_x, dpi_y] = [Math.round(dx * 2.54), Math.round(dy * 2.54)];
      }
      if (marca >= 0xc0 && marca <= 0xcf && marca !== 0xc4 && marca !== 0xc8 && marca !== 0xcc) {
        return { extensao: "jpeg", altura: dv.getUint16(pos + 5), largura: dv.getUint16(pos + 7), dpi_x, dpi_y };
      }
      pos += 2 + tam;
    }
  }
  if (b.length > 10 && String.fromCharCode(b[0]!, b[1]!, b[2]!) === "GIF") {
    return { extensao: "gif", largura: dv.getUint16(6, true), altura: dv.getUint16(8, true), dpi_x: 72, dpi_y: 72 };
  }
  throw new Error("formato de imagem não reconhecido (PNG, JPEG ou GIF)");
}

const EMU_POR_MM = 36000;
const EMU_POR_POLEGADA = 914400;

/**
 * O tamanho que o `InlineImage(width=Mm(x))` do docxtpl dava: largura fixa e
 * altura na proporção; sem largura, o tamanho nativo pelo DPI da imagem.
 */
export function preparar_imagem(bytes: Uint8Array, largura_mm: number | null): ImagemPronta {
  const m = medir_imagem(bytes);
  const nativa_x = Math.round((m.largura * EMU_POR_POLEGADA) / m.dpi_x);
  const nativa_y = Math.round((m.altura * EMU_POR_POLEGADA) / m.dpi_y);
  if (!largura_mm) return { bytes, extensao: m.extensao, largura_emu: nativa_x, altura_emu: nativa_y };
  const largura_emu = Math.round(largura_mm * EMU_POR_MM);
  const altura_emu = nativa_x ? Math.round((nativa_y * largura_emu) / nativa_x) : largura_emu;
  return { bytes, extensao: m.extensao, largura_emu, altura_emu };
}

/**
 * Troca cada marcador de imagem pela `<w:drawing>` em linha e grava a mídia,
 * a relação e o tipo de conteúdo no pacote. Só no `document.xml` (é onde o
 * docxtpl também embutia).
 */
export function embutir_imagens(zip: PizZip, parte: string, imagens: ImagemPronta[]): void {
  if (!imagens.length) return;
  let xml = zip.file(parte)!.asText();
  if (!xml.includes(MARCA_IMAGEM_INICIO)) return;
  const relsNome = parte.replace(/^word\//, "word/_rels/") + ".rels";
  let rels =
    zip.file(relsNome)?.asText() ??
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  let tipos = zip.file("[Content_Types].xml")!.asText();
  const usados = new Set([...rels.matchAll(/Id="([^"]+)"/g)].map((m) => m[1]));
  let docPr = Math.max(0, ...[...xml.matchAll(/<wp:docPr [^>]*id="(\d+)"/g)].map((m) => Number(m[1]))) + 1;

  const rIds = imagens.map((img, i) => {
    let n = 1;
    while (usados.has(`rIdCsso${n}`)) n++;
    const rId = `rIdCsso${n}`;
    usados.add(rId);
    const midia = `media/csso_imagem_${Date.now().toString(36)}_${i}.${img.extensao === "jpeg" ? "jpeg" : img.extensao}`;
    zip.file(`word/${midia}`, img.bytes);
    rels = rels.replace(
      "</Relationships>",
      `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${midia}"/></Relationships>`,
    );
    const ext = img.extensao === "jpeg" ? "jpeg" : img.extensao;
    if (!new RegExp(`<Default Extension="${ext}"`, "i").test(tipos)) {
      tipos = tipos.replace("</Types>", `<Default Extension="${ext}" ContentType="image/${img.extensao}"/></Types>`);
    }
    return rId;
  });

  const desenho = (i: number): string => {
    const img = imagens[i]!;
    const id = docPr++;
    return (
      `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
      `<wp:extent cx="${img.largura_emu}" cy="${img.altura_emu}"/>` +
      `<wp:docPr id="${id}" name="Imagem ${id}"/>` +
      `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
      `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
      `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      `<pic:nvPicPr><pic:cNvPr id="0" name="imagem${i}.${img.extensao}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${rIds[i]}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${img.largura_emu}" cy="${img.altura_emu}"/></a:xfrm>` +
      `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>` +
      `</wp:inline></w:drawing>`
    );
  };

  // dentro de cada run, o marcador parte a run: texto antes | desenho | texto depois
  xml = xml.replace(/<w:r(?: [^>]*)?>.*?<\/w:r>/gs, (run) => {
    if (!run.includes(MARCA_IMAGEM_INICIO)) return run;
    const rPr = /<w:rPr>.*?<\/w:rPr>/s.exec(run)?.[0] ?? "";
    return run.replace(new RegExp(`${MARCA_IMAGEM_INICIO}(\\d+)${MARCA_IMAGEM_FIM}`, "g"), (_m, n: string) =>
      `</w:t></w:r><w:r>${rPr}${desenho(Number(n))}</w:r><w:r>${rPr}<w:t xml:space="preserve">`,
    );
  });
  // os namespaces que o desenho usa (o Word sempre declara; modelo gerado por
  // biblioteca às vezes não)
  const raiz = /<w:(document|hdr|ftr)\b[^>]*>/.exec(xml)!;
  let abertura = raiz[0];
  if (!/xmlns:wp=/.test(abertura)) {
    abertura = abertura.replace(/>$/, ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">');
  }
  if (!/xmlns:r=/.test(abertura)) {
    abertura = abertura.replace(/>$/, ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">');
  }
  xml = xml.replace(raiz[0], abertura);
  zip.file(parte, xml);
  zip.file(relsNome, rels);
  zip.file("[Content_Types].xml", tipos);
}

// =====================================================================
// 3. Extração de texto — o python-docx
// =====================================================================
interface No {
  nome: string;
  attrs: Record<string, string>;
  filhos: (No | string)[];
}

function decodificar(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_m, e: string) => {
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "amp") return "&";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
}

/** Árvore mínima de um XML bem formado (o que o Word grava). */
export function analisar_xml(xml: string): No {
  const raiz: No = { nome: "#raiz", attrs: {}, filhos: [] };
  const pilha: No[] = [raiz];
  const re = /<!\[CDATA\[(.*?)\]\]>|<!--.*?-->|<\?.*?\?>|<!DOCTYPE[^>]*>|<(\/?)([^\s/>]+)((?:\s+[^\s=]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const topo = pilha[pilha.length - 1]!;
    if (m[1] !== undefined) {
      topo.filhos.push(m[1]);
    } else if (m[6] !== undefined) {
      topo.filhos.push(decodificar(m[6]));
    } else if (m[3] !== undefined) {
      if (m[2] === "/") {
        pilha.pop();
        continue;
      }
      const attrs: Record<string, string> = {};
      for (const a of (m[4] ?? "").matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        attrs[a[1]!] = decodificar(a[2] ?? a[3] ?? "");
      }
      const no: No = { nome: m[3], attrs, filhos: [] };
      topo.filhos.push(no);
      if (m[5] !== "/") pilha.push(no);
    }
  }
  return raiz;
}

const filhos = (no: No, nome?: string): No[] =>
  no.filhos.filter((f): f is No => typeof f !== "string" && (nome === undefined || f.nome === nome));
const filho = (no: No, nome: string): No | undefined => filhos(no, nome)[0];
const texto_de = (no: No): string => no.filhos.filter((f): f is string => typeof f === "string").join("");

/** `Run.text` do python-docx. */
function texto_run(r: No): string {
  let s = "";
  for (const e of filhos(r)) {
    if (e.nome === "w:t") s += texto_de(e);
    else if (e.nome === "w:tab" || e.nome === "w:ptab") s += "\t";
    else if (e.nome === "w:br") s += (e.attrs["w:type"] ?? "textWrapping") === "textWrapping" ? "\n" : "";
    else if (e.nome === "w:cr") s += "\n";
    else if (e.nome === "w:noBreakHyphen") s += "-";
  }
  return s;
}

/** `Paragraph.text`: runs e hyperlinks diretos. */
function texto_paragrafo(p: No): string {
  let s = "";
  for (const e of filhos(p)) {
    if (e.nome === "w:r") s += texto_run(e);
    else if (e.nome === "w:hyperlink") s += filhos(e, "w:r").map(texto_run).join("");
  }
  return s;
}

function grid_span(tc: No): number {
  const v = filho(filho(tc, "w:tcPr") ?? { nome: "", attrs: {}, filhos: [] }, "w:gridSpan")?.attrs["w:val"];
  return v ? Number(v) : 1;
}
function v_merge(tc: No): string | null {
  const vm = filho(filho(tc, "w:tcPr") ?? { nome: "", attrs: {}, filhos: [] }, "w:vMerge");
  if (!vm) return null;
  return vm.attrs["w:val"] ?? "continue";
}
function grid_before(tr: No): number {
  const v = filho(filho(tr, "w:trPr") ?? { nome: "", attrs: {}, filhos: [] }, "w:gridBefore")?.attrs["w:val"];
  return v ? Number(v) : 0;
}

/** `_Row.cells` do python-docx 1.2: célula mesclada na vertical é a de cima. */
function celulas_da_linha(linhas: No[], i: number): No[] {
  const tr = linhas[i]!;
  const tc_na_posicao = (linha: No, alvo: number): No | null => {
    let pos = grid_before(linha);
    for (const tc of filhos(linha, "w:tc")) {
      if (pos === alvo) return tc;
      if (pos > alvo) return null;
      pos += grid_span(tc);
    }
    return null;
  };
  const raiz_vertical = (tc: No, linha: number, posicao: number): No => {
    let atual = tc;
    let l = linha;
    while (v_merge(atual) === "continue" && l > 0) {
      const acima = tc_na_posicao(linhas[l - 1]!, posicao);
      if (!acima) break;
      atual = acima;
      l--;
    }
    return atual;
  };
  const saida: No[] = [];
  let pos = grid_before(tr);
  for (const tc of filhos(tr, "w:tc")) {
    const celula = raiz_vertical(tc, i, pos);
    for (let k = 0; k < grid_span(celula); k++) saida.push(celula);
    pos += grid_span(tc);
  }
  return saida;
}

function texto_de_container(container: No): string[] {
  const linhas: string[] = [];
  for (const e of filhos(container)) {
    if (e.nome === "w:p") {
      linhas.push(texto_paragrafo(e));
    } else if (e.nome === "w:tbl") {
      const trs = filhos(e, "w:tr");
      trs.forEach((_tr, i) => {
        const vistas = new Set<No>();
        for (const celula of celulas_da_linha(trs, i)) {
          if (vistas.has(celula)) continue;
          vistas.add(celula);
          linhas.push(filhos(celula, "w:p").map(texto_paragrafo).join("\n"));
        }
      });
    }
  }
  return linhas;
}

/**
 * Corpo (parágrafos + células) + cabeçalho + rodapé de cada seção, nesta
 * ordem — o `documento.extrair_texto` do Python. Só o cabeçalho/rodapé
 * "default" de cada seção, herdado da anterior quando a seção não declara o
 * seu (o `is_linked_to_previous` do python-docx).
 */
export function extrair_texto_docx(bytes: Uint8Array): string {
  const zip = new PizZip(bytes);
  const doc = analisar_xml(zip.file("word/document.xml")!.asText());
  const documento = filho(doc, "w:document")!;
  const corpo = filho(documento, "w:body")!;
  const linhas = texto_de_container(corpo);

  const rels = new Map<string, string>();
  const relsXml = zip.file("word/_rels/document.xml.rels")?.asText() ?? "";
  for (const r of filhos(filho(analisar_xml(relsXml), "Relationships") ?? { nome: "", attrs: {}, filhos: [] }, "Relationship")) {
    rels.set(r.attrs.Id!, r.attrs.Target!);
  }
  const secoes: No[] = [];
  for (const e of filhos(corpo)) {
    if (e.nome === "w:p") {
      const s = filho(filho(e, "w:pPr") ?? { nome: "", attrs: {}, filhos: [] }, "w:sectPr");
      if (s) secoes.push(s);
    } else if (e.nome === "w:sectPr") {
      secoes.push(e);
    }
  }
  const parte = (alvo: string): string[] => {
    const caminho = alvo.startsWith("/") ? alvo.slice(1) : `word/${alvo}`;
    const xml = zip.file(caminho)?.asText();
    if (!xml) return [""];
    const raiz = filhos(analisar_xml(xml)).find((n) => n.nome === "w:hdr" || n.nome === "w:ftr");
    return raiz ? texto_de_container(raiz) : [""];
  };
  secoes.forEach((_s, i) => {
    for (const tipo of ["w:headerReference", "w:footerReference"]) {
      let alvo: string | undefined;
      for (let j = i; j >= 0 && alvo === undefined; j--) {
        const ref = filhos(secoes[j]!, tipo).find((r) => (r.attrs["w:type"] ?? "default") === "default");
        if (ref) alvo = rels.get(ref.attrs["r:id"]!);
      }
      // seção sem nenhum cabeçalho: o python-docx cria um vazio (um parágrafo)
      linhas.push(...(alvo ? parte(alvo) : [""]));
    }
  });
  return linhas.join("\n").normalize("NFC");
}
