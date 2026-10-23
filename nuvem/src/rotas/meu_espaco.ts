/**
 * NUVEM (Portal do servidor, 22/10/2026): as telas novas do "Meu espaço" que
 * não pertencem a outro módulo — "Minha atividade" (`/minha-atividade`).
 * Toda tela daqui é do TITULAR: lê só o que é da conta da sessão.
 *
 * "Minha atividade" abre para toda conta logada, sem permissão nova: o que ela
 * mostra é sempre da própria conta (o `servidor_id` e o id da sessão, nunca um
 * id vindo da URL). Conta sem servidor vinculado recebe a explicação, e não a
 * lista. O `?antes=` é só um cursor de posição: um id de evento alheio não abre
 * nada, porque a consulta continua presa ao titular.
 */
import { Hono } from "hono";
import type { Ambiente } from "../nucleo/contexto.js";
import { usuarioLogado } from "../dependencias.js";
import { atividade_do_titular, grupo_valido, GRUPOS_ATIVIDADE } from "../servicos/atividade_titular.js";
import { pagina } from "../web.js";
import { e_externo } from "../modulos.js";
import { acidentesLiberado } from "../config.js";

export const rotas = new Hono<Ambiente>();

export const MINHA_ATIVIDADE = "/minha-atividade";

rotas.get(MINHA_ATIVIDADE, async (c) => {
  const usuario = await usuarioLogado(c);
  const grupo = grupo_valido(c.req.query("tipo"));
  if (usuario.servidor_id === null) {
    return pagina(c, "paginas/minha_atividade.html", usuario, {
      sem_servidor: true,
      // o terceirizado e o discente nunca terão o vínculo: o aviso não manda
      // pedir à coordenação o que ela não pode fazer
      externo: e_externo(usuario),
      com_acidentes: acidentesLiberado(),
      grupos: GRUPOS_ATIVIDADE,
      grupo,
      atividade: null,
    });
  }
  const bruto = c.req.query("antes") ?? "";
  const antes = /^\d{1,15}$/.test(bruto) ? Number(bruto) : null;
  const atividade = await atividade_do_titular(c.get("tx"), usuario, { grupo }, { antes });
  return pagina(c, "paginas/minha_atividade.html", usuario, {
    sem_servidor: false,
    grupos: GRUPOS_ATIVIDADE,
    grupo,
    antes,
    atividade,
  });
});
