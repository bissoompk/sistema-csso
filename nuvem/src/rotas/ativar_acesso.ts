/**
 * /ativar-acesso — o primeiro acesso do servidor (SIAPE + e-mail do cadastro),
 * /esqueci-senha — "Esqueci minha senha" para qualquer conta, só com o e-mail,
 * e /ativar-acesso/:token, o link de uso único dos dois
 * (`servicos/ativar_acesso.ts`).
 *
 * Como /certificados/acesso: sem sessão, `noindex`, `no-store`, e o token vai
 * no caminho, por isso `no-referrer`. O pedido responde SEMPRE a mesma tela,
 * com piso de tempo. Depois de definir a senha a pessoa volta ao login (não
 * entra sozinha: o link de e-mail não é credencial de sessão).
 */
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { formulario } from "../dependencias.js";
import * as autenticacao from "../servicos/autenticacao.js";
import * as servico from "../servicos/ativar_acesso.js";
import * as email from "../servicos/email.js";
import * as emissao from "../servicos/emissao_certificado.js";
import { pagina, redirecionar } from "../web.js";
import { asc } from "drizzle-orm";
import { cargo as tabela_cargo } from "../db/esquema/index.js";
import { opcoes_de_lotacao } from "../servicos/servidores.js";
import { obterConfig } from "../config.js";
import { cookieSeguro } from "../nucleo/seguranca.js";
import { ipDoCliente } from "./autenticacao.js";
import { VINCULO_SERVIDOR, pedido_do_servidor } from "./pedido_conta.js";

const CAMINHO_CADASTRO = "/cadastre-se";

export const rotas = new Hono<Ambiente>();

function _sem_rastro(resposta: Response): Response {
  resposta.headers.set("x-robots-tag", "noindex, nofollow");
  resposta.headers.set("cache-control", "no-store");
  resposta.headers.set("referrer-policy", "no-referrer");
  return resposta;
}

/**
 * O que sobrou desta tela: o link de confirmação do e-mail, a escolha da senha
 * (Esqueci minha senha, convite) e o link vencido. O pedido do servidor mora em
 * /cadastre-se (26/10/2026): aqui o GET só leva até lá.
 */
async function _tela(
  c: Ctx,
  d: {
    token?: string;
    definir?: boolean;
    confirmar?: boolean;
    invalido?: boolean;
    erro_senha?: string | null;
    status?: number;
  } = {},
): Promise<Response> {
  return _sem_rastro(
    await pagina(
      c,
      "paginas/ativar_acesso.html",
      null,
      {
        definir: d.definir ?? false,
        confirmar: d.confirmar ?? false,
        invalido: d.invalido ?? false,
        erro_senha: d.erro_senha ?? null,
        token: d.token ?? "",
        caminho: servico.CAMINHO,
      },
      d.status ?? 200,
    ),
  );
}

// O primeiro acesso do servidor virou um vínculo do Cadastre-se: o endereço
// antigo (favorito, e-mail de aviso) leva até o formulário dele.
rotas.get(servico.CAMINHO, (c) => _sem_rastro(redirecionar(c, `${CAMINHO_CADASTRO}?vinculo=${VINCULO_SERVIDOR}`)));

// O POST antigo segue respondendo (formulário em cache): é o mesmo pedido.
rotas.post(servico.CAMINHO, async (c) => pedido_do_servidor(c, await formulario(c)));

// "Esqueci minha senha" só com o e-mail, para qualquer conta
async function _tela_esqueci(c: Ctx, d: { email?: string; erro?: string | null; recebido?: boolean; status?: number } = {}) {
  return _sem_rastro(
    await pagina(
      c,
      "paginas/esqueci_senha.html",
      null,
      {
        digitado: d.email ?? "",
        erro: d.erro ?? null,
        recebido: d.recebido ?? false,
        resposta_padrao: servico.RESPOSTA_ESQUECI,
        caminho: servico.CAMINHO_ESQUECI,
      },
      d.status ?? 200,
    ),
  );
}

rotas.get(servico.CAMINHO_ESQUECI, (c) => _tela_esqueci(c));

rotas.post(servico.CAMINHO_ESQUECI, async (c) => {
  const inicio = Date.now();
  const f = await formulario(c);
  const digitado = f.texto("email").trim().slice(0, 160);
  const tx = c.get("tx");
  try {
    await servico.pedir_por_email(tx, digitado, ipDoCliente(c), await emissao.url_base_validacao(tx));
  } catch (erro) {
    if (erro instanceof servico.DadosInvalidos) return _tela_esqueci(c, { email: digitado, erro: erro.message, status: 422 });
    throw erro;
  }
  await email.acordar_envio();
  await servico.esperar_piso(inicio);
  return _tela_esqueci(c, { recebido: true });
});

rotas.get(`${servico.CAMINHO}/:token`, async (c) => {
  const token = c.req.param("token");
  const pede = await servico.o_que_o_link_pede(c.get("tx"), token);
  if (!pede) return _tela(c, { invalido: true, status: 404 });
  return _tela(c, pede === "confirmar" ? { confirmar: true, token } : { definir: true, token });
});

rotas.post(`${servico.CAMINHO}/:token`, async (c) => {
  const token = c.req.param("token");
  const f = await formulario(c);
  const tx = c.get("tx");
  try {
    const feito = await servico.definir_senha(tx, token, f.texto("nova"), f.texto("confirmacao"), {
      ip: ipDoCliente(c),
      user_agent: c.req.header("user-agent") ?? null,
      base_url: await emissao.url_base_validacao(tx),
    });
    // quem confirmou o e-mail entra logado (26/10/2026): sem a tela de entrada
    if (feito.sessao) {
      setCookie(c, autenticacao.COOKIE_SESSAO, feito.sessao, {
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        maxAge: obterConfig().sessaoHoras * 3600,
        secure: cookieSeguro(c.req.url),
      });
      return _sem_rastro(redirecionar(c, "/?ativado=1"));
    }
    return _sem_rastro(redirecionar(c, `/login?motivo=${feito.resultado === "criada" ? "ativada" : "redefinida"}`));
  } catch (erro) {
    if (erro instanceof servico.LinkInvalido) return _tela(c, { invalido: true, status: 404 });
    if (erro instanceof autenticacao.SenhaRecusada) {
      return _tela(c, { definir: true, token, erro_senha: erro.message, status: 422 });
    }
    throw erro;
  }
});
