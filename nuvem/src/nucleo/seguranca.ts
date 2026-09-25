/**
 * O que vale para TODA resposta: o `Secure` do cookie e os cabeçalhos.
 * Porte de `app/seguranca.py`.
 *
 * Na nuvem o TLS termina no Netlify, e a requisição chega à função com a URL
 * `https://` de verdade — por isso o `auto` decide pelo esquema da URL, como
 * decidia no Python pelo `request.url.scheme`.
 */
import { randomBytes } from "node:crypto";
import { obterConfig } from "../config.js";

export function cookieSeguro(url: string): boolean {
  const modo = obterConfig().cookieSeguro;
  if (modo === "sim") return true;
  if (modo === "nao") return false;
  return url.startsWith("https:");
}

const CSP =
  "default-src 'self'; " +
  "script-src 'self' 'nonce-{nonce}'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "style-src-elem 'self'; " +
  "img-src 'self' data: blob:; " +
  "font-src 'self'; " +
  "connect-src 'self'; " +
  "form-action 'self'; " +
  "frame-ancestors 'none'; " +
  "base-uri 'none'; " +
  "object-src 'none'";

export function novoNonce(): string {
  return randomBytes(16).toString("base64url");
}

export function cabecalhos(nonce: string, https: boolean): [string, string][] {
  const fixos: [string, string][] = [
    ["content-security-policy", CSP.replace("{nonce}", nonce)],
    ["x-content-type-options", "nosniff"],
    ["referrer-policy", "same-origin"],
    ["x-frame-options", "DENY"],
  ];
  if (https) fixos.push(["strict-transport-security", "max-age=31536000"]);
  return fixos;
}

// ---------------------------------------------------------------------
// CSRF: origem cruzada em método que escreve
// ---------------------------------------------------------------------

/** Métodos que não escrevem: não passam pela conferência de origem. */
const METODOS_SEGUROS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * `true` quando um método que escreve (POST, PUT, PATCH, DELETE) veio de OUTRA
 * origem — o pedido forjado de CSRF.
 *
 * Por que além do `SameSite=Lax`: (1) o Lax é por SITE, não por origem — num
 * domínio próprio (`csso.ufvjm.edu.br`), qualquer outro `*.ufvjm.edu.br` é o
 * mesmo site e mandaria o cookie num POST forjado; (2) navegador velho sem
 * SameSite manda o cookie sempre. Os navegadores atuais mandam `Sec-Fetch-Site`
 * e `Origin` em todo POST; quem manda um deles e não é a própria origem é
 * recusado. Sem nenhum dos dois (curl, script, cliente de teste) a requisição
 * passa: não é navegador, e sem navegador não há cookie de vítima a abusar.
 * `Sec-Fetch-Site: same-site` é RECUSADO de propósito (é o subdomínio irmão).
 */
export function origemCruzada(metodo: string, url: string, cabecalho: (nome: string) => string | undefined): boolean {
  if (METODOS_SEGUROS.has(metodo.toUpperCase())) return false;
  const alvo = new URL(url);
  const site = cabecalho("sec-fetch-site");
  if (site) return site !== "same-origin" && site !== "none";
  const origem = cabecalho("origin");
  if (origem) {
    if (origem === "null") return true;
    try {
      return new URL(origem).host !== alvo.host;
    } catch {
      return true;
    }
  }
  const referer = cabecalho("referer");
  if (referer) {
    try {
      return new URL(referer).host !== alvo.host;
    } catch {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------
// O que o log do Netlify pode receber de um erro não tratado
// ---------------------------------------------------------------------

/**
 * Uma linha sobre o erro SEM os dados: o `DrizzleQueryError` traz no texto os
 * `params` da consulta (nome, SIAPE, e-mail de quem estava sendo gravado) e o
 * erro do Postgres traz em `detail` a chave que colidiu ("Key (email)=(...)").
 * Fica o tipo, a consulta com os `$1` no lugar dos valores, o código do
 * Postgres, a restrição e a pilha — o suficiente para achar a linha do código.
 */
export function resumoDoErro(erro: unknown): string {
  if (!(erro instanceof Error)) return `erro nao-Error: ${typeof erro}`;
  const sem_params = (texto: string) => texto.split(/\nparams:/)[0]!.slice(0, 2000);
  const partes = [`${erro.name}: ${sem_params(erro.message)}`];
  const causa = (erro as { cause?: unknown }).cause as
    | { name?: string; code?: string; constraint_name?: string; table_name?: string; routine?: string }
    | undefined;
  if (causa && typeof causa === "object") {
    const campos = [causa.name, causa.code && `code=${causa.code}`, causa.table_name && `tabela=${causa.table_name}`,
      causa.constraint_name && `restricao=${causa.constraint_name}`, causa.routine && `rotina=${causa.routine}`];
    partes.push(`causa: ${campos.filter(Boolean).join(" ")}`);
  }
  const pilha = (erro.stack ?? "").split("\n").filter((l) => l.trimStart().startsWith("at ")).slice(0, 8);
  return [...partes, ...pilha].join("\n");
}
