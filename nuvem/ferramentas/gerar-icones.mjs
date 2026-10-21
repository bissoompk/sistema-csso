/**
 * Gera `public/estaticos/img/icones.svg`, a folha de símbolos dos ícones.
 *
 *     node ferramentas/gerar-icones.mjs
 *
 * Os ícones são os do IntegraSST (Bootstrap Icons, MIT). Uma folha só, servida
 * pelo próprio sistema: a CSP é `'self'`, então fonte de ícone por CDN não
 * carrega, e um `<svg><use href="…#nome">` herda `currentColor` sem script.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const pasta = join(dirname(createRequire(import.meta.url).resolve("bootstrap-icons/package.json")), "icons");
const nomes = readFileSync(join(raiz, "ferramentas/icones.txt"), "utf8")
  .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

const simbolos = nomes.map((nome) => {
  const svg = readFileSync(join(pasta, `${nome}.svg`), "utf8");
  const corpo = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(svg)[1].replace(/\s+/g, " ").trim();
  return `<symbol id="${nome}" viewBox="0 0 16 16">${corpo}</symbol>`;
});
const saida = join(raiz, "public/estaticos/img/icones.svg");
writeFileSync(
  saida,
  '<svg xmlns="http://www.w3.org/2000/svg">\n' +
    "<!-- Gerado por ferramentas/gerar-icones.mjs. Bootstrap Icons 1.11.3, licença MIT. -->\n" +
    simbolos.join("\n") + "\n</svg>\n",
);
console.log(`${nomes.length} ícones em ${saida}`);
