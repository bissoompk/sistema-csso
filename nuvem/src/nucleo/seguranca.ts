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
