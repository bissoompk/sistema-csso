/**
 * A lateral recolhível (DESVIOS.md, "Lateral recolhível (22/10/2026)").
 *
 * O que é regra aqui, e não só desenho:
 *
 * - o botão de recolher mora no alto da lateral, é um interruptor de verdade
 *   (nome fixo, estado em `aria-expanded`, `aria-controls` para o que encolhe)
 *   e diz o atalho no `title`;
 * - a preferência vem do cookie `csso_lateral` e é o SERVIDOR quem escreve a
 *   classe no <html> — a página já nasce recolhida, sem piscar;
 * - na faixa o nome de cada item continua no HTML (para o leitor de tela) e
 *   no `data-rotulo` (para a etiqueta de quem vê);
 * - nada de estilo nem script embutido (CSP);
 * - a folha só recolhe na mesa e na tela: o celular e o papel não mudam.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bancoLimpo, contas, entrar } from "./ajuda";

const NUVEM = path.resolve(__dirname, "..");
const ler = (rel: string) => readFileSync(path.join(NUVEM, rel), "utf-8");

interface Regra { media: string[]; seletor: string; corpo: string }

/** As regras da folha, cada uma com as `@media` que a envolvem (o mesmo leitor de `celular_casca`). */
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

const { db, novoCliente } = await bancoLimpo();
await contas(db);
const aberta = await entrar(novoCliente(), "coordenador_csso");
const recolhida = await entrar(novoCliente(), "coordenador_csso");
recolhida.cookies.set("csso_lateral", "recolhida");

/** A tag do botão de recolher, inteira. */
const botao = (corpo: string) => /<button type="button" class="recolher-lateral"[^>]*>/.exec(corpo)?.[0] ?? "";
const lateral = (corpo: string) => corpo.slice(corpo.indexOf('<aside class="lateral">'), corpo.indexOf("</aside>"));

describe("o botão de recolher na casca", () => {
  it("está no alto da lateral, com ícone e os atributos de interruptor", async () => {
    const corpo = (await aberta.get("/turmas")).text;
    const ld = lateral(corpo);
    const b = botao(corpo);
    expect(b).not.toBe("");
    // no alto: depois da marca e antes de qualquer bloco de navegação
    expect(ld.indexOf('class="recolher-lateral"')).toBeGreaterThan(ld.indexOf('class="marca"'));
    expect(ld.indexOf('class="recolher-lateral"')).toBeLessThan(ld.indexOf("<nav"));
    expect(b).toContain("data-recolher-lateral");
    expect(b).toContain('aria-label="Menu lateral"');
    expect(b).toContain('aria-keyshortcuts="Control+B Meta+B"');
    expect(b).toMatch(/title="[^"]*Ctrl\+B[^"]*"/);
    expect(ld).toMatch(/data-recolher-lateral[\s\S]*?#layout-sidebar-inset/);
    // `aria-controls` aponta para blocos que existem na página
    const ids = (/aria-controls="([^"]+)"/.exec(b)?.[1] ?? "").split(/\s+/).filter(Boolean);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(corpo, id).toContain(`id="${id}"`);
    // e a folha de ícones tem o desenho
    expect(ler("public/estaticos/img/icones.svg")).toContain('<symbol id="layout-sidebar-inset"');
  });

  it("sem o cookie a lateral vem expandida", async () => {
    const corpo = (await aberta.get("/turmas")).text;
    expect(corpo).toContain('<html lang="pt-BR">');
    expect(corpo).not.toContain("lateral-recolhida");
    expect(botao(corpo)).toContain('aria-expanded="true"');
    expect(botao(corpo)).toContain('title="Recolher o menu (Ctrl+B)"');
  });

  it("com o cookie a página já vem recolhida do servidor, sem esperar o script", async () => {
    const corpo = (await recolhida.get("/turmas")).text;
    expect(corpo).toContain('<html lang="pt-BR" class="lateral-recolhida">');
    expect(botao(corpo)).toContain('aria-expanded="false"');
    expect(botao(corpo)).toContain('title="Expandir o menu (Ctrl+B)"');
    // valor diferente de "recolhida" não recolhe
    const outro = await entrar(novoCliente(), "coordenador_csso");
    outro.cookies.set("csso_lateral", "qualquer");
    expect((await outro.get("/turmas")).text).not.toContain("lateral-recolhida");
  });

  it("na faixa cada item continua com o nome no HTML e no `data-rotulo`", async () => {
    const ld = lateral((await recolhida.get("/turmas")).text);
    const links = ld.match(/<a [^>]*>[\s\S]*?<\/a>/g) ?? [];
    expect(links.length).toBeGreaterThan(5);
    for (const a of links) {
      const rotulo = /data-rotulo="([^"]+)"/.exec(a)?.[1];
      expect(rotulo, a).toBeTruthy();
      // o texto do <span> é o mesmo da etiqueta, e é ele o nome do link
      if (!a.includes('class="marca"')) expect(a, a).toContain(`<span>${rotulo}</span>`);
    }
    expect(ld).toContain('<span class="marca-texto">');
  });

  it("nenhum `style=` nem `<style>`/`<script>` embutido", async () => {
    for (const cli of [aberta, recolhida]) {
      const corpo = (await cli.get("/turmas")).text;
      expect(corpo).not.toMatch(/<style[\s>]/);
      expect(corpo).not.toMatch(/\sstyle="/);
      // todo <script> é de arquivo ou leva o nonce da resposta
      for (const s of corpo.match(/<script[^>]*>/g) ?? []) expect(s).toMatch(/\ssrc="|\snonce="/);
    }
  });
});

describe("o comportamento (csso.js)", () => {
  const js = ler("public/estaticos/js/csso.js");

  it("o clique no botão e o Ctrl/Cmd+B alternam a classe e gravam o cookie", () => {
    expect(js).toContain("'[data-recolher-lateral]'");
    expect(js).toMatch(/classList\.toggle\('lateral-recolhida'/);
    expect(js).toMatch(/setAttribute\('aria-expanded'/);
    expect(js).toContain("var COOKIE_LATERAL = 'csso_lateral';");
    expect(js).toContain("=recolhida; Max-Age=31536000; Path=/; SameSite=Lax");
    expect(js).toMatch(/e\.ctrlKey \|\| e\.metaKey/);
    expect(js).toMatch(/e\.key !== 'b' && e\.key !== 'B'/);
  });

  it("o atalho não dispara em campo de texto nem no celular", () => {
    const bloco = js.slice(js.indexOf("// 11. Recolher a lateral"));
    expect(bloco).toContain("if (ehCampoDeTexto(e.target)) return;");
    expect(js).toMatch(/isContentEditable/);
    expect(bloco).toContain("matchMedia('(min-width: 901px)')");
  });
});

describe("a folha", () => {
  const CSSO = ler("public/estaticos/css/csso.css");
  const R = regras(CSSO);
  const daLateral = R.filter((r) => /lateral-recolhida|recolher-lateral|--largura-lateral-recolhida/.test(r.seletor + r.corpo));

  it("toda regra da faixa está na mesa e na tela; fora dela, o botão só some", () => {
    expect(daLateral.length).toBeGreaterThan(5);
    for (const r of daLateral) {
      if (r.media.length === 0) {
        expect(r.seletor).toBe(".recolher-lateral");
        expect(r.corpo.trim()).toBe("display: none;");
        continue;
      }
      expect(r.media.join(" "), r.seletor).toMatch(/screen and \(min-width: 901px\)/);
    }
  });

  it("o celular e o papel não mudam: nenhuma regra da faixa nas faixas estreitas nem no `@media print`", () => {
    for (const r of R.filter((x) => x.media.some((m) => /max-width|print/.test(m)))) {
      expect(r.seletor, r.seletor).not.toMatch(/lateral-recolhida|recolher-lateral/);
    }
    for (const outra of ["tema.css", "celular.css"]) {
      expect(ler(`public/estaticos/css/${outra}`), outra).not.toMatch(/lateral-recolhida|recolher-lateral/);
    }
  });

  it("os subtítulos e o rodapé somem, o texto vai para fora da tela sem sair da árvore", () => {
    const some = daLateral.find((r) => r.seletor.includes(".rotulo-grupo") && r.seletor.includes(".rotulo-secao"));
    expect(some?.corpo).toMatch(/display:\s*none/);
    expect(some?.seletor).toContain(".rodape-lateral");
    const oculto = daLateral.find((r) => r.seletor.includes(".marca-texto"));
    expect(oculto?.corpo).toMatch(/clip: rect\(0 0 0 0\)/);
    expect(oculto?.corpo).not.toMatch(/display:\s*none/);
  });

  it("a etiqueta aparece no mouse e no Tab, sem repetir o nome para o leitor de tela", () => {
    const etiqueta = daLateral.find((r) => r.seletor.includes("::after"));
    expect(etiqueta?.seletor).toMatch(/:hover/);
    expect(etiqueta?.seletor).toMatch(/:focus-visible/);
    expect(etiqueta?.corpo).toContain('content: attr(data-rotulo) / "";');
  });

  it("a transição é suave e respeita quem não quer movimento", () => {
    expect(daLateral.some((r) => /transition:\s*flex-basis/.test(r.corpo))
      || R.some((r) => r.seletor === ".lateral" && /transition:/.test(r.corpo) && r.media.join(" ").includes("901px"))).toBe(true);
    const calma = R.find((r) => r.seletor === ".lateral" && r.media.join(" ").includes("prefers-reduced-motion: reduce"));
    expect(calma?.corpo).toMatch(/transition:\s*none/);
    expect(calma?.media.join(" ")).toContain("min-width: 901px");
  });
});
