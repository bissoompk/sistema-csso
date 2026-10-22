/**
 * O sistema no celular — a casca, a folha global e o JS (lote 0 do plano de
 * celular, P1 a P20).
 *
 * O que é regra aqui, e não só desenho:
 *
 * - a página não ganha largura no celular por causa do filtro em linha (P1)
 *   nem do título livre da trilha (P2);
 * - o campo tem 16px no celular, que é o que impede o zoom do iPhone ao focar
 *   — e o viewport NÃO tira o zoom de ninguém (`maximum-scale`) (P3);
 * - o realce de linha só existe onde há cursor (P16);
 * - as classes-contrato que as telas aplicam existem na folha;
 * - o `@media print` continua sendo o último bloco da folha;
 * - a casca liga o manifesto em toda tela, com uma `theme-color` só, e a porta
 *   para a tela de bolso (P14).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bancoLimpo, contas, entrar } from "./ajuda";

const NUVEM = path.resolve(__dirname, "..");
const ler = (rel: string) => readFileSync(path.join(NUVEM, rel), "utf-8");

interface Regra { media: string[]; seletor: string; corpo: string }

/** As regras da folha, cada uma com as `@media` que a envolvem. */
function regras(css: string): Regra[] {
  const limpo = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const saida: Regra[] = [];
  const pilha: string[] = [];
  let i = 0;
  let inicio = 0;
  while (i < limpo.length) {
    const c = limpo[i];
    if (c === "{") {
      const prelude = limpo.slice(inicio, i).trim();
      if (prelude.startsWith("@")) {
        pilha.push(prelude);
        inicio = i + 1;
      } else {
        const fim = limpo.indexOf("}", i);
        saida.push({ media: [...pilha], seletor: prelude, corpo: limpo.slice(i + 1, fim) });
        i = fim;
        inicio = fim + 1;
      }
    } else if (c === "}") {
      pilha.pop();
      inicio = i + 1;
    }
    i++;
  }
  return saida;
}

const CSSO = ler("public/estaticos/css/csso.css");
const TEMA = ler("public/estaticos/css/tema.css");
const R = regras(CSSO);
/** Do título do bloco CELULAR até a seção seguinte ("só no papel"). */
const blocoCelular = () =>
  CSSO.slice(CSSO.indexOf("/* ===== CELULAR (lote 0) ====="), CSSO.indexOf("/* ---------- so no papel"));

describe("a folha global no celular", () => {
  it("o filtro em linha quebra linha (P1)", () => {
    const r = R.find((x) => x.media.length === 0 && x.seletor === ".fileira > form.filtro-inline");
    expect(r?.corpo).toMatch(/flex-wrap:\s*wrap/);
    expect(r?.corpo).toMatch(/max-width:\s*100%/);
  });

  it("o último nível da trilha termina em reticências em vez de alargar a página (P2)", () => {
    const r = R.find((x) => x.media.length === 0 && x.seletor === ".trilha > :last-child");
    expect(r?.corpo).toMatch(/text-overflow:\s*ellipsis/);
    expect(r?.corpo).toMatch(/max-width:\s*100%/);
  });

  it("o campo tem 16px no celular e no toque (P3)", () => {
    const r = R.find((x) =>
      /font-size:\s*16px/.test(x.corpo) && /\bselect\b/.test(x.seletor) && /\btextarea\b/.test(x.seletor) &&
      x.media.some((m) => /pointer:\s*coarse|max-width:\s*900px/.test(m)));
    expect(r, "falta a regra de 16px nos campos").toBeTruthy();
    expect(r!.seletor).toContain("input:not([type=checkbox])");
  });

  it("as classes-contrato que as telas aplicam existem (lote 0)", () => {
    for (const contrato of [".coluna-fixa", ".fileira.rola", ".marca-linha", ".perm-pilula", "td.curta", ".so-celular", "details.cartao.perfil", "label.alvo-marca"]) {
      const alvo = contrato === "td.curta" ? /\.curta\b/ : new RegExp(contrato.replace(/\./g, "\\."));
      expect(R.some((x) => alvo.test(x.seletor)), contrato).toBe(true);
    }
  });

  it("o realce de linha (`tr:hover`) só existe onde há cursor (P16)", () => {
    for (const [nome, css] of [["csso.css", CSSO], ["tema.css", TEMA]] as const) {
      const comHover = regras(css).filter((x) => x.seletor.includes("tr:hover"));
      expect(comHover.length, nome).toBeGreaterThan(0);
      for (const r of comHover) expect(r.media.join(" "), `${nome}: ${r.seletor}`).toMatch(/hover:\s*hover/);
    }
    // o deslocamento do cartão e do botão também, e só com mouse
    for (const r of regras(TEMA).filter((x) => /translateY\(-/.test(x.corpo) && /:hover/.test(x.seletor))) {
      expect(r.media.join(" "), r.seletor).toMatch(/hover:\s*hover\)\s*and\s*\(pointer:\s*fine/);
    }
  });

  it("o bloco CELULAR não usa `!important` e vem antes do `@media print`, que é o último", () => {
    const bloco = blocoCelular();
    expect(bloco.length).toBeGreaterThan(1000);
    expect(bloco.indexOf("/* ===== CELULAR")).toBeLessThan(CSSO.indexOf("@media print {"));
    expect(bloco.replace(/\/\*[\s\S]*?\*\//g, "")).not.toContain("!important");
    // depois do bloco de impressão não sobra regra nenhuma
    const ultimo = R[R.length - 1]!;
    expect(ultimo.media[0]).toBe("@media print");
    expect(R.filter((x) => x.media.length === 0).every((x) => CSSO.indexOf(x.seletor) < CSSO.indexOf("@media print {"))).toBe(true);
    const depois = CSSO.slice(CSSO.lastIndexOf("@media print {")).replace(/\/\*[\s\S]*?\*\//g, "");
    let prof = 0; let fim = -1;
    for (let i = 0; i < depois.length; i++) {
      if (depois[i] === "{") prof++;
      if (depois[i] === "}" && --prof === 0) { fim = i; break; }
    }
    expect(depois.slice(fim + 1).trim()).toBe("");
  });

  it("fora das classes-contrato, toda regra do bloco CELULAR está numa faixa ou num tipo de ponteiro", () => {
    for (const r of regras(blocoCelular())) {
      if (r.media.length) {
        expect(r.media.join(" "), r.seletor).toMatch(/max-width:\s*(900|600|480)px|pointer:\s*coarse|hover:\s*hover/);
      } else {
        expect(r.seletor, "regra solta no bloco CELULAR").toMatch(/so-celular|marca-linha|alvo-marca|details\.cartao\.perfil/);
      }
    }
  });

  it("o JS fecha o menu do celular com Esc e com toque fora", () => {
    const js = ler("public/estaticos/js/csso.js");
    expect(js).toContain("summary[data-menu-celular]");
    expect(js).toMatch(/menu\.open = false/);
  });

  it("o manifesto tem `id` e continua abrindo na tela de bolso", () => {
    const m = JSON.parse(ler("public/estaticos/manifest.webmanifest"));
    expect(m.id).toBe("/celular");
    expect(m.start_url).toBe("/celular");
  });
});

// Um banco só para o arquivo, como em `correcoes_visual.test.ts`.
const { db, novoCliente } = await bancoLimpo();
await contas(db);
const cliente = await entrar(novoCliente(), "coordenador_csso");
const telas: Record<string, string> = {};
for (const url of ["/processos", "/demandas", "/celular"]) telas[url] = (await cliente.get(url)).text;

describe("a casca no celular (HTML renderizado)", () => {

  it("o viewport cobre a área segura e encolhe com o teclado, sem tirar o zoom (P5/P3)", () => {
    for (const corpo of Object.values(telas)) {
      const vp = /<meta name="viewport" content="([^"]+)">/.exec(corpo)?.[1] ?? "";
      expect(vp).toContain("viewport-fit=cover");
      expect(vp).toContain("interactive-widget=resizes-content");
      expect(vp).not.toMatch(/maximum-scale|user-scalable/);
    }
  });

  it("o manifesto vem em toda tela, e a tela de bolso tem uma `theme-color` só (P14)", () => {
    for (const corpo of Object.values(telas)) {
      expect(corpo.split('<link rel="manifest" href="/estaticos/manifest.webmanifest">').length - 1).toBe(1);
      expect(corpo).toContain('<meta name="mobile-web-app-capable" content="yes">');
      expect(corpo).not.toContain("apple-mobile-web-app-capable");
    }
    expect(telas["/celular"]!.match(/<meta name="theme-color"/g)).toHaveLength(1);
  });

  it("a porta para o modo celular existe em toda tela com casca (P14)", () => {
    for (const url of ["/processos", "/demandas"]) {
      expect(telas[url], url).toMatch(/<a class="so-celular modo-celular" href="\/celular">Modo celular<\/a>/);
    }
    // a tela de bolso não tem casca, e não aponta para si mesma
    expect(telas["/celular"]).not.toContain('class="so-celular');
  });

  it("a busca global tem placeholder curto, e o texto inteiro no `title` (P14)", () => {
    const campo = /<input type="search" name="q" id="busca-global"[^>]*>/.exec(telas["/processos"]!)?.[0] ?? "";
    const ph = /placeholder="([^"]*)"/.exec(campo)?.[1] ?? "";
    expect(ph.length).toBeGreaterThan(0);
    expect(ph.length).toBeLessThanOrEqual(12);
    expect(campo).toMatch(/title="Buscar em todo o sistema[^"]+"/);
  });

  it("o menu do celular continua um <details> sem JS, com o contrato do Esc no <summary>", () => {
    expect(telas["/processos"]).toContain('<details class="menu-celular">');
    expect(telas["/processos"]).toContain("<summary data-menu-celular>");
  });

  it("nenhum `style=` nem `<style>` embutido (CSP)", () => {
    for (const [url, corpo] of Object.entries(telas)) {
      expect(corpo, url).not.toMatch(/<style[\s>]/);
      expect(corpo, url).not.toMatch(/\sstyle="/);
    }
  });
});
