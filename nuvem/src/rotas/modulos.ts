/** /modulos — o mapa do sistema — e /inicio, a Visão geral (a porta da frente). Porte de `app/rotas/modulos.py`. */
import { Hono } from "hono";
import type { Ambiente } from "../nucleo/contexto.js";
import { usuarioLogado } from "../dependencias.js";
import { pagina, redirecionar } from "../web.js";
import { primeira_tela, so_o_proprio } from "../modulos.js";
import { visao_geral } from "../servicos/visao_geral.js";

export const rotas = new Hono<Ambiente>();

rotas.get("/modulos", async (c) => {
  // sem exigir permissão: é a tela que explica onde ficam as coisas, e cada
  // item já se esconde sozinho de quem não pode vê-lo
  const usuario = await usuarioLogado(c);
  return pagina(c, "paginas/modulos.html", usuario);
});

/**
 * Onde o sistema começa para QUEM entrou. Não exige permissão além da sessão.
 *
 * Para a EQUIPE é a Visão geral (Início com os cartões dos módulos,
 * 23/10/2026): um cartão por módulo que a pessoa abre, como a `#home-view` do
 * IntegraSST, onde todo mundo caía depois de entrar. Vale também para quem
 * opera um módulo só (o almoxarife): a tela é a mesma, com um cartão, e é dela
 * que se vê o que está por vir — o desvio direto para o módulo faria a Visão
 * geral existir só para alguns.
 *
 * Quem só tem o próprio (o titular, sem perfil de equipe) continua sendo
 * desviado para a primeira tela dele — o Início do portal (`/`): os cartões
 * dos módulos da equipe seriam portas que não abrem para ele.
 */
rotas.get("/inicio", async (c) => {
  const usuario = await usuarioLogado(c);
  if (so_o_proprio(usuario)) return redirecionar(c, primeira_tela(usuario));
  const dados = await visao_geral(c.get("tx"), usuario, c.get("sino_antecipado"));
  return pagina(c, "paginas/visao_geral.html", usuario, { ...dados, na_visao_geral: true });
});
