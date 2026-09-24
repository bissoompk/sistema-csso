/**
 * Varredura de TODOS os templates (`templates/**`), sem banco.
 *
 * O Nunjucks só acusa muita coisa na hora de desenhar a tela — e muitas vezes
 * não acusa: aceita a sintaxe do Jinja e a avalia errado, calado. Este teste
 * pega o que dá para pegar sem renderizar:
 *
 * 1. **Compila** cada arquivo com o ambiente de `src/web.ts` (o mesmo
 *    carregador, com o `adaptarJinja`): erro de sintaxe falha aqui, e não na
 *    frente do usuário.
 * 2. **Filtro e teste existem**: o Nunjucks resolve `|filtro` e `is teste` só
 *    ao desenhar (`env.getFilter`), então um filtro do Jinja não registrado
 *    passaria na compilação e daria 500 na tela.
 * 3. **Padrões do Jinja que o Nunjucks avalia errado** sem erro nenhum:
 *    `for x in y if c` (não itera nada), tupla `in ('A', 'B')` que o
 *    carregador não converteu (vira substring de 'B'), `loop.cycle`,
 *    `namespace()`, `{% with %}`.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import nunjucks from "nunjucks";
import { describe, expect, it } from "vitest";
import { adaptarJinja, ambiente } from "../src/web.js";
// carrega as rotas: filtros e globais registrados pelos módulos donos
// (`cnpj` do EPI, `porta_de_entrada`, `POLITICA_SENHA`...) entram no ambiente
import "../src/rotas/index.js";

const RAIZ = path.resolve(import.meta.dirname, "../templates");

function arquivos(pasta: string): string[] {
  return readdirSync(pasta, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? arquivos(path.join(pasta, d.name)) : d.name.endsWith(".html") ? [path.join(pasta, d.name)] : [],
  );
}
const TEMPLATES = arquivos(RAIZ).map((f) => path.relative(RAIZ, f).split(path.sep).join("/")).sort();

/** Tira os comentários `{# #}` preservando as linhas (para o número bater). */
function semComentarios(fonte: string): string {
  return fonte.replace(/\{#[\s\S]*?#\}/g, (m) => "\n".repeat(m.split("\n").length - 1));
}

/** Todos os nós de um tipo na árvore do parser do Nunjucks. */
function nos(raiz: any, tipo: string, saida: any[] = []): any[] {
  if (!raiz || typeof raiz !== "object") return saida;
  if (raiz.typename === tipo) saida.push(raiz);
  if (Array.isArray(raiz.children)) for (const f of raiz.children) nos(f, tipo, saida);
  for (const campo of raiz.fields ?? []) nos(raiz[campo], tipo, saida);
  return saida;
}

function arvore(nome: string): any {
  const fonte = adaptarJinja(readFileSync(path.join(RAIZ, nome), "utf8"));
  return (nunjucks as any).parser.parse(fonte, [], {});
}

const PROIBIDOS: [RegExp, string][] = [
  [/\{%-?\s*for\b[^%]*?\bin\b[^%]*?\sif\s[^%]*%\}/, "`for x in y if c` — o Nunjucks não itera nada; use for + if"],
  [/\bin\s*\(\s*(?:'[^']*'|"[^"]*"|-?\d+|none)\s*,/, "tupla `in (a, b)` — use lista `[a, b]`"],
  [/loop\.cycle/, "`loop.cycle` não existe no Nunjucks"],
  [/\bnamespace\(/, "`namespace()` não existe no Nunjucks"],
  [/\{%-?\s*(end)?with\b/, "`{% with %}` não existe no Nunjucks; use `{% set %}`"],
];

describe("templates", () => {
  it("há templates para varrer", () => {
    expect(TEMPLATES.length).toBeGreaterThan(60);
  });

  it.each(TEMPLATES)("%s compila", (nome) => {
    // eagerCompile: compila já, sem renderizar
    expect(() => ambiente.getTemplate(nome, true)).not.toThrow();
  });

  it.each(TEMPLATES)("%s só usa filtro e teste registrados", (nome) => {
    const raiz = arvore(nome);
    const faltando: string[] = [];
    for (const f of [...nos(raiz, "Filter"), ...nos(raiz, "FilterAsync")]) {
      const n = f.name?.value;
      try {
        ambiente.getFilter(n);
      } catch {
        faltando.push(`|${n} (linha ${f.lineno + 1})`);
      }
    }
    for (const t of nos(raiz, "Is")) {
      const n = t.right?.name ? t.right.name.value : t.right?.value;
      const nome_teste = n === null ? "null" : String(n);
      try {
        (ambiente as unknown as { getTest(n: string): unknown }).getTest(nome_teste);
      } catch {
        faltando.push(`is ${nome_teste} (linha ${t.lineno + 1})`);
      }
    }
    expect(faltando).toEqual([]);
  });

  it.each(TEMPLATES)("%s não tem Jinja que o Nunjucks avalia errado", (nome) => {
    const fonte = semComentarios(adaptarJinja(readFileSync(path.join(RAIZ, nome), "utf8")));
    const achados: string[] = [];
    fonte.split("\n").forEach((linha, i) => {
      for (const tag of linha.match(/\{[{%].*?[}%]\}/g) ?? []) {
        for (const [padrao, motivo] of PROIBIDOS) if (padrao.test(tag)) achados.push(`linha ${i + 1}: ${motivo}: ${tag}`);
      }
    });
    expect(achados).toEqual([]);
  });
});

describe("Jinja no Nunjucks (o que web.ts remenda)", () => {
  const r = (t: string, c: Record<string, unknown> = {}) => ambiente.renderString(t, c);

  it("métodos de dict em objeto simples e em Map", () => {
    const d = { a: 1, b: 2 };
    expect(r("{{ d.get('a', 9) }}|{{ d.get('z', 9) }}|{{ d.get('z') is none }}", { d })).toBe("1|9|true");
    expect(r("{% for k, v in d.items() %}{{ k }}={{ v }};{% endfor %}{{ d.values()|sum }}", { d })).toBe("a=1;b=2;3");
    expect(r("{{ d.keys()|join(',') }}|{{ d|length }}", { d })).toBe("a,b|2");
    const m = new Map([[1, 5], [2, 6]]);
    expect(r("{{ m.get(1) }}|{% for k, v in m.items() %}{{ k }}={{ v }};{% endfor %}{{ m.values()|sum }}", { m })).toBe(
      "5|1=5;2=6;11",
    );
  });

  it("chave de verdade com nome de método continua valendo", () => {
    expect(r("{{ d.items }}", { d: { items: "x" } })).toBe("x");
  });

  it("métodos de str do Python", () => {
    expect(r("{{ s.upper() }} {{ s.lower() }} {{ ' x '.strip() }} {{ s.startswith('Ab') }} {{ s.endswith('z') }}", { s: "Abc" })).toBe(
      "ABC abc x true false",
    );
  });

  it("testes do Jinja: true, false, none (e undefined é none)", () => {
    expect(r("{{ x is true }} {{ y is false }} {{ z is none }} {{ w is not none }}", { x: true, y: false, w: 0 })).toBe(
      "true true true true",
    );
  });

  it("verdade do Jinja: lista e dict vazios são falsos", () => {
    expect(r("{{ 'v' if l else 'f' }}{{ 'v' if d else 'f' }}{{ 'v' if not l else 'f' }}", { l: [], d: {} })).toBe("ffv");
  });

  it("selectattr/rejectattr/default usam a verdade do Jinja", () => {
    const xs = [{ n: 1, l: [] }, { n: 2, l: [1] }, { n: 3, l: {} }];
    expect(r("{{ xs|selectattr('l')|map(attribute='n')|join(',') }}", { xs })).toBe("2");
    expect(r("{{ xs|rejectattr('l')|map(attribute='n')|join(',') }}", { xs })).toBe("1,3");
    expect(r("{{ v|default('alt', true) }}|{{ w|default('alt') }}|{{ n|default('alt') }}", { v: [], n: null })).toBe("alt|alt|");
  });

  it("dicionário impresso sai como o str(dict) do Python, e não [object Object]", () => {
    const v = { estado: "RECUSADO", complemento: null, ok: true, n: 2, l: ["a"] };
    expect(r("{{ v }}", { v })).toBe("{&#39;estado&#39;: &#39;RECUSADO&#39;, &#39;complemento&#39;: None, &#39;ok&#39;: True, &#39;n&#39;: 2, &#39;l&#39;: [&#39;a&#39;]}");
    expect(r("{{ l }}|{{ d }}", { l: [1, 2], d: new Date(0) })).toBe(`1,2|${String(new Date(0))}`);
  });

  it("o carregador converte tupla em lista", () => {
    expect(adaptarJinja("{% if a in ('A', 'B') %}")).toBe("{% if a in ['A', 'B'] %}");
  });
});
