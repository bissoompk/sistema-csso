/**
 * /aviso-cadastro/:token — os botões "Sim, fui eu" / "Não fui eu" do e-mail
 * que avisa quem já tem cadastro de que alguém pediu vaga pelo link público
 * (`servicos/aviso_cadastro_existente.ts`, etapa 2, 26/10/2026).
 *
 * Como /certificados/acesso: sem sessão, `noindex`, `no-store`, e o token vai
 * no caminho, por isso `no-referrer`. Abrir o link NÃO responde — leitor de
 * e-mail pré-visualiza links —; o botão responde, por POST. Link desconhecido
 * e link vencido são o mesmo "não vale mais".
 */
import { Hono } from "hono";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { formulario } from "../dependencias.js";
import * as servico from "../servicos/aviso_cadastro_existente.js";
import { dentro_do_limite } from "../servicos/inscricao_publica.js";
import { pagina } from "../web.js";
import { ipDoCliente } from "./autenticacao.js";

export const rotas = new Hono<Ambiente>();

const PREFIXO_CHAVE_IP = "aviso:";
const LIMITE_POR_JANELA = 20;

function _sem_rastro(resposta: Response): Response {
  resposta.headers.set("x-robots-tag", "noindex, nofollow");
  resposta.headers.set("cache-control", "no-store");
  resposta.headers.set("referrer-policy", "no-referrer");
  return resposta;
}

async function _tela(
  c: Ctx,
  d: { aviso?: servico.AvisoAberto | null; resposta?: servico.Resposta | null; token?: string; excedeu?: boolean; status?: number },
): Promise<Response> {
  return _sem_rastro(
    await pagina(
      c,
      "paginas/aviso_cadastro.html",
      null,
      {
        aviso: d.aviso ?? null,
        resposta: d.resposta ?? null,
        token: d.token ?? "",
        excedeu: d.excedeu ?? false,
        caminho: servico.CAMINHO,
      },
      d.status ?? 200,
    ),
  );
}

rotas.get(`${servico.CAMINHO}/:token`, async (c) => {
  const token = c.req.param("token");
  const aviso = await servico.abrir(c.get("tx"), token);
  if (!aviso) return _tela(c, { status: 404 });
  return _tela(c, { aviso, resposta: aviso.resposta, token });
});

rotas.post(`${servico.CAMINHO}/:token`, async (c) => {
  const tx = c.get("tx");
  const token = c.req.param("token");
  if (!(await dentro_do_limite(tx, ipDoCliente(c), new Date(), PREFIXO_CHAVE_IP, LIMITE_POR_JANELA))) {
    return _tela(c, { excedeu: true, status: 429 });
  }
  const aviso = await servico.abrir(tx, token);
  if (!aviso) return _tela(c, { status: 404 });
  const f = await formulario(c);
  const escolhida = f.texto("resposta");
  if (escolhida !== "SOU_EU" && escolhida !== "NAO_FUI_EU") return _tela(c, { aviso, resposta: aviso.resposta, token, status: 422 });
  const resposta = await servico.responder(tx, token, escolhida);
  if (!resposta) return _tela(c, { status: 404 });
  return _tela(c, { aviso, resposta, token });
});
