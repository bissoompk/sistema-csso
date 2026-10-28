/**
 * A arte da turma na vitrine pública: uma imagem 4:5 que substitui a capa
 * gerada. Entra pelo mesmo Storage dos anexos (categoria `TURMA_ARTE`, dono
 * `turma`); a turma aponta para o anexo vigente (`turma.arte_anexo_id`) e o
 * anterior continua guardado.
 *
 * O arquivo é público quando a turma é divulgada, então a conferência é dura:
 * - o tipo é o dos BYTES (PNG, JPEG ou WEBP); SVG e GIF não entram;
 * - tamanho até 3 MB e dimensões entre 600×750 e 2160×2700, lidas do cabeçalho;
 * - os metadados (EXIF com a localização da foto, XMP, IPTC, texto de PNG) são
 *   REMOVIDOS na gravação: o que sai é o que se enviou, sem a bagagem;
 * - a declaração de que não há pessoa identificável (ou que ela autorizou) é
 *   obrigatória, e vai para a trilha.
 * A trilha leva só o código da turma, o tipo e o hash, nunca o nome do arquivo.
 */
import { and, eq } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import { anexo as tabela_anexo, turma as tabela_turma } from "../db/esquema/index.js";
import { RegraViolada } from "../nucleo/erros.js";
import * as anexos from "./anexos.js";
import type { Anexo } from "./anexos.js";
import * as auditoria from "./auditoria.js";
import { tipo_da_imagem } from "./epi_catalogo_anexos.js";
import type { UsuarioAtual } from "./rbac.js";
import type { TurmaCarregada } from "./turma.js";
import { pode_divulgar } from "./vitrine.js";

export const ENTIDADE = "turma";
export const CATEGORIA = "TURMA_ARTE";
export const LIMITE_BYTES = 3 * 1024 * 1024;
export const MIN = { largura: 600, altura: 750 } as const;
export const MAX = { largura: 2160, altura: 2700 } as const;
/** quanto a proporção pode fugir de 4:5 sem aviso */
export const TOLERANCIA_PROPORCAO = 0.1;
export const DECLARACAO =
  "Não há pessoas identificáveis na arte, ou as pessoas que aparecem autorizaram o uso da imagem.";

export class ArteRecusada extends RegraViolada {}

export interface Dimensoes {
  largura: number;
  altura: number;
}

function _u16be(b: Uint8Array, i: number): number {
  return (b[i]! << 8) | b[i + 1]!;
}
function _u32be(b: Uint8Array, i: number): number {
  return ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
}
function _u24le(b: Uint8Array, i: number): number {
  return b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
}
function _u32le(b: Uint8Array, i: number): number {
  return (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;
}
function _texto(b: Uint8Array, i: number, n: number): string {
  return Buffer.from(b.subarray(i, i + n)).toString("latin1");
}

/** Largura e altura lidas do cabeçalho; `null` se o arquivo estiver truncado ou torto. */
export function dimensoes(conteudo: Uint8Array, tipo: string): Dimensoes | null {
  const b = conteudo;
  if (tipo === "image/png") {
    if (b.length < 24 || _texto(b, 12, 4) !== "IHDR") return null;
    return { largura: _u32be(b, 16), altura: _u32be(b, 20) };
  }
  if (tipo === "image/jpeg") {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1]!;
      if (m === 0xff) {
        i += 1;
        continue;
      }
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
        i += 2;
        continue;
      }
      const tam = _u16be(b, i + 2);
      // SOF0..SOF15, menos DHT (c4), JPG (c8) e DAC (cc)
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { altura: _u16be(b, i + 5), largura: _u16be(b, i + 7) };
      }
      if (tam < 2) return null;
      i += 2 + tam;
    }
    return null;
  }
  if (tipo === "image/webp") {
    if (b.length < 30) return null;
    const fmt = _texto(b, 12, 4);
    if (fmt === "VP8X") return { largura: _u24le(b, 24) + 1, altura: _u24le(b, 27) + 1 };
    if (fmt === "VP8L") {
      if (b[20] !== 0x2f) return null;
      const bits = _u32le(b, 21);
      return { largura: (bits & 0x3fff) + 1, altura: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (fmt === "VP8 ") return { largura: (b[26]! | (b[27]! << 8)) & 0x3fff, altura: (b[28]! | (b[29]! << 8)) & 0x3fff };
  }
  return null;
}

// ---------------------------------------------------------------------
// Tirar os metadados
// ---------------------------------------------------------------------
function _juntar(partes: Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(partes));
}

/** JPEG sem os segmentos APP1 (EXIF e XMP), APP13 (IPTC) e comentários; o perfil de cor (APP2) fica. */
export function limpar_jpeg(b: Uint8Array): Uint8Array {
  const saida: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) throw new ArteRecusada("O JPEG está corrompido (segmento fora de lugar).");
    const m = b[i + 1]!;
    if (m === 0xff) {
      i += 1;
      continue;
    }
    if (m === 0xda) {
      // começo dos dados da imagem: o resto vai como está
      saida.push(b.subarray(i));
      return _juntar(saida);
    }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      saida.push(b.subarray(i, i + 2));
      i += 2;
      continue;
    }
    const tam = _u16be(b, i + 2);
    if (tam < 2 || i + 2 + tam > b.length) throw new ArteRecusada("O JPEG está corrompido (segmento truncado).");
    const descartar = m === 0xe1 || m === 0xed || m === 0xfe;
    if (!descartar) saida.push(b.subarray(i, i + 2 + tam));
    i += 2 + tam;
  }
  throw new ArteRecusada("O JPEG está corrompido (sem os dados da imagem).");
}

/** PNG sem os blocos de texto e de EXIF (`eXIf`, `tEXt`, `iTXt`, `zTXt`). */
export function limpar_png(b: Uint8Array): Uint8Array {
  const saida: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const tam = _u32be(b, i);
    const tipo = _texto(b, i + 4, 4);
    const fim = i + 12 + tam;
    if (fim > b.length) throw new ArteRecusada("O PNG está corrompido (bloco truncado).");
    if (!["eXIf", "tEXt", "iTXt", "zTXt"].includes(tipo)) saida.push(b.subarray(i, fim));
    i = fim;
    if (tipo === "IEND") break;
  }
  return _juntar(saida);
}

/** WEBP sem os blocos `EXIF` e `XMP `; a bandeira correspondente do `VP8X` é apagada e o tamanho do RIFF refeito. */
export function limpar_webp(b: Uint8Array): Uint8Array {
  const blocos: Uint8Array[] = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const tipo = _texto(b, i, 4);
    const tam = _u32le(b, i + 4);
    const fim = i + 8 + tam + (tam % 2);
    if (i + 8 + tam > b.length) throw new ArteRecusada("O WEBP está corrompido (bloco truncado).");
    if (tipo !== "EXIF" && tipo !== "XMP ") {
      const bloco = Uint8Array.from(b.subarray(i, Math.min(fim, b.length)));
      if (tipo === "VP8X") bloco[8] = bloco[8]! & ~0x0c; // bit 3 = EXIF, bit 2 = XMP
      blocos.push(bloco);
    }
    i = fim;
  }
  const corpo = _juntar(blocos);
  const cabecalho = Buffer.alloc(12);
  cabecalho.write("RIFF", 0, "latin1");
  cabecalho.writeUInt32LE(4 + corpo.length, 4);
  cabecalho.write("WEBP", 8, "latin1");
  return _juntar([cabecalho, corpo]);
}

export function limpar(conteudo: Uint8Array, tipo: string): Uint8Array {
  if (tipo === "image/jpeg") return limpar_jpeg(conteudo);
  if (tipo === "image/png") return limpar_png(conteudo);
  return limpar_webp(conteudo);
}

// ---------------------------------------------------------------------
// Conferir e gravar
// ---------------------------------------------------------------------
export interface ArteEnviada {
  conteudo: Uint8Array;
  nome_original: string;
  alt: string;
  declaracao: boolean;
}

/** O tipo dos bytes e as dimensões, ou levanta (nada foi gravado). */
export function conferir(a: Pick<ArteEnviada, "conteudo">): { tipo: string; dim: Dimensoes } {
  if (!a.conteudo.byteLength) throw new ArteRecusada("O arquivo da arte veio vazio.");
  if (a.conteudo.byteLength > LIMITE_BYTES) {
    throw new ArteRecusada(
      `A arte tem ${(a.conteudo.byteLength / 1024 / 1024).toFixed(1).replace(".", ",")} MB e o limite é 3 MB. Reduza a imagem e envie de novo.`,
    );
  }
  const tipo = tipo_da_imagem(a.conteudo);
  if (tipo === null) {
    throw new ArteRecusada(
      "A arte precisa ser PNG, JPEG ou WEBP (o conteúdo do arquivo foi conferido, não só o nome). SVG e GIF não são aceitos. Nada foi gravado.",
    );
  }
  const dim = dimensoes(a.conteudo, tipo);
  if (!dim) throw new ArteRecusada("Não consegui ler o tamanho da imagem: o arquivo parece corrompido. Nada foi gravado.");
  if (dim.largura < MIN.largura || dim.altura < MIN.altura) {
    throw new ArteRecusada(`A imagem tem ${dim.largura}×${dim.altura} px e o mínimo é ${MIN.largura}×${MIN.altura}.`);
  }
  if (dim.largura > MAX.largura || dim.altura > MAX.altura) {
    throw new ArteRecusada(`A imagem tem ${dim.largura}×${dim.altura} px e o máximo é ${MAX.largura}×${MAX.altura}.`);
  }
  return { tipo, dim };
}

/** A proporção foge de 4:5 além da tolerância? A tela avisa, não recusa. */
export function foge_da_proporcao(d: Dimensoes): boolean {
  return Math.abs(d.largura / d.altura - 4 / 5) / (4 / 5) > TOLERANCIA_PROPORCAO;
}

export async function enviar(tx: Executor, usuario: UsuarioAtual, turma: TurmaCarregada, a: ArteEnviada): Promise<Anexo> {
  if (!pode_divulgar(usuario, turma)) throw new ArteRecusada("Você não pode enviar arte desta turma.");
  if (!a.declaracao) throw new ArteRecusada(`Marque a declaração: “${DECLARACAO}”`);
  const alt = a.alt.trim().replace(/\s+/g, " ");
  if (alt.length > 160) throw new ArteRecusada("O texto alternativo passa de 160 caracteres.");
  const { tipo } = conferir(a);
  const limpo = limpar(a.conteudo, tipo);
  const r = await anexos.guardar(tx, {
    entidade: ENTIDADE,
    entidade_id: turma.id,
    nome_original: a.nome_original,
    conteudo: limpo,
    mime_type: tipo,
    categoria: CATEGORIA,
    usuario,
  });
  const anterior = turma.arte_anexo_id;
  await tx.update(tabela_turma).set({ arte_anexo_id: r.anexo.id, arte_alt: alt || null }).where(eq(tabela_turma.id, turma.id));
  turma.arte_anexo_id = r.anexo.id;
  turma.arte_alt = alt || null;
  await auditoria.registrar(tx, {
    entidade: "turma",
    entidade_id: turma.id,
    tipo_evento: "TURMA_ARTE_ENVIADA",
    descricao:
      `${turma.codigo}: arte ${anterior === null ? "enviada" : "trocada"} · anexo ${r.anexo.id} · ${tipo} · ` +
      `SHA-256 ${r.anexo.sha256.slice(0, 12)}` +
      (anterior === null || anterior === r.anexo.id ? "" : ` (o anexo ${anterior} continua guardado)`),
    campo: "arte_anexo_id",
    valor_anterior: anterior,
    valor_novo: r.anexo.id,
    usuario,
  });
  return r.anexo;
}

/** Volta para a capa gerada. O arquivo continua guardado. */
export async function remover(tx: Executor, usuario: UsuarioAtual, turma: TurmaCarregada): Promise<void> {
  if (!pode_divulgar(usuario, turma)) throw new ArteRecusada("Você não pode retirar a arte desta turma.");
  const anterior = turma.arte_anexo_id;
  if (anterior === null) return;
  await tx.update(tabela_turma).set({ arte_anexo_id: null, arte_alt: null }).where(eq(tabela_turma.id, turma.id));
  turma.arte_anexo_id = null;
  turma.arte_alt = null;
  await auditoria.registrar(tx, {
    entidade: "turma",
    entidade_id: turma.id,
    tipo_evento: "TURMA_ARTE_REMOVIDA",
    descricao: `${turma.codigo}: arte retirada (o anexo ${anterior} continua guardado)`,
    campo: "arte_anexo_id",
    valor_anterior: anterior,
    valor_novo: null,
    usuario,
  });
}

/** O anexo vigente da turma, só se for mesmo dela e da categoria certa. */
export async function vigente(tx: Executor, turma: Pick<TurmaCarregada, "id" | "arte_anexo_id">): Promise<Anexo | null> {
  if (turma.arte_anexo_id === null) return null;
  const [a] = await tx
    .select()
    .from(tabela_anexo)
    .where(and(eq(tabela_anexo.id, turma.arte_anexo_id), eq(tabela_anexo.entidade, ENTIDADE), eq(tabela_anexo.entidade_id, turma.id), eq(tabela_anexo.categoria, CATEGORIA)));
  return a ?? null;
}
