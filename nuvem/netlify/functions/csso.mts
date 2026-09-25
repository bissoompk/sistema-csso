/**
 * A função única do Netlify: recebe toda requisição que não é arquivo
 * estático e a entrega ao app Hono.
 *
 * `preferStatic: true` é o que deixa `/estaticos/...` com o CDN: se existe um
 * arquivo publicado no caminho, ele sai direto, sem acordar a função.
 */
import type { Config, Context } from "@netlify/functions";
import { obterApp } from "../../src/app.js";

// O `context` do Netlify vai como contexto de execução do Hono só pelo
// `waitUntil`: o registro de acesso (`servicos/registro_acesso.ts`) grava
// depois de a resposta sair, sem atrasá-la.
export default async (req: Request, context: Context) =>
  obterApp().fetch(req, undefined, {
    waitUntil: (p: Promise<unknown>) => context.waitUntil(p),
    passThroughOnException: () => {},
    props: {},
  });

export const config: Config = {
  path: "/*",
  preferStatic: true,
};
