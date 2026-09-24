/**
 * A função única do Netlify: recebe toda requisição que não é arquivo
 * estático e a entrega ao app Hono.
 *
 * `preferStatic: true` é o que deixa `/estaticos/...` com o CDN: se existe um
 * arquivo publicado no caminho, ele sai direto, sem acordar a função.
 */
import type { Config } from "@netlify/functions";
import { obterApp } from "../../src/app.js";

export default async (req: Request) => obterApp().fetch(req);

export const config: Config = {
  path: "/*",
  preferStatic: true,
};
