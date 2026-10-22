/**
 * O sistema na máquina de quem desenvolve: o mesmo app da função do Netlify,
 * servido pelo Node, com os estáticos de `public/` e o banco do `.env` local.
 *
 *     npm run dev        # http://localhost:8766
 */
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { carregarEnvLocal } from "./env-local.js";

carregarEnvLocal();
process.env.NODE_ENV ??= "development";
// a porta vai para o ambiente: o link público e o QR do certificado sem
// endereço declarado (`url_base_validacao`) apontam para ela, e não para outra
process.env.PORTA = (process.env.PORTA ?? "").trim() || "8766";
const { obterApp } = await import("../src/app.js");

const porta = Number(process.env.PORTA);
const raiz = new Hono();
raiz.use("/estaticos/*", serveStatic({ root: "./public" }));
// `fetch` do app inteiro, e não `raiz.route(...)`: montado como sub-app, o
// `notFound` do app (a tela de 404 com a casca) era trocado pelo 404 cru da raiz.
const app = obterApp();
raiz.all("*", (c) => app.fetch(c.req.raw, c.env));
serve({ fetch: raiz.fetch, port: porta }, () => {
  console.log(`Sistema SISA (nuvem) em http://localhost:${porta}`);
});
