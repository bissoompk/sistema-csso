/**
 * A identidade visual da Sisa na tela (DESVIOS.md, "Identidade visual da
 * Sisa"): o símbolo das quatro pessoas é o ícone da aba, do atalho e do
 * manifesto, e a marca da lateral; as cores do tema saem dele.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const NUVEM = path.resolve(__dirname, "..");
const ler = (rel: string) => readFileSync(path.join(NUVEM, rel), "utf-8");
/** Largura, altura e tipo de cor do PNG, lidos do IHDR (6 = RGBA, 2 = RGB). */
function png(rel: string) {
  const b = readFileSync(path.join(NUVEM, rel));
  expect(b.subarray(12, 16).toString("latin1")).toBe("IHDR");
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), cor: b[25] };
}

describe("identidade visual da Sisa", () => {
  it("a casca liga o favicon, o ícone do atalho e a cor da barra antes do bloco da tela", () => {
    const base = ler("templates/base.html");
    const cabeca = base.slice(0, base.indexOf("</head>"));
    for (const arq of ["favicon-16.png", "favicon-32.png", "favicon-48.png", "apple-touch-icon.png"]) {
      expect(cabeca).toContain(`/estaticos/img/${arq}`);
    }
    expect(cabeca).toContain('<meta name="theme-color" content="#0a2a5c">');
    // a primeira theme-color vale: a da casca vem antes do bloco `cabeca`
    expect(cabeca.indexOf("theme-color")).toBeLessThan(cabeca.indexOf("{% block cabeca %}"));
  });

  it("a marca da lateral e do cabeçalho sem casca é o símbolo, com o texto ao lado", () => {
    const base = ler("templates/base.html");
    const img = '<img src="/estaticos/img/marca-sisa.png" width="80" height="80" alt="">';
    expect(base.split(img).length - 1).toBe(2);
    expect(base).toContain("<strong>CSSO</strong><span>Sisa · UFVJM</span>");
    expect(base).not.toContain("partes/marca.svg");
  });

  it("os ícones têm o tamanho que declaram; o favicon é transparente e o do atalho, opaco", () => {
    for (const [arq, n] of [["favicon-16.png", 16], ["favicon-32.png", 32], ["favicon-48.png", 48],
      ["apple-touch-icon.png", 180], ["icone-192.png", 192], ["icone-512.png", 512],
      ["icone-maskable-512.png", 512], ["marca-sisa.png", 80]] as const) {
      const p = png(`public/estaticos/img/${arq}`);
      expect([arq, p.width, p.height]).toEqual([arq, n, n]);
    }
    expect(png("public/estaticos/img/favicon-32.png").cor).toBe(6); // com alfa
    expect(png("public/estaticos/img/marca-sisa.png").cor).toBe(6);
    // o iOS pinta de preto o transparente do ícone do atalho: ele é opaco
    expect(png("public/estaticos/img/apple-touch-icon.png").cor).toBe(2);
    expect(png("public/estaticos/img/icone-maskable-512.png").cor).toBe(2);
    // o .ico da raiz: cabeçalho ICONDIR com três imagens
    const ico = readFileSync(path.join(NUVEM, "public/favicon.ico"));
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([0, 1, 3]);
  });

  it("o tema não guarda mais o verde-azulado do IntegraSST", () => {
    const tema = ler("public/estaticos/css/tema.css");
    expect(tema).not.toMatch(/#0f766e|#0d9488|#14b8a6|#f0fdfa|#5eead4|#ccfbf1|13, 148, 136/i);
    expect(tema).toMatch(/--acento: #0058a3;/);
    expect(tema).toMatch(/--lateral: #0a2a5c;/);
  });

  it("o manifesto e o app compilado usam a mesma cor e o símbolo", () => {
    const manifesto = JSON.parse(ler("public/estaticos/manifest.webmanifest"));
    expect(manifesto.theme_color).toBe("#0a2a5c");
    expect(manifesto.icons.map((i: { src: string }) => i.src)).toContain("/estaticos/img/icone-512.png");
    const app = ler("public/estaticos/app/index.html");
    expect(app).toContain('<meta name="theme-color" content="#0a2a5c">');
    expect(app).toContain("/estaticos/img/favicon-32.png");
  });
});
