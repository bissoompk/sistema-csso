/** /modulos — o mapa do sistema — e /inicio, o despachante da porta da frente. Porte de `app/rotas/modulos.py`. */
import { Hono } from "hono";
import type { Ambiente } from "../nucleo/contexto.js";
import { usuarioLogado } from "../dependencias.js";
import { pagina, redirecionar } from "../web.js";
import { primeira_tela } from "../modulos.js";

export const rotas = new Hono<Ambiente>();

rotas.get("/modulos", async (c) => {
  // sem exigir permissão: é a tela que explica onde ficam as coisas, e cada
  // item já se esconde sozinho de quem não pode vê-lo
  const usuario = await usuarioLogado(c);
  return pagina(c, "paginas/modulos.html", usuario);
});

/**
 * Onde o sistema começa para QUEM entrou — não é tela, é desvio. `/` é o
 * painel de Processos SEI e exige `processo.ver`; para o almoxarife a primeira
 * tela depois do login seria um 403. Não exige permissão além da sessão.
 */
rotas.get("/inicio", async (c) => {
  const usuario = await usuarioLogado(c);
  return redirecionar(c, primeira_tela(usuario));
});
