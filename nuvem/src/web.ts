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
import { COLUNAS_KANBAN } from "./dominio/estados.js";
import * as datas_br from "./servicos/datas_br.js";
import { rotulo_evento } from "./servicos/auditoria.js";
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

export const ambiente = new nunjucks.Environment(
  new nunjucks.FileSystemLoader(pastaDeTemplates(), { noCache: process.env.NODE_ENV === "development" }),
  { autoescape: true, throwOnUndefined: false, trimBlocks: false, lstripBlocks: false },
);

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
    if (teste === undefined) return Boolean(v);
    if (teste === "equalto" || teste === "eq" || teste === "==") return v === valor;
    if (teste === "ne" || teste === "!=") return v !== valor;
    if (teste === "none") return v === null || v === undefined;
    return Boolean(v);
  }),
);
ambiente.addFilter("rejectattr", (lista: any[], attr: string, teste?: string, valor?: unknown) =>
  (lista ?? []).filter((x) => {
    const v = x?.[attr];
    if (teste === undefined) return !v;
    if (teste === "equalto" || teste === "eq" || teste === "==") return v !== valor;
    if (teste === "none") return !(v === null || v === undefined);
    return !v;
  }),
);
ambiente.addFilter("map", (lista: any[], ...args: any[]) => {
  // Jinja: map(attribute='x') -> o Nunjucks passa kwargs como último objeto
  const ultimo = args[args.length - 1];
  const attr = typeof ultimo === "object" && ultimo?.attribute ? ultimo.attribute : args[0];
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
(ambiente as any).addTest("none", (v: unknown) => v === null || v === undefined);
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
