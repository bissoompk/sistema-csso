/**
 * Teto de descompressão para arquivo em formato zip que chega por upload
 * (`.xlsx`, `.docx`) — o "zip-bomb" (revisão de segurança, 25/09/2026).
 *
 * O ExcelJS e o docxtemplater descompactam tudo em memória. Um `.xlsx` de
 * 100 KB pode declarar gigabytes de planilha, e a função do Netlify (1 GB)
 * cai antes de qualquer validação nossa rodar. A conferência vem ANTES de
 * entregar o arquivo à biblioteca.
 *
 * O tamanho declarado no diretório do zip não basta: é o próprio atacante que
 * o escreve. Cada entrada é descompactada de verdade, com `maxOutputLength` do
 * zlib — que interrompe a descompressão ao passar do teto, em vez de medir
 * depois. Custa descompactar duas vezes um arquivo que, legítimo, tem poucos MB.
 */
import { inflateRawSync } from "node:zlib";
import PizZip from "pizzip";

/** Soma descompactada aceita. Uma planilha de 1.000 linhas tem poucos MB. */
export const TETO_DESCOMPACTADO = 64 * 1024 * 1024;
/** Entradas no zip: um `.xlsx` real tem dezenas. */
export const MAXIMO_ENTRADAS = 2000;

export class ArquivoZipRecusado extends Error {}

type EntradaPizZip = {
  dir: boolean;
  _data?: { compressionMethod?: string; getCompressedContent?: () => Uint8Array };
};

/** Recusa (com mensagem para a pessoa) o zip que não abre, ou que abre grande demais. */
export function conferir_zip(
  bytes: Uint8Array,
  teto: number = TETO_DESCOMPACTADO,
  maximo_entradas: number = MAXIMO_ENTRADAS,
): void {
  let zip: PizZip;
  try {
    zip = new PizZip(bytes);
  } catch {
    throw new ArquivoZipRecusado("O arquivo não é um .xlsx/.docx válido (não abriu como zip).");
  }
  const entradas = Object.values(zip.files as Record<string, EntradaPizZip>).filter((e) => !e.dir);
  if (entradas.length > maximo_entradas) {
    throw new ArquivoZipRecusado(`O arquivo tem ${entradas.length} partes internas; o máximo aceito é ${maximo_entradas}.`);
  }
  const excedeu = () =>
    new ArquivoZipRecusado(
      `O arquivo descompactado passa de ${Math.round(teto / 1024 / 1024)} MB. ` +
        "Divida a planilha ou remova imagens embutidas e envie de novo.",
    );
  let total = 0;
  for (const entrada of entradas) {
    const dados = entrada._data;
    const bruto = dados?.getCompressedContent?.();
    if (!dados || !bruto) continue;
    const restante = teto - total;
    if (restante <= 0) throw excedeu();
    // Métodos de compressão do zip: "\x00\x00" = guardado, "\x08\x00" = DEFLATE.
    if (dados.compressionMethod === "\x00\x00") {
      total += bruto.length;
    } else {
      try {
        total += inflateRawSync(bruto, { maxOutputLength: restante }).length;
      } catch (erro) {
        if ((erro as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw excedeu();
        throw new ArquivoZipRecusado("O arquivo está corrompido (uma parte interna não descompacta).");
      }
    }
    if (total > teto) throw excedeu();
  }
}
