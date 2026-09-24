/**
 * Converte os modelos .docx do sistema Python (sintaxe docxtpl) para a
 * sintaxe do docxtemplater, em `nuvem/modelos-docx/`.
 *
 *     npx tsx ferramentas/converter-modelos-docx.ts
 *
 * Os `.docx` de origem continuam em `app/templates/` — é lá que o setor os
 * edita no Word, com os marcadores `{{ x }}` que o manual descreve. Esta
 * ferramenta refaz as cópias convertidas e o `manifesto.json` (SHA-256 da
 * origem e da cópia, e os marcadores de cada modelo). Rode de novo sempre que
 * um modelo de origem mudar; o teste `documento.test.ts` acusa cópia velha.
 *
 * O que a conversão faz está em `src/servicos/docx_baixo_nivel.ts`
 * (`converter_modelo_docxtpl`).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { converter_modelo_docxtpl } from "../src/servicos/docx_baixo_nivel.js";

const aqui = path.dirname(fileURLToPath(import.meta.url));
export const ORIGEM = path.resolve(aqui, "../../app/templates");
export const DESTINO = path.resolve(aqui, "../modelos-docx");

/** Os modelos do sistema, relativos a `app/templates/`. */
export const MODELOS = [
  "modelo_parecer_v1.docx",
  "modelo_parecer_v2.docx",
  "lista_presenca_v1.docx",
  "comprovante_epi_v1.docx",
  "certificados/certificado_padrao_v1.docx",
];

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export function converterTudo(origem = ORIGEM, destino = DESTINO): Record<string, unknown> {
  const manifesto: Record<string, unknown> = {};
  for (const relativo of MODELOS) {
    const bytes = new Uint8Array(readFileSync(path.join(origem, relativo)));
    const convertido = converter_modelo_docxtpl(bytes);
    const alvo = path.join(destino, relativo);
    mkdirSync(path.dirname(alvo), { recursive: true });
    writeFileSync(alvo, convertido.bytes);
    manifesto[relativo] = {
      sha256_origem: sha(bytes),
      sha256_convertido: sha(convertido.bytes),
      marcadores: convertido.marcadores,
    };
  }
  writeFileSync(path.join(destino, "manifesto.json"), JSON.stringify(manifesto, null, 2) + "\n");
  return manifesto;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifesto = converterTudo();
  for (const [nome, info] of Object.entries(manifesto)) {
    console.log(`[converter] ${nome}: ${(info as { marcadores: string[] }).marcadores.length} marcadores`);
  }
}
