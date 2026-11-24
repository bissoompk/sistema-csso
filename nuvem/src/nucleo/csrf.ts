/**
 * Token CSRF por sessão (Parte 4, 24/11/2026), em cima do que já havia: cookie de sessão
 * `SameSite=Lax`/`HttpOnly` e a conferência de origem (`origemCruzada`). A conferência de origem
 * deixa passar o pedido que chega SEM `Sec-Fetch-Site`, `Origin` e `Referer` (navegador antigo,
 * proxy que os retira); o token fecha esse buraco.
 *
 * - O token é o HMAC do valor do cookie de sessão com a chave secreta: nada a guardar no banco, e
 *   muda a cada login.
 * - Toda resposta HTML de quem tem sessão recebe o token: um campo oculto `_csrf` em cada
 *   `<form method="post">` e o cabeçalho `x-csrf-token` no `hx-headers` do `<body>` (htmx) e na
 *   `<meta name="csrf-token">` (fetch do JavaScript). Os templates não precisam saber dele.
 * - Todo pedido que escreve, com sessão e com corpo de tipo "simples" (formulário, multipart,
 *   texto ou sem corpo) — os únicos que outro site consegue disparar sem pré-checagem do navegador
 *   — tem de trazer o token. JSON (a API, o celular, o app) passa pela pré-checagem de CORS, que o
 *   sistema não libera, e fica fora.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { obterConfig } from "../config.js";

export const CAMPO_CSRF = "_csrf";
export const CABECALHO_CSRF = "x-csrf-token";

export function token_da_sessao(valor_cookie: string): string {
  return createHmac("sha256", obterConfig().chaveSecreta).update(`csrf:${valor_cookie}`, "utf8").digest("base64url");
}

export function confere(valor_cookie: string, enviado: string | null | undefined): boolean {
  if (!enviado) return false;
  const a = Buffer.from(enviado, "utf8");
  const b = Buffer.from(token_da_sessao(valor_cookie), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

const METODOS_QUE_ESCREVEM = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** O pedido precisa do token? (método que escreve + corpo que outro site consegue forjar) */
export function exige_token(metodo: string, content_type: string | null | undefined): boolean {
  if (!METODOS_QUE_ESCREVEM.has(metodo.toUpperCase())) return false;
  const tipo = (content_type ?? "").split(";")[0]!.trim().toLowerCase();
  return tipo === "" || tipo === "application/x-www-form-urlencoded" || tipo === "multipart/form-data" || tipo === "text/plain";
}

function _escapar_atributo(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;");
}

/** Põe o token no HTML: campo oculto nos formulários POST, `hx-headers` no body e a meta. */
export function injetar(html: string, token: string): string {
  const t = _escapar_atributo(token);
  const campo = `<input type="hidden" name="${CAMPO_CSRF}" value="${t}">`;
  let saida = html.replace(/<form\b[^>]*>/gi, (tag) => (/\bmethod\s*=\s*["']?post\b/i.test(tag) ? `${tag}${campo}` : tag));
  saida = saida.replace(/<body\b([^>]*)>/i, (tag, attrs: string) =>
    /\bhx-headers\s*=/.test(attrs) ? tag : `<body${attrs} hx-headers='{"${CABECALHO_CSRF}": "${t}"}'>`,
  );
  saida = saida.replace(/<\/head>/i, `<meta name="csrf-token" content="${t}"></head>`);
  return saida;
}
