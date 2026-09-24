/**
 * Infraestrutura de apresentação: Nunjucks, filtros e helpers de template.
 * Porte de `app/web.py`.
 *
 * **Por que Nunjucks.** É o Jinja2 do JavaScript: a mesma sintaxe de bloco,
 * herança, macro, `include` e filtro. Os 64 templates do sistema Python vêm
 * para `templates/` quase como estavam; o que muda está listado em
 * `docs/TEMPLATES.md` (o `.items()` de dicionário, `namespace()`, `|tojson`...).
 *
 * Nunjucks renderiza de forma síncrona: tudo que a tela mostra tem de estar
 * carregado ANTES de `pagina()` — não há consulta preguiçosa dentro do
 * template, como havia com o `lazy="selectin"` do SQLAlchemy. Quem porta uma
 * rota carrega as relações que o template lê (`with:` do Drizzle).
 */
import nunjucks from "nunjucks";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import type { Ctx } from "./nucleo/contexto.js";
import { obterConfig, RODAPE_INSTITUCIONAL, VERSAO } from "./config.js";
import { cookieSeguro } from "./nucleo/seguranca.js";
import { getCookie, setCookie } from "hono/cookie";
import type { UsuarioAtual } from "./servicos/rbac.js";
import { COLUNAS_KANBAN, ROTULO_ESTADO_TELA } from "./dominio/estados.js";
import * as datas_br from "./servicos/datas_br.js";
import * as auditoria from "./servicos/auditoria.js";
import { rotulo_evento } from "./servicos/auditoria.js";
import { eq, getTableColumns, getTableName } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import * as identificacao from "./servicos/identificacao.js";

/**
 * Onde estão os templates. Na função do Netlify o código vira um bundle em
 * outro diretório e os templates vão junto por `included_files`; localmente
 * ficam em `nuvem/templates`. Procura-se nos dois.
 */
function pastaDeTemplates(): string {
  const candidatos = [
    process.env.CSSO_TEMPLATES,
    path.resolve(process.cwd(), "templates"),
    path.resolve(process.cwd(), "nuvem/templates"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../templates"),
  ].filter(Boolean) as string[];
  for (const c of candidatos) if (existsSync(path.join(c, "base.html"))) return c;
  return candidatos[1]!;
}

/**
 * O que o Nunjucks aceita sem reclamar e avalia ERRADO — corrigido na leitura
 * do arquivo, para nenhum template portado cair nisso calado:
 *
 * - `x in ('A', 'B')`: tupla não existe; `('A','B')` vira só `'B'` e o `in`
 *   passa a testar substring. Reescrito para lista `['A', 'B']`.
 */
export function adaptarJinja(fonte: string): string {
  return fonte.replace(/\bin\s*\(((?:\s*(?:'[^']*'|"[^"]*"|-?\d+)\s*,)+\s*(?:'[^']*'|"[^"]*"|-?\d+)?\s*)\)/g, "in [$1]");
}

class CarregadorJinja extends nunjucks.FileSystemLoader {
  override getSource(nome: string) {
    const fonte = super.getSource(nome);
    if (fonte) fonte.src = adaptarJinja(fonte.src);
    return fonte;
  }
}

export const ambiente = new nunjucks.Environment(
  new CarregadorJinja(pastaDeTemplates(), { noCache: process.env.NODE_ENV === "development" }),
  { autoescape: true, throwOnUndefined: false, trimBlocks: false, lstripBlocks: false },
);

// ---------------------------------------------------------------------
// Verdade do Jinja: lista, dicionário e conjunto VAZIOS são falsos.
// ---------------------------------------------------------------------
// O Nunjucks compila `{% if x %}`, `a or b`, `not x` e `x if c` com a verdade
// do JavaScript, em que `[]` e `{}` são verdadeiros. Os templates vieram do
// Jinja e contam com `{% if pendencias %}` ser falso para lista vazia — sem
// isto, "Nada pendente" nunca aparecia e a lista vazia desenhava a tabela.
// Aqui a condição passa por `runtime.verdade`, que só muda o caso vazio:
// array/Map/Set sem item e objeto SIMPLES sem chave (o `dicionario()` de
// `src/dicionario.ts` incluído). `Date`, instância de classe e o resto seguem
// a verdade de sempre. `a or b`/`a and b` devolvem o operando, como no Jinja.
function verdade(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map || v instanceof Set) return v.size > 0;
  if (v && typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto === Object.prototype || proto === null) return Object.keys(v).length > 0;
    if (v instanceof nunjucks.runtime.SafeString) return String(v).length > 0;
  }
  return Boolean(v);
}
(nunjucks.runtime as any).verdade = verdade;
{
  const C = (nunjucks as any).compiler.Compiler.prototype;
  const nos = (nunjucks as any).nodes;
  const embrulhar = (cond: any) => {
    const n = Object.create(nos.Group.prototype);
    Object.assign(n, { lineno: cond.lineno, colno: cond.colno, alvo: cond });
    Object.defineProperty(n, "typename", { value: "Verdade" });
    return n;
  };
  C.compileVerdade = function (this: any, node: any, frame: any) {
    this._emit("runtime.verdade(");
    this.compile(node.alvo, frame);
    this._emit(")");
  };
  const compileIf = C.compileIf;
  C.compileIf = function (this: any, node: any, frame: any, async: boolean) {
    return compileIf.call(this, { body: node.body, else_: node.else_, cond: embrulhar(node.cond) }, frame, async);
  };
  const compileInlineIf = C.compileInlineIf;
  C.compileInlineIf = function (this: any, node: any, frame: any) {
    return compileInlineIf.call(this, { body: node.body, else_: node.else_, cond: embrulhar(node.cond) }, frame);
  };
  C.compileNot = function (this: any, node: any, frame: any) {
    this._emit("!runtime.verdade(");
    this.compile(node.target, frame);
    this._emit(")");
  };
  const logico = (e: boolean) =>
    function (this: any, node: any, frame: any) {
      this._emit("(function(__a){return runtime.verdade(__a)?");
      if (e) this._emit("(");
      else this._emit("__a:(");
      this.compile(node.right, frame);
      this._emit(e ? "):__a})(" : ")})(");
      this.compile(node.left, frame);
      this._emit(")");
    };
  C.compileAnd = logico(true);
  C.compileOr = logico(false);
}

// ---------------------------------------------------------------------
// Métodos de `dict` e `str` do Python chamados dentro do template.
// ---------------------------------------------------------------------
// `d.get(k, padrao)`, `d.items()`, `d.values()|sum`, `d.keys()`: os templates
// vieram do Jinja e chamam os métodos do dicionário. A rota que lembra de
// embrulhar com `dicionario()` (`src/dicionario.ts`) funciona; a que esquece
// dava 500 ("Unable to call `d["get"]`, which is undefined") só na tela, e só
// no ramo que lê. Aqui o `memberLookup` do Nunjucks — por onde passa todo
// `x.y` do template — supre o método de dict para objeto SIMPLES e `Map` que
// não tenham o membro, e `upper/lower/strip/startswith/endswith` para texto.
// Chave de verdade com esses nomes continua valendo (só entra se faltar).
{
  const R = nunjucks.runtime as any;
  const original = R.memberLookup;
  const simples = (o: unknown): o is Record<string, unknown> => {
    if (!o || typeof o !== "object") return false;
    const proto = Object.getPrototypeOf(o);
    return proto === Object.prototype || proto === null;
  };
  const DE_DICT: Record<string, (o: any) => (...a: any[]) => unknown> = {
    get: (o) => (k: unknown, padrao: unknown = null) =>
      o instanceof Map ? (o.has(k) ? o.get(k) : padrao) : Object.hasOwn(o, String(k)) ? o[String(k)] : padrao,
    items: (o) => () => (o instanceof Map ? [...o.entries()] : Object.entries(o)),
    keys: (o) => () => (o instanceof Map ? [...o.keys()] : Object.keys(o)),
    values: (o) => () => (o instanceof Map ? [...o.values()] : Object.values(o)),
  };
  const DE_STR: Record<string, (s: string) => (...a: any[]) => unknown> = {
    upper: (s) => () => s.toUpperCase(),
    lower: (s) => () => s.toLowerCase(),
    strip: (s) => () => s.trim(),
    startswith: (s) => (p: string) => s.startsWith(p),
    endswith: (s) => (p: string) => s.endsWith(p),
  };
  R.memberLookup = function (obj: any, val: any) {
    if (typeof val === "string") {
      if (obj instanceof Map && (val === "items" || val === "keys" || val === "values")) return DE_DICT[val]!(obj);
      if (simples(obj) && obj[val] === undefined && Object.hasOwn(DE_DICT, val)) return DE_DICT[val]!(obj);
      if (typeof obj === "string" && Object.hasOwn(DE_STR, val)) return DE_STR[val]!(obj);
    }
    return original(obj, val);
  };
}

// ---------------------------------------------------------------------
// `{{ dicionario }}` sai como o Jinja o escrevia (`str(dict)`), e não
// "[object Object]". Acontece com valor jsonb da trilha (`valor_novo` de
// EPI_ITEM_RECUSADO é um objeto) na tela de auditoria. Só objeto SIMPLES:
// lista continua saindo como o Nunjucks a escreve.
// ---------------------------------------------------------------------
export function reprPython(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "string") return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  if (Array.isArray(v)) return `[${v.map(reprPython).join(", ")}]`;
  if (typeof v === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(v))) {
    return `{${Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${reprPython(k)}: ${reprPython(x)}`)
      .join(", ")}}`;
  }
  return String(v);
}
{
  const R = nunjucks.runtime as any;
  const original = R.suppressValue;
  R.suppressValue = function (val: unknown, autoescape: boolean) {
    if (val && typeof val === "object" && !Array.isArray(val) && [Object.prototype, null].includes(Object.getPrototypeOf(val))) {
      val = reprPython(val);
    }
    return original(val, autoescape);
  };
}

// ---------------------------------------------------------------------
// Compatibilidade Jinja -> Nunjucks: filtros que o Jinja tem e o Nunjucks não
// ---------------------------------------------------------------------
ambiente.addFilter("tojson", (v: unknown) =>
  new nunjucks.runtime.SafeString(
    JSON.stringify(v ?? null)
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e")
      .replace(/&/g, "\\u0026")
      .replace(/'/g, "\\u0027"),
  ),
);
ambiente.addFilter("items", (obj: Record<string, unknown> | Map<unknown, unknown> | null) => {
  if (!obj) return [];
  if (obj instanceof Map) return [...obj.entries()];
  return Object.entries(obj);
});
ambiente.addFilter("selectattr", (lista: any[], attr: string, teste?: string, valor?: unknown) =>
  (lista ?? []).filter((x) => {
    const v = x?.[attr];
    if (teste === undefined) return verdade(v);
    if (teste === "equalto" || teste === "eq" || teste === "==") return v === valor;
    if (teste === "ne" || teste === "!=") return v !== valor;
    if (teste === "none") return v === null || v === undefined;
    if (teste === "in") return Array.isArray(valor) ? valor.includes(v) : false;
    return verdade(v);
  }),
);
ambiente.addFilter("rejectattr", (lista: any[], attr: string, teste?: string, valor?: unknown) =>
  (lista ?? []).filter((x) => {
    const v = x?.[attr];
    if (teste === undefined) return !verdade(v);
    if (teste === "equalto" || teste === "eq" || teste === "==") return v !== valor;
    if (teste === "none") return !(v === null || v === undefined);
    if (teste === "in") return Array.isArray(valor) ? !valor.includes(v) : true;
    return !verdade(v);
  }),
);
// `default(x, padrao, true)`: com o terceiro argumento, o Jinja troca todo valor
// FALSO pela alternativa — e lista/dict vazios são falsos (o Nunjucks usava `||`).
const padrao = (v: unknown, alternativa: unknown = "", booleano = false) =>
  booleano ? (verdade(v) ? v : alternativa) : v !== undefined ? v : alternativa;
ambiente.addFilter("default", padrao);
ambiente.addFilter("d", padrao);
ambiente.addFilter("map", (lista: any[], ...args: any[]) => {
  // Jinja: map(attribute='x') -> o Nunjucks passa kwargs como último objeto
  const ultimo = args[args.length - 1];
  const attr =
    typeof ultimo === "object" && ultimo !== null && "attribute" in ultimo ? ultimo.attribute : args[0];
  return (lista ?? []).map((x) => x?.[attr]);
});
ambiente.addFilter("max", (lista: number[]) => (lista?.length ? Math.max(...lista) : undefined));
ambiente.addFilter("min", (lista: number[]) => (lista?.length ? Math.min(...lista) : undefined));
ambiente.addFilter("unique", (lista: unknown[]) => [...new Set(lista ?? [])]);
ambiente.addFilter("format", (fmt: string, ...args: unknown[]) => {
  let i = 0;
  return String(fmt).replace(/%(\.(\d+))?([sdif%])/g, (_m, _p, prec, tipo) => {
    if (tipo === "%") return "%";
    const v = args[i++];
    if (tipo === "d" || tipo === "i") return String(Math.trunc(Number(v)));
    if (tipo === "f") return Number(v).toFixed(prec ? Number(prec) : 6);
    return String(v);
  });
});

// testes do Jinja que o Nunjucks não traz
(ambiente as any).addTest("true", (v: unknown) => v === true);
(ambiente as any).addTest("false", (v: unknown) => v === false);
(ambiente as any).addTest("none", (v: unknown) => v === null || v === undefined);
// O parser do Nunjucks lê `none` como o literal null, e `x is none` vira o teste
// embutido `null` (=== null): o `none` acima nunca era chamado, e o atributo
// ausente (undefined, onde o Python tinha None de `dict.get`) passava por
// `is not none`. Mesma regra, sob o nome que o parser de fato procura.
(ambiente as any).addTest("null", (v: unknown) => v === null || v === undefined);
(ambiente as any).addTest("sameas", (v: unknown, outro: unknown) => v === outro);
(ambiente as any).addTest("in", (v: unknown, col: unknown) =>
  Array.isArray(col) ? col.includes(v) : typeof col === "string" ? col.includes(String(v)) : col instanceof Set ? col.has(v) : false,
);
(ambiente as any).addTest("boolean", (v: unknown) => typeof v === "boolean");
(ambiente as any).addTest("sequence", (v: unknown) => Array.isArray(v) || typeof v === "string");

/** Registra um filtro. Os serviços que fornecem filtros chamam isto no carregamento. */
export function filtro(nome: string, f: (...args: any[]) => unknown): void {
  ambiente.addFilter(nome, f);
}
/** Registra um global de template. */
export function global(nome: string, v: unknown): void {
  ambiente.addGlobal(nome, v);
}

global("VERSAO", VERSAO);
global("RODAPE", RODAPE_INSTITUCIONAL);
global("range", (a: number, b?: number, passo = 1) => {
  const [ini, fim] = b === undefined ? [0, a] : [a, b];
  const r: number[] = [];
  for (let i = ini; passo > 0 ? i < fim : i > fim; i += passo) r.push(i);
  return r;
});

// O quadro do kanban é constante de apresentação, não contexto de tela.
global("COLUNAS_KANBAN", COLUNAS_KANBAN);
// O rótulo de TELA do estado do processo (o `filters["estado"]` do web.py).
filtro("estado", (e: string | null | undefined) =>
  e && Object.hasOwn(ROTULO_ESTADO_TELA, e) ? ROTULO_ESTADO_TELA[e] : (e ?? ""),
);
// `(fim - inicio).days` do Jinja sobre duas `date`: aqui as datas são texto
// 'AAAA-MM-DD' (RN-18), e a subtração vira esta função (`partes/macros.html`).
global("dias_entre", (inicio: string | null, fim: string | null): number | null => {
  if (!inicio || !fim) return null;
  const dia = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((dia(String(fim)) - dia(String(inicio))) / 86_400_000);
});
// ---------------------------------------------------------------------
// Datas, evento e RN-19 (porte do núcleo B)
// ---------------------------------------------------------------------
// `date` chega como 'AAAA-MM-DD' e é formatada sem passar por fuso (RN-18);
// `timestamptz` chega como `Date` e é exibido em America/Sao_Paulo.
filtro("data", (d: unknown) => {
  const dia = datas_br.comoData(d);
  return dia ? datas_br.numerica(dia) : "";
});
filtro("data_extenso", (d: unknown) => {
  const dia = datas_br.comoData(d);
  return dia ? datas_br.por_extenso(dia) : "";
});
filtro("momento", (m: Date | string | null | undefined) => datas_br.local_formatado(m ?? null));
// O tipo de evento é chave de banco; o rótulo mora em `auditoria.ROTULO_EVENTO`.
filtro("evento", (codigo: string | null | undefined) => rotulo_evento(codigo));

/** Os kwargs do Nunjucks chegam como último argumento, marcado `__keywords`. */
function separarKwargs(args: unknown[]): [unknown[], Record<string, unknown>] {
  const ultimo = args[args.length - 1] as Record<string, unknown> | undefined;
  if (ultimo && typeof ultimo === "object" && (ultimo as { __keywords?: boolean }).__keywords) {
    const { __keywords: _k, ...kw } = ultimo;
    return [args.slice(0, -1), kw];
  }
  return [args, {}];
}

/**
 * RN-19 no template sem a tela carregar nada: `usuario` e `request` já estão
 * no contexto de toda página e fragmento (Nunjucks chama global com
 * `this.ctx` = contexto). Sem `usuario`, o lado seguro — código opaco.
 */
global("identificar", function (this: { ctx: Record<string, any> }, ...args: unknown[]) {
  const [pos, kw] = separarKwargs(args);
  const vazio = (kw.vazio ?? pos[1] ?? identificacao.SEM_SERVIDOR) as string;
  return identificacao.identificar(
    pos[0] as identificacao.AlvoIdentificavel,
    this.ctx?.usuario ?? null,
    identificacao.semente_de(this.ctx?.request),
    { vazio },
  );
});

/** A irmã de `identificar` para a frase que o sistema gravou (trilha, pendência). */
global("texto_livre", function (this: { ctx: Record<string, any> }, ...args: unknown[]) {
  const [pos, kw] = separarKwargs(args);
  return identificacao.texto_livre(pos[0] as string | null, this.ctx?.usuario ?? null, {
    sobre: (kw.sobre ?? pos[1]) as identificacao.AlvoIdentificavel,
    vazio: (kw.vazio ?? pos[2] ?? identificacao.SEM_SERVIDOR) as string,
  });
});

// Os outros globais que o `web.py` registrava moram no módulo dono deles, que os
// registra ao ser carregado — `web.ts` não os importa para não fechar ciclo de
// importação (esses módulos dependem de `web.ts`, ou dependem de quem depende):
//   - `porta_de_entrada` ............ `src/modulos.ts`
//   - `POLITICA_SENHA` .............. `src/servicos/autenticacao.ts`

/**
 * O `request` que os templates enxergam. Só o que eles de fato leem:
 * caminho, query e cookies — com a mesma forma do Starlette
 * (`request.url.path`, `request.query_params.get('x')`).
 */
export function requestParaTemplate(c: Ctx) {
  const url = new URL(c.req.url);
  return {
    url: { path: url.pathname, query: url.search.replace(/^\?/, ""), scheme: url.protocol.replace(":", "") },
    method: c.req.method,
    path: url.pathname,
    query_params: {
      get: (k: string, padrao: string | null = null) => url.searchParams.get(k) ?? padrao,
      getlist: (k: string) => url.searchParams.getAll(k),
    },
    cookies: { get: (k: string) => getCookie(c, k) ?? null },
    headers: { get: (k: string) => c.req.header(k) ?? null },
  };
}

// ---------------------------------------------------------------------
// Ganchos preenchidos pelos serviços do núcleo quando forem carregados.
// Ficam aqui como pontos de extensão para que `web.ts` não dependa do módulo
// de pendências, busca e navegação (que dependem de `web.ts` de volta).
// ---------------------------------------------------------------------
export interface GanchosDaCasca {
  sino?: (c: Ctx, usuario: UsuarioAtual) => Promise<[number, number]>;
  podeVerPendencias?: (usuario: UsuarioAtual | null) => boolean;
  podeBuscar?: (usuario: UsuarioAtual | null) => boolean;
  navegacao?: (
    caminho: string,
    usuario: UsuarioAtual | null,
    origem: string | null,
  ) => Record<string, unknown> & { modulo_a_lembrar?: string | null };
  cookieModulo?: string;
}
export const ganchos: GanchosDaCasca = {};

export function renderizar(template: string, dados: Record<string, unknown>): string {
  return ambiente.render(template, dados);
}

/**
 * A tela inteira, com a casca (lateral, sino, busca). O `web.pagina` do Python.
 */
export async function pagina(
  c: Ctx,
  template: string,
  usuario: UsuarioAtual | null = null,
  contexto: Record<string, unknown> = {},
  status = 200,
): Promise<Response> {
  const cfg = obterConfig();
  const sinoVisivel = ganchos.podeVerPendencias?.(usuario) ?? false;
  let abertas = 0;
  let atrasadas = 0;
  if (sinoVisivel && usuario && ganchos.sino) {
    try {
      [abertas, atrasadas] = await ganchos.sino(c, usuario);
    } catch {
      // o sino nunca derruba a tela que ele decora
    }
  }
  const cookieModulo = ganchos.cookieModulo ?? "csso_modulo";
  const origem = getCookie(c, cookieModulo) ?? null;
  const url = new URL(c.req.url);
  const navegacao = ganchos.navegacao?.(url.pathname, usuario, origem) ?? {};
  const dados: Record<string, unknown> = {
    request: requestParaTemplate(c),
    usuario,
    avisos_config: cfg.inseguro,
    ambiente: cfg.ambiente,
    sino_visivel: sinoVisivel,
    sino_abertas: abertas,
    sino_atrasadas: atrasadas,
    busca_visivel: ganchos.podeBuscar?.(usuario) ?? false,
    nonce: () => c.get("nonce") ?? "",
    ...navegacao,
    ...contexto,
  };
  const lembrar = navegacao.modulo_a_lembrar as string | null | undefined;
  if (lembrar && lembrar !== origem) {
    setCookie(c, cookieModulo, lembrar, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: cfg.sessaoHoras * 3600,
      secure: cookieSeguro(c.req.url),
    });
  }
  return c.html(renderizar(template, dados), status as any);
}

/** Um pedaço de tela (resposta de HTMX), sem casca. */
export function fragmento(c: Ctx, template: string, contexto: Record<string, unknown> = {}, status = 200): Response {
  return c.html(
    renderizar(template, { request: requestParaTemplate(c), nonce: () => c.get("nonce") ?? "", ...contexto }),
    status as any,
  );
}

/** O `RedirectResponse(..., 303)`. */
export function redirecionar(c: Ctx, destino: string, status: 301 | 302 | 303 | 307 = 303): Response {
  return c.redirect(destino, status);
}

/**
 * Devolve ao navegador a marca que a página mandou junto com o pedido de
 * download (`?baixar=<token>`), para o `csso.js` religar o botão.
 */
export function marcarDownload(c: Ctx): void {
  const token = c.req.query("baixar") ?? "";
  if (token && /^[A-Za-z0-9]{1,64}$/.test(token)) {
    setCookie(c, "csso_baixou", token, {
      maxAge: 60,
      path: "/",
      httpOnly: false,
      sameSite: "Lax",
      secure: cookieSeguro(c.req.url),
    });
  }
}

// =====================================================================
// Paginação de lista
// =====================================================================
export const POR_PAGINA = 50;

export interface Recorte<T> {
  itens: T[];
  pagina: number;
  por_pagina: number;
  total: number;
}

export function aparar(pagina: number | undefined, total: number, porPagina: number): number {
  const ultima = Math.max(1, Math.ceil(total / porPagina));
  return Math.min(Math.max(Math.trunc(pagina || 1), 1), ultima);
}

/** Recorta uma lista JÁ MATERIALIZADA (o filtro não coube na consulta). */
export function recortar<T>(itens: T[], pagina = 1, porPagina = POR_PAGINA): Recorte<T> {
  const total = itens.length;
  const p = aparar(pagina, total, porPagina);
  const inicio = (p - 1) * porPagina;
  return { itens: itens.slice(inicio, inicio + porPagina), pagina: p, por_pagina: porPagina, total };
}

/**
 * Recorta no BANCO: quem chama passa a contagem e uma função que busca a
 * página pedida com LIMIT/OFFSET.
 */
export async function recortarConsulta<T>(
  contar: () => Promise<number>,
  buscar: (limite: number, deslocamento: number) => Promise<T[]>,
  pagina = 1,
  porPagina = POR_PAGINA,
): Promise<Recorte<T>> {
  const total = await contar();
  const p = aparar(pagina, total, porPagina);
  const itens = await buscar(porPagina, (p - 1) * porPagina);
  return { itens, pagina: p, por_pagina: porPagina, total };
}

/** O `?pagina=` da URL, ou 1. */
export function numeroDaPagina(c: Ctx): number {
  const bruto = c.req.query("pagina") ?? "";
  return /^\d+$/.test(bruto) ? Number(bruto) : 1;
}

/** Monta `destino?mensagem=...` codificado, o `_aviso` das rotas Python. */
export function comMensagem(destino: string, mensagem: string, chave = "mensagem"): string {
  const sep = destino.includes("?") ? "&" : "?";
  return `${destino}${sep}${chave}=${encodeURIComponent(mensagem)}`;
}

// =====================================================================
// Edição de catálogo
// =====================================================================
/** `Decimal('8.0') == Decimal('8')`: os dois textos são o mesmo número? */
function mesmoDecimal(a: string, b: string): boolean {
  const norm = (v: string) => {
    const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(v.trim());
    if (!m || (!m[2] && !m[3])) return null;
    const inteira = (m[2] || "0").replace(/^0+(?=\d)/, "");
    const frac = (m[3] ?? "").replace(/0+$/, "");
    const corpo = frac ? `${inteira}.${frac}` : inteira;
    return corpo === "0" ? "0" : `${m[1] === "-" ? "-" : ""}${corpo}`;
  };
  const x = norm(a);
  return x !== null && x === norm(b);
}

/**
 * Edição de catálogo: exige a permissão, grava e audita campo a campo. O
 * `web.salvar_com_diff` do Python.
 *
 * Vive aqui, e não em cada arquivo de rota, porque a regra é a mesma em todo
 * catálogo do sistema — o que muda de um para outro é só a permissão exigida.
 * Duplicar isto foi como o menu passou a mentir na 1.6.0 (e o porte tinha três
 * cópias: base, EPI e treinamentos).
 *
 * A entidade da trilha é o nome da tabela (`modelo.__tablename__`). Coluna
 * `numeric` chega como texto: '8.0' → '8' é o mesmo número e não vira
 * diferença (no Python o `Decimal` comparava igual).
 */
export async function salvar_com_diff(
  c: Ctx,
  usuario: UsuarioAtual,
  tabela: PgTable,
  registro_id: number,
  campos: Record<string, unknown>,
  d: { permissao: string; rotulo: string; volta: string },
): Promise<Response> {
  usuario.exigir(d.permissao);
  const tx = c.get("tx");
  const colunas = getTableColumns(tabela) as Record<string, PgColumn>;
  const coluna_id = colunas["id"]!;
  const [registro] = (await tx.select().from(tabela).where(eq(coluna_id, registro_id))) as Record<string, unknown>[];
  if (!registro) return redirecionar(c, d.volta);
  const antes: Record<string, unknown> = {};
  const depois: Record<string, unknown> = {};
  for (const [campo, valor] of Object.entries(campos)) {
    const a = registro[campo] ?? null;
    antes[campo] = a;
    depois[campo] =
      colunas[campo]?.columnType === "PgNumeric" && typeof a === "string" && typeof valor === "string" && mesmoDecimal(a, valor)
        ? a
        : valor;
  }
  await tx.update(tabela).set(campos as never).where(eq(coluna_id, registro_id));
  await auditoria.registrar_diferencas(tx, {
    entidade: getTableName(tabela),
    entidade_id: registro_id,
    antes,
    depois,
    usuario,
  });
  // codificado: `rotulo` chega ao `Location` dentro da mensagem
  return redirecionar(c, comMensagem(d.volta, `${d.rotulo} atualizado.`));
}
