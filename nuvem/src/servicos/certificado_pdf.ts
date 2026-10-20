/**
 * O certificado em PDF, com o QR da validação — gerado aqui, sem LibreOffice.
 *
 * Na nuvem não há `soffice` (ver `pdf.ts`), então o PDF não é a conversão do
 * .docx: é o MESMO texto do `certificado_padrao_v1.docx`, desenhado com o
 * pdf-lib a partir do contexto CONGELADO (`montar_contexto`). O .docx continua
 * sendo emitido e servido como cópia editável; o PDF é o papel que circula.
 *
 * Página 1: emissor, título, o parágrafo de certificação, local e data,
 * assinatura, instrutores e, no rodapé, número, validade, chave e o QR que abre
 * `/validar/{chave}`. Página 2 (só quando há): o conteúdo programático.
 *
 * CPF (participante e responsável pela formação) só sai quando o contexto
 * congelado o tem — e ele só é congelado quando o modelo do treinamento mapeia
 * `participante_cpf`/`instrutor_cpf` (`cpf_certificado.ts`).
 *
 * Fonte: Helvetica padrão do PDF (WinAnsi). Cobre o português; caractere fora
 * dela sai como "?" em vez de derrubar a geração.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { matriz_qr } from "./qr.js";
import { obterArmazenamento } from "./armazenamento.js";
import * as anexos from "./anexos.js";
import { CAMPOS_CERTIFICADO, linha_do_instrutor, type ContextoCertificado } from "./certificado.js";

export const TIPO_PDF = "application/pdf";

// Carta paisagem, como o .docx (15840 × 12240 twips); margem de 2 cm.
const LARGURA = 792;
const ALTURA = 612;
const MARGEM = 56.7;
const COR_TEXTO = rgb(0.1, 0.1, 0.12);
const COR_SUAVE = rgb(0.38, 0.38, 0.42);
const COR_TITULO = rgb(0.05, 0.27, 0.45);

// =====================================================================
// QR
// =====================================================================
/** Desenha o QR em vetor (nítido em qualquer impressora), com a zona de silêncio. */
function desenhar_qr(pagina: PDFPage, texto: string, x: number, y: number, lado: number): void {
  const { tamanho, escuro } = matriz_qr(texto);
  const modulo = lado / (tamanho + 8);
  pagina.drawRectangle({ x, y, width: lado, height: lado, color: rgb(1, 1, 1) });
  for (let l = 0; l < tamanho; l++) {
    for (let c = 0; c < tamanho; c++) {
      if (!escuro(l, c)) continue;
      pagina.drawRectangle({
        x: x + (c + 4) * modulo,
        y: y + lado - (l + 5) * modulo,
        width: modulo,
        height: modulo,
        color: rgb(0, 0, 0),
      });
    }
  }
}

// =====================================================================
// Texto
// =====================================================================
type Trecho = { texto: string; negrito?: boolean };

class Fontes {
  private readonly cabe = new Map<string, boolean>();
  constructor(
    readonly normal: PDFFont,
    readonly negrito: PDFFont,
  ) {}
  /** O texto só com o que a Helvetica (WinAnsi) desenha; o resto vira "?". */
  limpo(texto: string): string {
    let saida = "";
    for (const ch of texto.normalize("NFC").replace(/[\t\r]/g, " ")) {
      let ok = this.cabe.get(ch);
      if (ok === undefined) {
        try {
          this.normal.encodeText(ch);
          ok = true;
        } catch {
          ok = false;
        }
        this.cabe.set(ch, ok);
      }
      saida += ok ? ch : "?";
    }
    return saida;
  }
  fonte(t: Trecho): PDFFont {
    return t.negrito ? this.negrito : this.normal;
  }
}

/** Quebra trechos (normal/negrito misturados) em linhas que cabem em `largura`. */
function quebrar(trechos: Trecho[], fontes: Fontes, tamanho: number, largura: number): Trecho[][] {
  const palavras: Trecho[] = [];
  for (const t of trechos) {
    for (const p of fontes.limpo(t.texto).split(/(\s+)/)) if (p) palavras.push({ texto: p, negrito: t.negrito });
  }
  const linhas: Trecho[][] = [];
  let atual: Trecho[] = [];
  let ocupado = 0;
  for (const p of palavras) {
    const espaco = /^\s+$/.test(p.texto);
    const w = fontes.fonte(p).widthOfTextAtSize(espaco ? " " : p.texto, tamanho);
    if (espaco) {
      if (atual.length) {
        atual.push({ texto: " ", negrito: p.negrito });
        ocupado += w;
      }
      continue;
    }
    if (ocupado + w > largura && atual.length) {
      while (atual.length && atual[atual.length - 1]!.texto === " ") atual.pop();
      linhas.push(atual);
      atual = [];
      ocupado = 0;
    }
    atual.push(p);
    ocupado += w;
  }
  while (atual.length && atual[atual.length - 1]!.texto === " ") atual.pop();
  if (atual.length) linhas.push(atual);
  return linhas;
}

function largura_da_linha(linha: Trecho[], fontes: Fontes, tamanho: number): number {
  return linha.reduce((s, t) => s + fontes.fonte(t).widthOfTextAtSize(t.texto, tamanho), 0);
}

/** Escreve um parágrafo centrado em `centro`, de cima para baixo; devolve o novo `y`. */
function paragrafo(
  pagina: PDFPage,
  fontes: Fontes,
  trechos: Trecho[],
  o: { y: number; tamanho: number; largura: number; centro?: number; entrelinha?: number; cor?: ReturnType<typeof rgb> },
): number {
  const centro = o.centro ?? LARGURA / 2;
  const passo = o.tamanho * (o.entrelinha ?? 1.35);
  let y = o.y;
  for (const linha of quebrar(trechos, fontes, o.tamanho, o.largura)) {
    let x = centro - largura_da_linha(linha, fontes, o.tamanho) / 2;
    for (const t of linha) {
      const fonte = fontes.fonte(t);
      pagina.drawText(t.texto, { x, y, size: o.tamanho, font: fonte, color: o.cor ?? COR_TEXTO });
      x += fonte.widthOfTextAtSize(t.texto, o.tamanho);
    }
    y -= passo;
  }
  return y;
}

/** O valor do campo como sai no .docx (formatação única: `CAMPOS_CERTIFICADO`). */
function campo(contexto: ContextoCertificado, codigo: string): string {
  const valor = CAMPOS_CERTIFICADO[codigo]!.obter(contexto);
  return typeof valor === "string" ? valor.trim() : "";
}

/** O parágrafo de certificação, com o texto do `certificado_padrao_v1.docx`. */
function trechos_de_certificacao(contexto: ContextoCertificado): Trecho[] {
  const v = (codigo: string) => campo(contexto, codigo);
  const t: Trecho[] = [{ texto: "Certificamos que " }, { texto: v("participante_nome"), negrito: true }];
  if (v("participante_vinculo")) t.push({ texto: ` (${v("participante_vinculo")})` });
  if (v("participante_identificador")) t.push({ texto: `, participante identificado sob ${v("participante_identificador")}` });
  // CPF: só existe no congelado quando o modelo do treinamento o pede (norma
  // que o exige, como a do brigadista do CBMMG) — ver `cpf_certificado.ts`
  if (v("participante_cpf")) t.push({ texto: `, CPF ${v("participante_cpf")}` });
  t.push({ texto: ", concluiu o treinamento " }, { texto: v("treinamento_nome"), negrito: true });
  if (v("treinamento_norma")) t.push({ texto: ` ${v("treinamento_norma")}` });
  t.push({ texto: `, com carga horária de ${v("treinamento_carga_horaria")}` });
  if (v("turma_periodo_extenso")) t.push({ texto: `, realizado ${v("turma_periodo_extenso")}` });
  if (v("turma_local")) t.push({ texto: ` em ${v("turma_local")}` });
  if (v("turma_unidade_promotora")) t.push({ texto: `, promovido por ${v("turma_unidade_promotora")}` });
  if (v("frequencia_percentual")) t.push({ texto: `, com frequência de ${v("frequencia_percentual")}` });
  t.push({ texto: "." });
  return t;
}

async function _rubrica(documento: PDFDocument, sha256: string | null | undefined) {
  if (!sha256) return null;
  try {
    const bytes = await obterArmazenamento().ler(anexos.chave_no_armazenamento(anexos.chave_do_blob(sha256)));
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return await documento.embedPng(bytes);
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return await documento.embedJpg(bytes);
  } catch {
    // rubrica sumida ou ilegível: o certificado sai sem a imagem, como o .docx
  }
  return null;
}

// =====================================================================
// Páginas
// =====================================================================
async function desenhar_certificado(documento: PDFDocument, fontes: Fontes, contexto: ContextoCertificado): Promise<void> {
  const v = (codigo: string) => campo(contexto, codigo);
  const pagina = documento.addPage([LARGURA, ALTURA]);
  const util = LARGURA - 2 * MARGEM;

  // moldura discreta
  pagina.drawRectangle({
    x: MARGEM / 2,
    y: MARGEM / 2,
    width: LARGURA - MARGEM,
    height: ALTURA - MARGEM,
    borderColor: COR_TITULO,
    borderWidth: 1.2,
  });

  let y = ALTURA - MARGEM - 14;
  y = paragrafo(pagina, fontes, [{ texto: v("setor_emissor_nome"), negrito: true }], { y, tamanho: 12, largura: util });
  if (v("setor_emissor_sigla")) {
    y = paragrafo(pagina, fontes, [{ texto: v("setor_emissor_sigla") }], { y, tamanho: 10, largura: util, cor: COR_SUAVE });
  }
  y -= 26;
  y = paragrafo(pagina, fontes, [{ texto: "CERTIFICADO", negrito: true }], { y, tamanho: 34, largura: util, cor: COR_TITULO });
  y -= 18;
  y = paragrafo(pagina, fontes, trechos_de_certificacao(contexto), { y, tamanho: 14, largura: util - 60, entrelinha: 1.5 });

  y -= 10;
  const local_data = [v("cidade"), v("certificado_data_extenso")].filter((p) => p).join(", ");
  if (local_data) y = paragrafo(pagina, fontes, [{ texto: `${local_data}.` }], { y, tamanho: 12, largura: util });

  // assinatura
  y -= 12;
  const rubrica = await _rubrica(documento, contexto.assinante.rubrica_sha256);
  if (rubrica) {
    const larg = 99; // 35 mm, a largura da rubrica no .docx
    const alt = Math.min(45, (rubrica.height / rubrica.width) * larg);
    pagina.drawImage(rubrica, { x: LARGURA / 2 - larg / 2, y: y - alt + 8, width: larg, height: alt });
    y -= alt - 4;
  } else {
    y -= 26;
  }
  pagina.drawLine({
    start: { x: LARGURA / 2 - 130, y },
    end: { x: LARGURA / 2 + 130, y },
    thickness: 0.7,
    color: COR_SUAVE,
  });
  y -= 14;
  if (v("assinante_nome")) y = paragrafo(pagina, fontes, [{ texto: v("assinante_nome"), negrito: true }], { y, tamanho: 11, largura: util });
  if (v("assinante_titulo")) y = paragrafo(pagina, fontes, [{ texto: v("assinante_titulo") }], { y, tamanho: 10, largura: util, cor: COR_SUAVE });
  // o CPF do responsável pela formação, discreto, nas mesmas condições
  if (v("instrutor_cpf")) y = paragrafo(pagina, fontes, [{ texto: `CPF ${v("instrutor_cpf")}` }], { y, tamanho: 9, largura: util, cor: COR_SUAVE });

  const instrutores = contexto.instrutores.map(linha_do_instrutor).filter((l) => l);
  if (instrutores.length) {
    y -= 6;
    paragrafo(pagina, fontes, [{ texto: `Instrutor(es): ${instrutores.join("; ")}` }], {
      y,
      tamanho: 9.5,
      largura: util,
      cor: COR_SUAVE,
    });
  }

  // rodapé: QR à esquerda, número, validade e chave ao lado
  const lado_qr = 78;
  const base = MARGEM / 2 + 10;
  if (contexto.url_validacao) desenhar_qr(pagina, contexto.url_validacao, MARGEM, base, lado_qr);
  const x_texto = MARGEM + lado_qr + 10;
  const rodape = [
    `Certificado nº ${v("certificado_rotulo")} · válido até ${v("certificado_data_vencimento")}`,
    `Confira a autenticidade em ${v("certificado_url_validacao")}`,
    `Chave de validação: ${v("certificado_chave")}`,
  ];
  let yr = base + lado_qr - 22;
  for (const [i, linha] of rodape.entries()) {
    const texto = fontes.limpo(linha);
    const fonte = i === 2 ? fontes.negrito : fontes.normal;
    // URL longa: reduz a fonte até caber, em vez de invadir a margem
    let tamanho = 9;
    while (tamanho > 6 && fonte.widthOfTextAtSize(texto, tamanho) > LARGURA - MARGEM - x_texto) tamanho -= 0.5;
    pagina.drawText(texto, { x: x_texto, y: yr, size: tamanho, font: fonte, color: COR_SUAVE });
    yr -= 13;
  }

  // verso: o conteúdo programático
  const conteudo = (contexto.treinamento_conteudo ?? "").trim();
  if (conteudo) {
    const verso = documento.addPage([LARGURA, ALTURA]);
    let yv = ALTURA - MARGEM - 10;
    yv = paragrafo(verso, fontes, [{ texto: "Conteúdo programático", negrito: true }], {
      y: yv,
      tamanho: 16,
      largura: util,
      cor: COR_TITULO,
    });
    yv = paragrafo(verso, fontes, [{ texto: v("treinamento_nome") }], { y: yv, tamanho: 11, largura: util, cor: COR_SUAVE });
    yv -= 12;
    const linhas = conteudo.split(/\r?\n/).map((l) => l.trim()).filter((l) => l);
    const tamanho = linhas.length > 28 ? 9 : 11;
    for (const linha of linhas) {
      if (yv < MARGEM) break; // o que não cabe fica no .docx
      for (const parte of quebrar([{ texto: linha }], fontes, tamanho, util - 20)) {
        verso.drawText(parte.map((t) => t.texto).join(""), { x: MARGEM + 10, y: yv, size: tamanho, font: fontes.normal, color: COR_TEXTO });
        yv -= tamanho * 1.4;
      }
    }
    verso.drawText(fontes.limpo(`Certificado nº ${v("certificado_rotulo")} · chave ${v("certificado_chave")}`), {
      x: MARGEM,
      y: MARGEM / 2 + 10,
      size: 8,
      font: fontes.normal,
      color: COR_SUAVE,
    });
  }
}

/** Um ou vários certificados num só PDF (o lote da turma sai num arquivo). */
export async function gerar_pdf(contextos: ContextoCertificado[]): Promise<Uint8Array> {
  const documento = await PDFDocument.create();
  documento.setTitle(contextos.length === 1 ? `Certificado ${contextos[0]!.rotulo}` : "Certificados");
  documento.setCreator("Sistema CSSO");
  documento.setProducer("Sistema CSSO");
  const fontes = new Fontes(
    await documento.embedFont(StandardFonts.Helvetica),
    await documento.embedFont(StandardFonts.HelveticaBold),
  );
  for (const contexto of contextos) await desenhar_certificado(documento, fontes, contexto);
  return documento.save();
}
