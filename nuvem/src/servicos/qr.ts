/**
 * O QR da validação do certificado: a matriz (para o PDF desenhar em vetor) e
 * um PNG síncrono (para o marcador `certificado_qrcode` do .docx).
 */
import { deflateSync, crc32 } from "node:zlib";
import QRCode from "qrcode";

/** A matriz do QR (nível M: aguenta papel amassado sem crescer demais). */
export function matriz_qr(texto: string): { tamanho: number; escuro: (linha: number, coluna: number) => boolean } {
  const qr = QRCode.create(texto, { errorCorrectionLevel: "M" });
  return { tamanho: qr.modules.size, escuro: (l, c) => Boolean(qr.modules.get(l, c)) };
}

function _bloco_png(tipo: string, dados: Uint8Array): Buffer {
  const tamanho = Buffer.alloc(4);
  tamanho.writeUInt32BE(dados.length);
  const corpo = Buffer.concat([Buffer.from(tipo, "latin1"), dados]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corpo) >>> 0);
  return Buffer.concat([tamanho, corpo, crc]);
}

/**
 * O QR como PNG (preto e branco, 8 bits de cinza), síncrono — o marcador
 * `certificado_qrcode` do .docx é resolvido no meio de um mapa síncrono.
 */
export function qr_png(texto: string, escala = 8): Uint8Array {
  const { tamanho, escuro } = matriz_qr(texto);
  const lado = (tamanho + 8) * escala;
  const linhas = Buffer.alloc(lado * (lado + 1), 0xff);
  for (let y = 0; y < lado; y++) {
    linhas[y * (lado + 1)] = 0; // filtro "nenhum"
    const l = Math.floor(y / escala) - 4;
    for (let x = 0; x < lado; x++) {
      const c = Math.floor(x / escala) - 4;
      if (l >= 0 && c >= 0 && l < tamanho && c < tamanho && escuro(l, c)) linhas[y * (lado + 1) + 1 + x] = 0;
    }
  }
  const cabecalho = Buffer.alloc(13);
  cabecalho.writeUInt32BE(lado, 0);
  cabecalho.writeUInt32BE(lado, 4);
  cabecalho[8] = 8; // bits por amostra
  cabecalho[9] = 0; // tons de cinza
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    _bloco_png("IHDR", cabecalho),
    _bloco_png("IDAT", deflateSync(linhas)),
    _bloco_png("IEND", new Uint8Array()),
  ]);
}
