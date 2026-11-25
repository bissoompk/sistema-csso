/**
 * O recado depois de um redirecionamento ("Lote registrado.", "Escolha o lote.") viaja num cookie
 * ASSINADO e de uso único, e não mais no endereço (24/11/2026).
 *
 * Por quê: com `?mensagem=`/`?erro=` na URL, qualquer um montava um link do sistema com o texto que
 * quisesse ("Sua senha expirou, ligue para…") e a tela o mostrava na faixa oficial. Além disso o
 * texto ficava no histórico do navegador e nos registros de acesso.
 *
 * Como, sem tocar nas ~90 rotas que já redirecionam com `comMensagem(...)`:
 * - na SAÍDA, um redirecionamento cujo destino traz `mensagem`/`erro` tem esses parâmetros tirados
 *   do `Location` e guardados no cookie, amarrado ao caminho do destino;
 * - na CHEGADA (GET/HEAD), `mensagem`/`erro` digitados no endereço são descartados, e os do cookie
 *   (assinatura conferida, caminho igual) voltam para a query — as rotas leem `c.req.query("erro")`
 *   como sempre. O cookie é apagado ao ser usado.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { obterConfig } from "../config.js";

export const COOKIE_RECADO = "csso_recado";
// "alerta" (lote 5, EPI 3): o aviso que não bloqueia, ao lado do "gravado" — sai em amarelo
export const CHAVES_RECADO = ["mensagem", "erro", "alerta"] as const;
/** o recado espera a próxima tela, não a próxima semana */
const VIDA_SEGUNDOS = 120;
/** o cookie inteiro cabe nos ~4 KB do navegador com folga */
const MAXIMO_POR_TEXTO = 1500;

export interface Recado {
  /** o caminho (sem query) da tela que deve mostrar o recado */
  para: string;
  textos: Partial<Record<(typeof CHAVES_RECADO)[number], string>>;
}

function _assinar(corpo: string): string {
  return createHmac("sha256", obterConfig().chaveSecreta).update(`recado:${corpo}`, "utf8").digest("base64url");
}

function _cortar(texto: string): string {
  return texto.length > MAXIMO_POR_TEXTO ? `${texto.slice(0, MAXIMO_POR_TEXTO - 1)}…` : texto;
}

/** `corpo.assinatura`, em base64url — o valor do cookie. */
export function selar(recado: Recado): string {
  const textos: Recado["textos"] = {};
  for (const k of CHAVES_RECADO) if (recado.textos[k]) textos[k] = _cortar(recado.textos[k]!);
  const corpo = Buffer.from(JSON.stringify({ p: recado.para, t: textos }), "utf8").toString("base64url");
  return `${corpo}.${_assinar(corpo)}`;
}

/** O recado do cookie, se a assinatura confere; `null` para qualquer coisa forjada ou quebrada. */
export function abrir(valor: string | null | undefined): Recado | null {
  if (!valor) return null;
  const i = valor.lastIndexOf(".");
  if (i <= 0) return null;
  const corpo = valor.slice(0, i);
  const dada = Buffer.from(valor.slice(i + 1), "utf8");
  const certa = Buffer.from(_assinar(corpo), "utf8");
  if (dada.length !== certa.length || !timingSafeEqual(dada, certa)) return null;
  try {
    const d = JSON.parse(Buffer.from(corpo, "base64url").toString("utf8")) as { p?: unknown; t?: Record<string, unknown> };
    if (typeof d.p !== "string" || !d.t || typeof d.t !== "object") return null;
    const textos: Recado["textos"] = {};
    for (const k of CHAVES_RECADO) if (typeof d.t[k] === "string") textos[k] = d.t[k] as string;
    return { para: d.p, textos };
  } catch {
    return null;
  }
}

function _cookie(nome: string, valor: string, maxAge: number, seguro: boolean): string {
  return `${nome}=${valor}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${seguro ? "; Secure" : ""}`;
}

function _ler_cookie(cabecalho: string | null, nome: string): string | null {
  for (const parte of (cabecalho ?? "").split(";")) {
    const i = parte.indexOf("=");
    if (i > 0 && parte.slice(0, i).trim() === nome) return parte.slice(i + 1).trim();
  }
  return null;
}

/**
 * Chegada: devolve a requisição a usar (a mesma, se nada muda) e se o cookie foi consumido.
 * Só GET/HEAD: é a tela que mostra o recado.
 */
export function na_chegada(req: Request): { req: Request; consumido: boolean } {
  if (req.method !== "GET" && req.method !== "HEAD") return { req, consumido: false };
  const url = new URL(req.url);
  let mudou = false;
  for (const k of CHAVES_RECADO) {
    if (url.searchParams.has(k)) {
      url.searchParams.delete(k);
      mudou = true;
    }
  }
  const recado = abrir(_ler_cookie(req.headers.get("cookie"), COOKIE_RECADO));
  let consumido = false;
  if (recado && recado.para === url.pathname) {
    for (const k of CHAVES_RECADO) if (recado.textos[k]) url.searchParams.set(k, recado.textos[k]!);
    mudou = true;
    consumido = true;
  }
  return { req: mudou ? new Request(url, req) : req, consumido };
}

/**
 * Saída: redirecionamento para o próprio sistema com `mensagem`/`erro` no destino vira destino
 * limpo + cookie. Recado consumido e não reposto é apagado.
 */
export function na_saida(req: Request, res: Response, consumido: boolean): Response {
  const seguro = req.url.startsWith("https:");
  const destino = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
  let novo: string | null = null;
  let location: string | null = null;
  if (destino) {
    const base = new URL(req.url);
    const alvo = new URL(destino, base);
    if (alvo.origin === base.origin && CHAVES_RECADO.some((k) => alvo.searchParams.has(k))) {
      const textos: Recado["textos"] = {};
      for (const k of CHAVES_RECADO) {
        const v = alvo.searchParams.get(k);
        if (v) textos[k] = v;
        alvo.searchParams.delete(k);
      }
      // o Location continua relativo quando veio relativo
      location = /^[a-z]+:\/\//i.test(destino) ? alvo.toString() : alvo.pathname + alvo.search + alvo.hash;
      if (Object.keys(textos).length) novo = selar({ para: alvo.pathname, textos });
    }
  }
  if (location === null && !consumido) return res;
  const headers = new Headers(res.headers);
  if (location !== null) headers.set("location", location);
  if (novo) headers.append("set-cookie", _cookie(COOKIE_RECADO, novo, VIDA_SEGUNDOS, seguro));
  else if (consumido) headers.append("set-cookie", _cookie(COOKIE_RECADO, "", 0, seguro));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
