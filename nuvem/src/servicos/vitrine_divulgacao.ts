/**
 * O que a equipe e o público levam da ficha da vitrine para fora dela: o
 * endereço absoluto, o texto do WhatsApp, o cartaz A4 em PDF (pdf-lib, com o QR
 * desenhado em vetor) e a agenda `.ics`. Tudo sai dos mesmos campos da ficha
 * pública (`CursoPublico`); nada aqui lê dado pessoal.
 *
 * Fonte do cartaz: Helvetica padrão do PDF (WinAnsi). Caractere fora dela sai
 * como "?" em vez de derrubar a geração.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import * as ics from "./ics.js";
import { matriz_qr } from "./qr.js";
import type { CursoPublico } from "./vitrine.js";

const A4: [number, number] = [595.28, 841.89];
const MARGEM = 48;
const AZUL = rgb(0.0, 0.337, 0.639);
const TEXTO = rgb(0.1, 0.12, 0.16);
const SUAVE = rgb(0.38, 0.42, 0.48);

/** O endereço absoluto da ficha. */
export function url_da_ficha(url_base: string, codigo: string): string {
  return `${url_base.replace(/\/+$/, "")}/cursos/${codigo}`;
}

function _data(d: string): string {
  return d.split("-").reverse().join("/");
}

/** "18 e 19/11/2026", "18/11/2026" ou "18/11 a 20/11/2026": o período em uma linha. */
export function periodo(curso: Pick<CursoPublico, "data_inicio" | "data_fim">): string {
  if (curso.data_inicio === curso.data_fim) return _data(curso.data_inicio);
  return `${_data(curso.data_inicio)} a ${_data(curso.data_fim)}`;
}

function _horario(curso: Pick<CursoPublico, "hora_inicio" | "hora_fim">): string {
  if (!curso.hora_inicio) return "";
  const h = (x: string) => x.slice(0, 5);
  return curso.hora_fim ? `${h(curso.hora_inicio)} às ${h(curso.hora_fim)}` : `a partir das ${h(curso.hora_inicio)}`;
}

/** A linha curta de resumo (a do `og:description` e a do WhatsApp). */
export function resumo(curso: CursoPublico): string {
  const onde = curso.modalidade === "EAD" ? "Online" : [curso.local, curso.campus].filter(Boolean).join(", ");
  return [periodo(curso), onde].filter(Boolean).join(" · ");
}

/** O link do WhatsApp com a mensagem pronta, montada no servidor. */
export function link_whatsapp(curso: CursoPublico, url: string): string {
  const abertura = curso.aberta ? "Inscrições abertas" : "Curso";
  const texto = `${abertura}: ${curso.titulo} · ${resumo(curso)}. Veja os detalhes e inscreva-se: ${url}`;
  return `https://wa.me/?text=${encodeURIComponent(texto)}`;
}

/** O link `mailto:` com assunto e corpo prontos. */
export function link_email(curso: CursoPublico, url: string): string {
  const assunto = `Curso: ${curso.titulo}`;
  const corpo = `${curso.titulo}\n${resumo(curso)}\n\nDetalhes e inscrição: ${url}`;
  return `mailto:?subject=${encodeURIComponent(assunto)}&body=${encodeURIComponent(corpo)}`;
}

// ---------------------------------------------------------------------
// A agenda
// ---------------------------------------------------------------------
/** O `.ics` público: a descrição aponta para a ficha da vitrine, que não pede login. */
export function agenda(curso: CursoPublico, url_base: string): { nome: string; texto: string } {
  const turma: ics.TurmaDaAgenda = {
    id: 0,
    codigo: curso.codigo,
    situacao: "PLANEJADA",
    data_inicio: curso.data_inicio,
    data_fim: curso.data_fim,
    hora_inicio: curso.hora_inicio,
    hora_fim: curso.hora_fim,
    local: curso.modalidade === "EAD" ? "Online" : curso.local,
    campus: curso.campus ? { nome: curso.campus } : null,
    treinamento: { nome: curso.titulo },
    unidade_promotora: curso.setor ? { sigla: curso.setor.sigla, nome_extenso: curso.setor.nome } : null,
  };
  const texto = ics.gerar(turma, { url_base, link: url_da_ficha(url_base, curso.codigo) });
  return { nome: `${curso.codigo}.ics`, texto };
}

// ---------------------------------------------------------------------
// O cartaz
// ---------------------------------------------------------------------
/** Troca o que a Helvetica (WinAnsi) não desenha por "?". */
export function so_winansi(texto: string): string {
  return texto.replace(/[^ -~ -ÿ–—‘’“”•…]/g, "?");
}

function _quebrar(texto: string, fonte: PDFFont, tamanho: number, largura: number): string[] {
  const linhas: string[] = [];
  let atual = "";
  for (const palavra of so_winansi(texto).split(/\s+/).filter(Boolean)) {
    const tentativa = atual ? `${atual} ${palavra}` : palavra;
    if (atual && fonte.widthOfTextAtSize(tentativa, tamanho) > largura) {
      linhas.push(atual);
      atual = palavra;
    } else atual = tentativa;
  }
  if (atual) linhas.push(atual);
  return linhas;
}

/** O cartaz A4 da turma, com o QR da ficha. */
export async function cartaz_pdf(curso: CursoPublico, url: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(so_winansi(`Cartaz - ${curso.titulo}`));
  doc.setProducer("Sistema SISA");
  const pagina = doc.addPage(A4);
  const normal = await doc.embedFont(StandardFonts.Helvetica);
  const negrito = await doc.embedFont(StandardFonts.HelveticaBold);
  const [L, H] = A4;
  const util = L - 2 * MARGEM;

  // faixa do setor
  pagina.drawRectangle({ x: 0, y: H - 120, width: L, height: 120, color: AZUL });
  pagina.drawText(so_winansi(curso.setor?.sigla ?? "SISA"), { x: MARGEM, y: H - 56, size: 20, font: negrito, color: rgb(1, 1, 1) });
  pagina.drawText("Sistema SISA · UFVJM", { x: MARGEM, y: H - 80, size: 12, font: normal, color: rgb(1, 1, 1) });
  pagina.drawText(curso.aberta ? "INSCRIÇÕES ABERTAS" : "CURSO", {
    x: MARGEM,
    y: H - 104,
    size: 11,
    font: negrito,
    color: rgb(0.85, 0.92, 1),
  });

  // título
  let y = H - 180;
  let tamanho = 34;
  let linhas = _quebrar(curso.titulo, negrito, tamanho, util);
  while (linhas.length > 3 && tamanho > 20) {
    tamanho -= 2;
    linhas = _quebrar(curso.titulo, negrito, tamanho, util);
  }
  for (const l of linhas) {
    pagina.drawText(l, { x: MARGEM, y, size: tamanho, font: negrito, color: TEXTO });
    y -= tamanho * 1.2;
  }
  y -= 14;

  // os dados
  const dados: [string, string][] = [["Quando", [periodo(curso), _horario(curso)].filter(Boolean).join(" · ")]];
  dados.push(["Onde", curso.modalidade === "EAD" ? "Online" : [curso.local, curso.campus].filter(Boolean).join(", ") || curso.modalidade_rotulo]);
  if (curso.carga_horas) dados.push(["Carga horária", `${curso.carga_horas} h`]);
  if (curso.inscricao_ate) dados.push(["Inscrições até", _data(curso.inscricao_ate)]);
  if (curso.vagas_total !== null) dados.push(["Vagas", String(curso.vagas_total)]);
  if (curso.publico.length) dados.push(["Público", curso.publico.join(", ")]);
  for (const [rotulo, valor] of dados) {
    pagina.drawText(so_winansi(rotulo.toUpperCase()), { x: MARGEM, y, size: 9, font: negrito, color: SUAVE });
    y -= 17;
    for (const l of _quebrar(valor, normal, 16, util)) {
      pagina.drawText(l, { x: MARGEM, y, size: 16, font: normal, color: TEXTO });
      y -= 20;
    }
    y -= 8;
  }

  // o QR (vetor) e o endereço
  const { tamanho: n, escuro } = matriz_qr(url);
  const lado = 230;
  const modulo = lado / (n + 4);
  const x0 = (L - lado) / 2;
  const y0 = 120;
  pagina.drawRectangle({ x: x0, y: y0, width: lado, height: lado, color: rgb(1, 1, 1), borderColor: rgb(0.8, 0.82, 0.86), borderWidth: 1 });
  for (let l = 0; l < n; l++) {
    for (let c = 0; c < n; c++) {
      if (!escuro(l, c)) continue;
      pagina.drawRectangle({
        x: x0 + (c + 2) * modulo,
        y: y0 + lado - (l + 3) * modulo,
        width: modulo + 0.2,
        height: modulo + 0.2,
        color: rgb(0, 0, 0),
      });
    }
  }
  const chamada = "Aponte a câmera do celular para se inscrever";
  pagina.drawText(chamada, { x: (L - negrito.widthOfTextAtSize(chamada, 13)) / 2, y: y0 + lado + 14, size: 13, font: negrito, color: AZUL });
  const endereco = so_winansi(url.replace(/^https?:\/\//, ""));
  let corpo = 13;
  while (corpo > 7 && normal.widthOfTextAtSize(endereco, corpo) > util) corpo -= 0.5;
  pagina.drawText(endereco, { x: (L - normal.widthOfTextAtSize(endereco, corpo)) / 2, y: y0 - 24, size: corpo, font: normal, color: TEXTO });
  return doc.save();
}
