/**
 * /certificados/acesso — o participante sem conta pede, por e-mail, o link
 * dos próprios certificados (`servicos/acesso_participante.ts`).
 *
 * Como /validar: sem sessão, `noindex`, `no-store`; o token vai no caminho, e
 * por isso `no-referrer`. O pedido passa pelo limite por IP.
 */
import { Hono } from "hono";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { formulario } from "../dependencias.js";
import * as servico from "../servicos/acesso_participante.js";
import type { CartaoCertificado } from "../servicos/certificados_titular.js";
import * as email from "../servicos/email.js";
import * as emissao from "../servicos/emissao_certificado.js";
import { pagina } from "../web.js";
import { ipDoCliente } from "./autenticacao.js";
import { baixar } from "./turmas.js";

export const rotas = new Hono<Ambiente>();

function _sem_rastro(resposta: Response): Response {
  resposta.headers.set("x-robots-tag", "noindex, nofollow");
  resposta.headers.set("cache-control", "no-store");
  resposta.headers.set("referrer-policy", "no-referrer");
  return resposta;
}

async function _tela(
  c: Ctx,
  d: {
    digitado?: string;
    erro?: string | null;
    recebido?: boolean;
    excedeu?: boolean;
    itens?: servico.ItemDoTitular[] | null;
    cartoes?: CartaoCertificado[];
    aberto?: servico.LinkAberto | null;
    token?: string;
    expirado?: boolean;
    status?: number;
  } = {},
): Promise<Response> {
  return _sem_rastro(
    await pagina(
      c,
      "paginas/acesso_participante.html",
      null,
      {
        disponivel: email.configurado(),
        digitado: d.digitado ?? "",
        erro: d.erro ?? null,
        recebido: d.recebido ?? false,
        excedeu: d.excedeu ?? false,
        resposta_padrao: servico.RESPOSTA_PADRAO,
        itens: d.itens ?? null,
        cartoes: d.cartoes ?? [],
        aberto: d.itens !== undefined && d.itens !== null,
        ambiguo: d.aberto?.ambiguo ?? false,
        titular: d.aberto?.titular ?? "",
        // quanto falta, e a hora em Brasília: "vence às 14:32 (daqui a 1 h 47 min)"
        vence_as: d.aberto
          ? d.aberto.expira_em.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" })
          : "",
        falta: d.aberto ? servico.tempo_restante(d.aberto.expira_em) : "",
        token: d.token ?? "",
        expirado: d.expirado ?? false,
        caminho: servico.CAMINHO,
      },
      d.status ?? 200,
    ),
  );
}

rotas.get(servico.CAMINHO, (c) => _tela(c));

rotas.post(servico.CAMINHO, async (c) => {
  const f = await formulario(c);
  const digitado = f.texto("email").trim().slice(0, 160);
  if (!email.configurado()) return _tela(c, { digitado });
  const tx = c.get("tx");
  if (!(await servico.dentro_do_limite(tx, ipDoCliente(c)))) return _tela(c, { digitado, excedeu: true, status: 429 });
  try {
    await servico.pedir_link(tx, digitado, ipDoCliente(c), await emissao.url_base_validacao(tx));
  } catch (erro) {
    if (erro instanceof servico.EmailInvalido) return _tela(c, { digitado, erro: erro.message, status: 422 });
    throw erro;
  }
  await email.acordar_envio();
  return _tela(c, { recebido: true });
});

rotas.get(`${servico.CAMINHO}/:token`, async (c) => {
  const token = c.req.param("token");
  const aberto = await servico.abrir(c.get("tx"), token);
  if (!aberto) return _tela(c, { expirado: true, status: 404 });
  return _tela(c, { itens: servico.itens(aberto.certificados), cartoes: servico.cartoes(aberto.certificados), aberto, token });
});

rotas.get(`${servico.CAMINHO}/:token/:certificado_id{[0-9]+}`, async (c) => {
  const tx = c.get("tx");
  const aberto = await servico.abrir(tx, c.req.param("token"));
  if (!aberto) return _tela(c, { expirado: true, status: 404 });
  const certificado = aberto.certificados.find((x) => x.id === Number(c.req.param("certificado_id")));
  // o certificado de outra pessoa e o que não existe são o mesmo "não"
  if (!certificado) {
    return _tela(c, {
      itens: servico.itens(aberto.certificados),
      cartoes: servico.cartoes(aberto.certificados),
      aberto,
      token: c.req.param("token"),
      status: 404,
    });
  }
  const arquivo = await emissao.arquivo_do_titular(tx, certificado);
  return _sem_rastro(baixar(c, arquivo.bytes, arquivo.nome, arquivo.tipo));
});
