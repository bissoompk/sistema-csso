/**
 * /validar — a página pública que confirma um certificado pela chave.
 * Porte de `app/rotas/validacao.py`.
 *
 * A única rota do módulo que **não pede sessão**, como no Python: a página
 * serve a quem NÃO tem conta — o órgão, a banca, a empresa que recebeu o
 * certificado e quer saber se ele é autêntico. O endereço vem impresso no
 * papel e no QR (`emissao_certificado.url_base_validacao`), e papel não se
 * corrige depois de entregue.
 *
 * **O que ela nunca mostra:** o nome de quem se formou. A regra mora em
 * `servicos/validacao_certificado.ts`, junto do limite por IP e da conferência
 * de nome que entra no lugar da exibição.
 */
import { Hono } from "hono";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { formulario } from "../dependencias.js";
import { normalizar_chave } from "../servicos/certificado.js";
import * as datas_br from "../servicos/datas_br.js";
import * as email from "../servicos/email.js";
import * as servico from "../servicos/validacao_certificado.js";
import { pagina, redirecionar } from "../web.js";
import { ipDoCliente } from "./autenticacao.js";

export const rotas = new Hono<Ambiente>();

export const VALIDAR = "/validar";

// A chave vai na URL porque é assim que o QR a carrega; um caminho de 4 KB só
// serviria para encher o registro de acesso. 48 = a coluna `chave_validacao`:
// a chave nova (22/10/2026) chega a 41 caracteres (sigla de 12, código de 10).
export const TAMANHO_MAXIMO_CHAVE = 48;

/**
 * `noindex` e `no-store` na resposta pública: a página responde sobre um
 * documento de uma pessoa e não pode ficar no cache de um balcão
 * compartilhado; indexada, convidaria a varredura.
 */
function _sem_rastro(resposta: Response): Response {
  resposta.headers.set("x-robots-tag", "noindex, nofollow");
  resposta.headers.set("cache-control", "no-store");
  return resposta;
}

async function _tela(
  c: Ctx,
  d: {
    resposta?: servico.Resposta | null;
    digitada?: string;
    confere?: boolean | null;
    nome_digitado?: string;
    excedeu?: boolean;
    status?: number;
  } = {},
): Promise<Response> {
  const saida = await pagina(
    c,
    "paginas/validacao.html",
    null,
    {
      resposta: d.resposta ?? null,
      digitada: d.digitada ?? "",
      confere: d.confere ?? null,
      nome_digitado: d.nome_digitado ?? "",
      excedeu: d.excedeu ?? false,
      // digitou só o número impresso: a tela orienta a usar o código do QR.
      // Decide pelo FORMATO, nunca pelo banco — a negativa é a mesma.
      so_numero: Boolean(d.resposta && !d.resposta.encontrado && servico.so_o_numero(d.digitada)),
      tamanho_maximo_chave: TAMANHO_MAXIMO_CHAVE,
      hoje: datas_br.hoje(),
      limite_curto: servico.LIMITE_CURTO,
      // o convite "receba por e-mail" só quando o envio está ligado: sem ele a
      // página de acesso só responde "indisponível"
      acesso_por_email: email.configurado(),
    },
    d.status ?? 200,
  );
  return _sem_rastro(saida);
}

/** A tela sem chave: só o campo e a explicação do que ela responde. */
rotas.get(VALIDAR, (c) => _tela(c));

/**
 * O campo digitado vira URL: o endereço da resposta é o MESMO que está
 * impresso no papel.
 */
rotas.post(VALIDAR, async (c) => {
  const f = await formulario(c);
  const limpa = normalizar_chave(f.texto("chave")).slice(0, TAMANHO_MAXIMO_CHAVE);
  if (!limpa) return _sem_rastro(redirecionar(c, VALIDAR));
  return _sem_rastro(redirecionar(c, `${VALIDAR}/${encodeURIComponent(limpa)}`));
});

/**
 * A resposta: autêntico ou não, e nunca de quem. O limite por IP é cobrado
 * ANTES da consulta, e conta a tentativa mesmo quando a chave é válida.
 */
rotas.get(`${VALIDAR}/:chave`, async (c) => {
  const chave = c.req.param("chave");
  if (!servico.dentro_do_limite(ipDoCliente(c))) {
    // 429, e a tela diz o que fazer — "você excedeu" não é "você não pode"
    return _tela(c, { digitada: chave, excedeu: true, status: 429 });
  }
  const resposta = await servico.consultar(c.get("tx"), chave.slice(0, TAMANHO_MAXIMO_CHAVE));
  return _tela(c, { resposta, digitada: normalizar_chave(chave) });
});

/**
 * Confere / não confere — um bit, no lugar do nome. Passa pelo mesmo limite
 * por IP: sem ele, um bit por requisição ainda é um oráculo.
 */
rotas.post(`${VALIDAR}/:chave/conferir`, async (c) => {
  const chave = c.req.param("chave");
  const f = await formulario(c);
  const nome = f.texto("nome");
  if (!servico.dentro_do_limite(ipDoCliente(c))) {
    return _tela(c, { digitada: chave, excedeu: true, status: 429 });
  }
  const tx = c.get("tx");
  const limpa = normalizar_chave(chave).slice(0, TAMANHO_MAXIMO_CHAVE);
  const resposta = await servico.consultar(tx, limpa);
  const confere = resposta.encontrado ? await servico.confere_o_nome(tx, resposta.chave, nome) : null;
  return _tela(c, {
    resposta,
    digitada: resposta.encontrado ? resposta.chave : limpa,
    confere,
    // o que foi digitado volta: sem isso "não confere" some junto com o texto
    nome_digitado: nome.trim(),
  });
});
