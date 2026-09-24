/** Lê `nuvem/.env` (se existir) para dentro de `process.env`, sem sobrescrever. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export function carregarEnvLocal(arquivo = path.resolve(process.cwd(), ".env")): void {
  if (!existsSync(arquivo)) return;
  for (const linha of readFileSync(arquivo, "utf8").split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || linha.trimStart().startsWith("#")) continue;
    const [, chave, bruto] = m;
    const valor = bruto!.replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[chave!] === undefined) process.env[chave!] = valor;
  }
}
