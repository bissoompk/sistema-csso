/**
 * `/app` — o front compilado (fase 3), servido pelo próprio sistema.
 * Porte de `app/rotas/aplicativo.py`.
 *
 * **O que é.** O `index.html` que o Vite gera em `public/estaticos/app/` a
 * partir de `frontend/`. Os assets (JS, CSS) saem do CDN do Netlify em
 * `/estaticos/app/assets/…`; o que esta rota faz é servir SÓ a página de
 * entrada — e exigir sessão para isso. O bundle em si é público, como todo
 * estático; é a página que abre a porta, e ela não abre sem o cookie do `/login`.
 *
 * **De onde o arquivo é lido.** Na nuvem, `public/` é publicado no CDN e NÃO
 * está no disco da função: o `index.html` (e o `sw.js` da tela de bolso) vão
 * para o bundle da função por `included_files` no `netlify.toml`, como os
 * templates. A procura segue o `pastaDeTemplates` de `web.ts`: variável de
 * ambiente, pasta corrente, `nuvem/` da raiz e o caminho relativo ao módulo.
 *
 * **Sem o bundle construído** a rota não finge: responde dizendo que o front
 * não foi montado e como montá-lo.
 */
import { Hono } from "hono";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { usuarioLogado } from "../dependencias.js";

export const rotas = new Hono<Ambiente>();

/**
 * A pasta `public/estaticos`. Procura-se nos mesmos lugares que os templates;
 * vence a primeira que tem `js/sw.js` — e não um arquivo qualquer: no bundle da
 * função só existem os dois que `included_files` leva (`sw.js` e o `index.html`).
 */
export function pastaDeEstaticos(): string {
  const candidatos = [
    process.env.CSSO_ESTATICOS,
    path.resolve(process.cwd(), "public/estaticos"),
    path.resolve(process.cwd(), "nuvem/public/estaticos"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public/estaticos"),
  ].filter(Boolean) as string[];
  for (const c of candidatos) if (existsSync(path.join(c, "js", "sw.js"))) return c;
  return candidatos[1]!;
}

let _entrada: string | null = null;

/** O `index.html` do bundle. */
export function entrada(): string {
  return _entrada ?? path.join(pastaDeEstaticos(), "app", "index.html");
}

/** Só para teste: aponta a entrada para outro arquivo (`null` volta ao padrão). */
export function _definir_entrada(caminho: string | null): void {
  _entrada = caminho;
}

export function bundle_construido(): boolean {
  return existsSync(entrada());
}

const SEM_BUNDLE =
  "<!doctype html><html lang='pt-BR'><meta charset='utf-8'>" +
  "<title>App não montado</title>" +
  "<body style='font-family:system-ui;max-width:40em;margin:3em auto'>" +
  "<h1>O front compilado ainda não foi montado nesta máquina.</h1>" +
  "<p>Ele nasce de <code>frontend/</code>: <code>cd frontend &amp;&amp; " +
  "npm install &amp;&amp; npm run build</code> escreve " +
  "<code>app/estaticos/app/</code> (copiado para <code>nuvem/public/estaticos/app/</code>), " +
  "e esta página passa a existir. " +
  "O sistema completo continua em <a href='/inicio'>/inicio</a> e a tela " +
  "de bolso em <a href='/celular'>/celular</a>.</p></body></html>";

/**
 * A página do app. `/app/qualquer-coisa` cai aqui também — o roteador do front
 * é por âncora, mas um endereço colado sem a âncora não pode virar 404.
 */
async function aplicativo(c: Ctx) {
  await usuarioLogado(c);
  if (!bundle_construido()) return c.html(SEM_BUNDLE, 503);
  return c.html(readFileSync(entrada(), "utf-8"), 200, { "Cache-Control": "no-cache" });
}

rotas.get("/app", aplicativo);
rotas.get("/app/*", aplicativo);
