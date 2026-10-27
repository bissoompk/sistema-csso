/**
 * O relatório técnico do acidente em PDF, desenhado com o pdf-lib a partir do
 * contexto CONGELADO (`ContextoRelatorio`) — sem LibreOffice, como o
 * certificado (`certificado_pdf.ts`). O que sai é só o que está no contexto;
 * por isso a variante SEM_SAUDE é segura por construção: o contexto dela não tem
 * o campo `saude`, e este arquivo só desenha o que existe.
 *
 * Fonte: Helvetica padrão do PDF (WinAnsi). Caractere fora dela sai como "?" em
 * vez de derrubar a geração.
 *
 * `blocos` é o texto do relatório em ordem, sem layout; `texto_plano` o devolve
 * como texto corrido (é o que os testes conferem); `gerar_pdf` o desenha.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

export interface ContextoRelatorio {
  protocolo: string;
  versao: number;
  variante: "COMPLETA" | "SEM_SAUDE";
  emitido_em: string;
  emitido_por: string;
  retificacao: { motivo: string; substitui_versao: number } | null;
  identificacao: {
    especie: string;
    data_evento: string;
    hora_evento: string | null;
    local: string;
    campus: string | null;
    municipio_uf: string | null;
  };
  acidentados: { ordem: number; nome: string; siape: string | null; vinculo: string; condicao: string; empresa: string | null }[];
  relato: { descricao: string; atividade: string | null };
  analise: { rotulo: string; texto: string }[];
  conclusao: { ambiente_fator: string | null; caracterizacao: string | null; requer_cat_siass: string | null };
  linha_do_tempo: { momento: string; descricao: string }[];
  barreiras: { tipo: string; situacao: string; descricao: string }[];
  checklist: { secao: string; texto: string; observacao: string | null }[];
  entrevistas: { vinculo: string | null; quando: string | null }[];
  evidencias: { descricao: string }[];
  plano: { numero: number; acao: string; tipo: string; responsavel: string; prazo: string | null; estado: string }[];
  /** só na variante COMPLETA */
  saude?: { ordem: number; natureza: string | null; partes: string[]; lateralidade: string | null; fatos: [string, string][] }[];
}

export type Bloco =
  | { t: "titulo"; texto: string }
  | { t: "secao"; texto: string }
  | { t: "paragrafo"; texto: string }
  | { t: "item"; texto: string }
  | { t: "campo"; rotulo: string; texto: string }
  | { t: "aviso"; texto: string };

const _data = (iso: string | null): string => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : (iso ?? "—"));

export function blocos(c: ContextoRelatorio): Bloco[] {
  const b: Bloco[] = [];
  b.push({ t: "titulo", texto: `Relatório de investigação de acidente — ${c.protocolo}` });
  b.push({
    t: "paragrafo",
    texto: `Versão ${c.versao}${c.variante === "COMPLETA" ? " · completa (para a perícia do SIASS)" : " · sem dados de saúde"} · emitido em ${_data(c.emitido_em)} por ${c.emitido_por}.`,
  });
  if (c.retificacao) {
    b.push({ t: "aviso", texto: `Retifica a versão ${c.retificacao.substitui_versao}. Motivo: ${c.retificacao.motivo}` });
  }
  b.push({ t: "secao", texto: "1. Identificação" });
  const i = c.identificacao;
  b.push({ t: "campo", rotulo: "Espécie", texto: i.especie });
  b.push({ t: "campo", rotulo: "Data e hora", texto: `${_data(i.data_evento)}${i.hora_evento ? ` às ${i.hora_evento.slice(0, 5)}` : ""}` });
  b.push({ t: "campo", rotulo: "Local", texto: i.local });
  if (i.campus) b.push({ t: "campo", rotulo: "Campus", texto: i.campus });
  if (i.municipio_uf) b.push({ t: "campo", rotulo: "Município", texto: i.municipio_uf });
  b.push({ t: "secao", texto: "2. Envolvidos" });
  for (const a of c.acidentados) {
    b.push({
      t: "item",
      texto: `${a.ordem}. ${a.nome}${a.siape ? ` (SIAPE ${a.siape})` : ""} — ${a.vinculo}, ${a.condicao}${a.empresa ? `, ${a.empresa}` : ""}`,
    });
  }
  b.push({ t: "secao", texto: "3. O que aconteceu" });
  b.push({ t: "paragrafo", texto: c.relato.descricao });
  if (c.relato.atividade) b.push({ t: "campo", rotulo: "Atividade no momento", texto: c.relato.atividade });
  if (c.saude) {
    b.push({ t: "secao", texto: "4. Saúde (resumo)" });
    b.push({ t: "aviso", texto: "Dado sensível: documento restrito à perícia. Não circula para a contratada nem para o fiscal." });
    for (const s of c.saude) {
      b.push({ t: "item", texto: `Acidentado nº ${s.ordem}` });
      if (s.natureza) b.push({ t: "campo", rotulo: "Natureza da lesão", texto: s.natureza });
      if (s.partes.length) b.push({ t: "campo", rotulo: "Partes do corpo", texto: s.partes.join(", ") });
      if (s.lateralidade) b.push({ t: "campo", rotulo: "Lateralidade", texto: s.lateralidade });
      for (const [rotulo, valor] of s.fatos) b.push({ t: "campo", rotulo, texto: valor });
    }
  }
  b.push({ t: "secao", texto: `${c.saude ? 5 : 4}. Análise do trabalho` });
  for (const a of c.analise) b.push({ t: "campo", rotulo: a.rotulo, texto: a.texto });
  if (c.linha_do_tempo.length) {
    b.push({ t: "secao", texto: "Linha do tempo" });
    for (const l of c.linha_do_tempo) b.push({ t: "item", texto: `${l.momento} — ${l.descricao}` });
  }
  if (c.barreiras.length) {
    b.push({ t: "secao", texto: "Barreiras" });
    for (const r of c.barreiras) b.push({ t: "item", texto: `${r.tipo} (${r.situacao}): ${r.descricao}` });
  }
  if (c.checklist.length) {
    b.push({ t: "secao", texto: "Checklist de campo (itens marcados)" });
    for (const k of c.checklist) b.push({ t: "item", texto: `${k.secao}: ${k.texto}${k.observacao ? ` — ${k.observacao}` : ""}` });
  }
  if (c.entrevistas.length || c.evidencias.length) {
    b.push({ t: "secao", texto: "Entrevistas e evidências" });
    if (c.entrevistas.length) b.push({ t: "paragrafo", texto: `${c.entrevistas.length} entrevista(s) realizada(s); os relatos ficam arquivados no caso.` });
    for (const e of c.evidencias) b.push({ t: "item", texto: `Evidência: ${e.descricao || "(sem descrição)"}` });
  }
  b.push({ t: "secao", texto: "Conclusão técnica" });
  const k = c.conclusao;
  if (k.caracterizacao) b.push({ t: "campo", rotulo: "Caracterização como acidente em serviço", texto: k.caracterizacao });
  if (k.ambiente_fator) b.push({ t: "campo", rotulo: "Fator do ambiente de trabalho", texto: k.ambiente_fator });
  if (k.requer_cat_siass) b.push({ t: "campo", rotulo: "Requer CAT/SIASS", texto: k.requer_cat_siass });
  if (c.plano.length) {
    b.push({ t: "secao", texto: "Plano de ação" });
    for (const p of c.plano) {
      b.push({ t: "item", texto: `Ação nº ${p.numero} (${p.tipo}, ${p.estado}): ${p.acao} — responsável: ${p.responsavel}; prazo: ${_data(p.prazo)}` });
    }
  }
  b.push({ t: "paragrafo", texto: "A assinatura oficial deste relatório é feita no SEI, no processo do caso." });
  return b;
}

/** O texto do relatório, corrido: o que os testes conferem e o que se lê sem o PDF. */
export function texto_plano(c: ContextoRelatorio): string {
  return blocos(c)
    .map((x) => (x.t === "campo" ? `${x.rotulo}: ${x.texto}` : x.texto))
    .join("\n");
}

// ---------------------------------------------------------------------
// Desenho
// ---------------------------------------------------------------------
const LARGURA = 595.28;
const ALTURA = 841.89;
const MARGEM = 56.7;
const COR_TEXTO = rgb(0.1, 0.1, 0.12);
const COR_SUAVE = rgb(0.38, 0.38, 0.42);
const COR_TITULO = rgb(0.05, 0.27, 0.45);

function limpo(fonte: PDFFont, texto: string): string {
  let saida = "";
  for (const ch of texto.normalize("NFC").replace(/[\t\r]/g, " ")) {
    try {
      fonte.encodeText(ch);
      saida += ch;
    } catch {
      saida += "?";
    }
  }
  return saida;
}

function quebrar(fonte: PDFFont, texto: string, tamanho: number, largura: number): string[] {
  const linhas: string[] = [];
  for (const par of limpo(fonte, texto).split("\n")) {
    let atual = "";
    for (const palavra of par.split(/\s+/).filter(Boolean)) {
      const tentativa = atual ? `${atual} ${palavra}` : palavra;
      if (fonte.widthOfTextAtSize(tentativa, tamanho) > largura && atual) {
        linhas.push(atual);
        atual = palavra;
      } else {
        atual = tentativa;
      }
    }
    linhas.push(atual);
  }
  return linhas;
}

export async function gerar_pdf(c: ContextoRelatorio, hash: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Relatório ${c.protocolo} v${c.versao}`);
  doc.setProducer("Sistema SISA");
  const normal = await doc.embedFont(StandardFonts.Helvetica);
  const negrito = await doc.embedFont(StandardFonts.HelveticaBold);
  const util = LARGURA - 2 * MARGEM;
  let pagina: PDFPage = doc.addPage([LARGURA, ALTURA]);
  let y = ALTURA - MARGEM;

  const nova_pagina = () => {
    pagina = doc.addPage([LARGURA, ALTURA]);
    y = ALTURA - MARGEM;
  };
  const linhas = (texto: string, fonte: PDFFont, tamanho: number, recuo = 0, cor = COR_TEXTO, espaco_depois = 4) => {
    for (const l of quebrar(fonte, texto, tamanho, util - recuo)) {
      if (y - tamanho < MARGEM + 20) nova_pagina();
      pagina.drawText(l, { x: MARGEM + recuo, y: y - tamanho, size: tamanho, font: fonte, color: cor });
      y -= tamanho * 1.35;
    }
    y -= espaco_depois;
  };

  for (const b of blocos(c)) {
    if (b.t === "titulo") linhas(b.texto, negrito, 15, 0, COR_TITULO, 6);
    else if (b.t === "secao") {
      y -= 6;
      linhas(b.texto, negrito, 11.5, 0, COR_TITULO, 3);
    } else if (b.t === "paragrafo") linhas(b.texto, normal, 10);
    else if (b.t === "aviso") linhas(b.texto, negrito, 10, 0, rgb(0.6, 0.15, 0.1), 6);
    else if (b.t === "item") linhas(`• ${b.texto}`, normal, 10, 8);
    else {
      linhas(b.rotulo, negrito, 9.5, 0, COR_SUAVE, 0);
      linhas(b.texto, normal, 10, 8);
    }
  }

  // rodapé em todas as páginas: protocolo, versão, variante e o início do hash
  const paginas = doc.getPages();
  paginas.forEach((p, n) => {
    const rodape = limpo(normal, `${c.protocolo} · v${c.versao} · ${c.variante === "COMPLETA" ? "completa" : "sem saúde"} · ${hash.slice(0, 12)} · página ${n + 1} de ${paginas.length}`);
    p.drawText(rodape, { x: MARGEM, y: MARGEM - 24, size: 8, font: normal, color: COR_SUAVE });
  });
  return doc.save();
}
