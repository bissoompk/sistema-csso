/**
 * /inscricao/:token — o cartaz da turma, aberto, em que se PEDE a vaga sem
 * conta. A regra (e o porquê de não haver e-mail) mora em
 * `servicos/inscricao_publica.ts`.
 *
 * Como /validar: sem sessão, `noindex` e `no-store`, e o envio passa por um
 * limite por IP. Ao contrário dela, a página mostra a turma — o token é um
 * sorteio de 192 bits, e quem o tem recebeu o cartaz.
 */
import { Hono } from "hono";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { formulario } from "../dependencias.js";
import { ROTULO_VINCULO, VINCULOS_PARTICIPANTE } from "../dominio/treinamento.js";
import * as servico from "../servicos/inscricao_publica.js";
import { RegraDaTurma } from "../servicos/turma.js";
import { pagina } from "../web.js";
import { ipDoCliente } from "./autenticacao.js";
import { vista_turma } from "./treinamento_vistas.js";

export const rotas = new Hono<Ambiente>();

function _sem_rastro(resposta: Response): Response {
  resposta.headers.set("x-robots-tag", "noindex, nofollow");
  resposta.headers.set("cache-control", "no-store");
  // o token está no caminho: não sai para outro site no Referer
  resposta.headers.set("referrer-policy", "no-referrer");
  return resposta;
}

const VAZIO: servico.Pedido = { nome: "", vinculo: "SERVIDOR", siape: "", email: "", organizacao: "", consentimento: false };

async function _tela(
  c: Ctx,
  d: {
    link: servico.TurmaDoLink | null;
    pedido?: servico.Pedido;
    erro?: string | null;
    recebido?: boolean;
    excedeu?: boolean;
    status?: number;
  },
): Promise<Response> {
  const saida = await pagina(
    c,
    "paginas/inscricao_publica.html",
    null,
    {
      turma: d.link ? vista_turma(d.link.turma) : null,
      fechada: d.link?.fechada ?? "",
      pedido: d.pedido ?? VAZIO,
      erro: d.erro ?? null,
      recebido: d.recebido ?? false,
      excedeu: d.excedeu ?? false,
      resposta_padrao: servico.RESPOSTA_PADRAO,
      vinculos: VINCULOS_PARTICIPANTE,
      rotulo_vinculo: ROTULO_VINCULO,
      acao: c.req.path,
    },
    d.status ?? (d.link ? 200 : 404),
  );
  return _sem_rastro(saida);
}

rotas.get(`${servico.CAMINHO}/:token`, async (c) => {
  const link = await servico.turma_do_token(c.get("tx"), c.req.param("token"));
  return _tela(c, { link });
});

rotas.post(`${servico.CAMINHO}/:token`, async (c) => {
  const tx = c.get("tx");
  const ip = ipDoCliente(c);
  const f = await formulario(c);
  const pedido: servico.Pedido = {
    nome: f.texto("nome"),
    vinculo: f.texto("vinculo"),
    siape: f.texto("siape"),
    email: f.texto("email"),
    organizacao: f.texto("organizacao"),
    consentimento: f.texto("consentimento") === "sim",
  };
  // o limite vem antes de olhar o token: senão ele vira o oráculo do token
  if (!servico.dentro_do_limite(ip)) {
    return _tela(c, { link: null, pedido, excedeu: true, status: 429 });
  }
  const link = await servico.turma_do_token(tx, c.req.param("token"));
  if (!link || link.fechada) return _tela(c, { link, pedido });
  // o campo que gente não vê: robô preenche, e recebe a mesma resposta
  if (f.texto("site").trim()) return _tela(c, { link, recebido: true });
  try {
    await tx.transaction((sp) => servico.pedir(sp as typeof tx, link.turma, pedido, ip));
  } catch (erro) {
    if (erro instanceof servico.PedidoInvalido || erro instanceof RegraDaTurma) {
      return _tela(c, { link, pedido, erro: erro.message, status: 422 });
    }
    throw erro;
  }
  return _tela(c, { link, recebido: true });
});
