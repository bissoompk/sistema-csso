/**
 * /cadastre-se — o único cadastro, da tela de entrada — e /usuarios/pedidos, a
 * fila em que a equipe confere os pedidos de conta (`servicos/pedido_conta.ts`).
 *
 * /cadastre-se pergunta o vínculo. O servidor informa SIAPE, e-mail
 * institucional, nome e senha (`servicos/ativar_acesso.ts`: o e-mail
 * confirmado ativa o acesso e entra); terceirizado e discente, e-mail, nome e
 * senha (`servicos/pedido_conta.ts`). A opção «Primeiro acesso do servidor»
 * deixou de existir (26/10/2026). Como as outras telas sem sessão: `noindex`,
 * `no-store`, `no-referrer`, a mesma resposta para todo pedido e piso de tempo.
 */
import { Hono } from "hono";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { ErroHttp } from "../nucleo/erros.js";
import { formulario, usuarioLogado } from "../dependencias.js";
import * as ativar_acesso from "../servicos/ativar_acesso.js";
import * as emissao from "../servicos/emissao_certificado.js";
import * as email from "../servicos/email.js";
import * as servico from "../servicos/pedido_conta.js";
import "../servicos/pendencias.js"; // liga o sino da casca
import { comMensagem, pagina, redirecionar } from "../web.js";
import { ipDoCliente } from "./autenticacao.js";

export const rotas = new Hono<Ambiente>();

function _sem_rastro(resposta: Response): Response {
  resposta.headers.set("x-robots-tag", "noindex, nofollow");
  resposta.headers.set("cache-control", "no-store");
  resposta.headers.set("referrer-policy", "no-referrer");
  return resposta;
}

type Digitado = Partial<servico.DadosPedido> & { siape?: string };

/** O vínculo do servidor no Cadastre-se: o formulário dele pede o SIAPE. */
export const VINCULO_SERVIDOR = "SERVIDOR";

async function _tela(
  c: Ctx,
  d: {
    vinculo?: string;
    digitado?: Digitado;
    erro?: string | null;
    recebido?: boolean;
    confirmar?: string | null;
    confirmado?: boolean;
    invalido?: boolean;
    status?: number;
  } = {},
): Promise<Response> {
  const vinculo =
    d.vinculo === VINCULO_SERVIDOR || servico.VINCULOS.includes(d.vinculo as servico.Vinculo) ? d.vinculo : null;
  return _sem_rastro(
    await pagina(
      c,
      "paginas/cadastre_se.html",
      null,
      {
        vinculo,
        d: d.digitado ?? {},
        erro: d.erro ?? null,
        recebido: d.recebido ?? false,
        confirmar: d.confirmar ?? null,
        confirmado: d.confirmado ?? false,
        invalido: d.invalido ?? false,
        caminho_confirmar: servico.CAMINHO_CONFIRMAR,
        resposta_padrao: d.vinculo === VINCULO_SERVIDOR ? ativar_acesso.RESPOSTA_PADRAO : servico.RESPOSTA_PADRAO,
        caminho: servico.CAMINHO,
        vinculo_servidor: VINCULO_SERVIDOR,
        dominio_servidor: ativar_acesso.DOMINIO_SERVIDOR,
        dominio_discente: servico.DOMINIO_DISCENTE,
        ROTULO_VINCULO: servico.ROTULO_VINCULO,
      },
      d.status ?? 200,
    ),
  );
}

rotas.get(servico.CAMINHO, (c) => _tela(c, { vinculo: c.req.query("vinculo") ?? "" }));

/**
 * O pedido do servidor: SIAPE, e-mail institucional, nome e senha. É o mesmo
 * serviço do antigo «Primeiro acesso do servidor» (`ativar_acesso.pedir`); só a
 * porta de entrada mudou. Exportado para o POST antigo de /ativar-acesso, que
 * segue respondendo (formulário em cache, favorito).
 */
export async function pedido_do_servidor(c: Ctx, f: Awaited<ReturnType<typeof formulario>>): Promise<Response> {
  const inicio = Date.now();
  const siape = f.texto("siape").trim().slice(0, 20);
  const digitado = { siape, email: f.texto("email").trim().slice(0, 160), nome: f.texto("nome").trim().slice(0, 160) };
  const tx = c.get("tx");
  try {
    await ativar_acesso.pedir(
      tx,
      { ...digitado, nova: f.texto("nova"), confirmacao: f.texto("confirmacao") },
      ipDoCliente(c),
      await emissao.url_base_validacao(tx),
    );
  } catch (erro) {
    if (erro instanceof ativar_acesso.DadosInvalidos) {
      return _tela(c, { vinculo: VINCULO_SERVIDOR, digitado, erro: erro.message, status: 422 });
    }
    throw erro;
  }
  await email.acordar_envio();
  if (!email.configurado()) {
    // para quem opera (o log da função), sem dado de ninguém; a tela não muda
    console.warn("[cadastre-se] pedido recebido, mas o envio de e-mail não está configurado: nada saiu da fila");
  }
  await ativar_acesso.esperar_piso(inicio);
  return _tela(c, { vinculo: VINCULO_SERVIDOR, recebido: true });
}

rotas.post(servico.CAMINHO, async (c) => {
  const inicio = Date.now();
  const f = await formulario(c);
  if (f.texto("vinculo") === VINCULO_SERVIDOR) return pedido_do_servidor(c, f);
  const digitado: servico.DadosPedido = {
    vinculo: f.texto("vinculo").slice(0, 20),
    nome: f.texto("nome").slice(0, 400),
    email: f.texto("email").slice(0, 400),
    organizacao: f.texto("organizacao").slice(0, 400),
    matricula: f.texto("matricula").slice(0, 100),
    maior_de_idade: f.texto("maior_de_idade") === "1",
    nova: f.texto("nova"),
    confirmacao: f.texto("confirmacao"),
  };
  // a senha nunca volta para a tela
  const { nova: _n, confirmacao: _c, ...sem_senha } = digitado;
  const tx = c.get("tx");
  try {
    await servico.pedir(tx, digitado, ipDoCliente(c), await emissao.url_base_validacao(tx));
  } catch (erro) {
    if (erro instanceof servico.DadosInvalidos) {
      return _tela(c, { vinculo: digitado.vinculo, digitado: sem_senha, erro: erro.message, status: 422 });
    }
    throw erro;
  }
  await email.acordar_envio();
  await ativar_acesso.esperar_piso(inicio);
  return _tela(c, { recebido: true });
});

// o link "Confirmar e-mail": abrir mostra o botão; só o POST confirma (leitor
// de e-mail pré-visualiza links)
rotas.get(`${servico.CAMINHO_CONFIRMAR}/:token`, async (c) => {
  const token = c.req.param("token");
  if (!(await servico.pedido_a_confirmar(c.get("tx"), token))) return _tela(c, { invalido: true, status: 404 });
  return _tela(c, { confirmar: token });
});

rotas.post(`${servico.CAMINHO_CONFIRMAR}/:token`, async (c) => {
  const tx = c.get("tx");
  const feito = await servico.confirmar_email(tx, c.req.param("token"), ipDoCliente(c), await emissao.url_base_validacao(tx));
  if (!feito) return _tela(c, { invalido: true, status: 404 });
  return _tela(c, { confirmado: true });
});

// ---------------------------------------------------------------------
// A fila da equipe
// ---------------------------------------------------------------------
const FILA = "/usuarios/pedidos";

async function _fila(c: Ctx, erro: string | null = null, status = 200): Promise<Response> {
  const usuario = await usuarioLogado(c);
  usuario.exigir("usuario.criar_conta");
  const tx = c.get("tx");
  const { pendentes } = await servico.fila(tx);
  const contas = await servico.contas_externas(tx);
  return pagina(
    c,
    "paginas/pedidos_conta.html",
    usuario,
    { pendentes, contas, ROTULO_VINCULO: servico.ROTULO_VINCULO, mensagem: c.req.query("mensagem") ?? null, erro },
    status,
  );
}

rotas.get(FILA, (c) => _fila(c));

function _id(c: Ctx): number {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id <= 0) throw new ErroHttp(404, "Pedido não encontrado.");
  return id;
}

rotas.post(`${FILA}/:id{[0-9]+}/aprovar`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("usuario.criar_conta");
  const tx = c.get("tx");
  try {
    const p = await servico.aprovar(tx, usuario, _id(c), await emissao.url_base_validacao(tx));
    await email.acordar_envio();
    return redirecionar(
      c,
      comMensagem(FILA, `Pedido nº ${p.id} aprovado: a conta foi criada e o link para definir a senha foi enviado a ${p.email}.`),
    );
  } catch (erro) {
    if (erro instanceof servico.DecisaoRecusada) return _fila(c, erro.message, 422);
    throw erro;
  }
});

rotas.post(`${FILA}/:id{[0-9]+}/recusar`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("usuario.criar_conta");
  const f = await formulario(c);
  try {
    const p = await servico.recusar(c.get("tx"), usuario, _id(c), f.texto("motivo"));
    await email.acordar_envio();
    return redirecionar(c, comMensagem(FILA, `Pedido nº ${p.id} recusado. A pessoa foi avisada por e-mail, sem o motivo.`));
  } catch (erro) {
    if (erro instanceof servico.DecisaoRecusada) return _fila(c, erro.message, 422);
    throw erro;
  }
});

// bloquear, desbloquear e excluir as contas de terceirizado e discente
for (const [acao, fazer] of [
  ["bloquear", async (c: Ctx, id: number) => `Conta de ${await servico.bloquear(c.get("tx"), await usuarioLogado(c), id, true)} bloqueada: ela não entra mais e as sessões abertas foram encerradas.`],
  ["desbloquear", async (c: Ctx, id: number) => `Conta de ${await servico.bloquear(c.get("tx"), await usuarioLogado(c), id, false)} desbloqueada.`],
  [
    "excluir",
    async (c: Ctx, id: number) => {
      const r = await servico.excluir(c.get("tx"), await usuarioLogado(c), id);
      return r.resultado === "excluida"
        ? `Conta de ${r.nome} excluída.`
        : `A conta de ${r.nome} já tem registros no sistema (inscrição, certificado, comunicação ou trilha) e não pode ser apagada: foi bloqueada no lugar.`;
    },
  ],
] as const) {
  rotas.post(`${FILA}/contas/:id{[0-9]+}/${acao}`, async (c) => {
    const usuario = await usuarioLogado(c);
    usuario.exigir("usuario.criar_conta");
    try {
      return redirecionar(c, comMensagem(FILA, await fazer(c, _id(c))));
    } catch (erro) {
      if (erro instanceof servico.DecisaoRecusada) return _fila(c, erro.message, 422);
      throw erro;
    }
  });
}

