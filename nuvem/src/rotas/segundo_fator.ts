/**
 * /minha-conta/segundo-fator — ligar e desligar o aplicativo autenticador
 * (01/11/2026, OPCIONAL). Abre para toda conta logada e mexe só na conta da
 * sessão, nunca num id vindo da URL. A administração desliga o fator de outra
 * conta em /usuarios (quem perdeu o celular e os códigos de recuperação).
 */
import { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import QRCode from "qrcode";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { formulario, usuarioLogado } from "../dependencias.js";
import { ipDoCliente } from "./autenticacao.js";
import * as autenticacao from "../servicos/autenticacao.js";
import * as segundo_fator from "../servicos/segundo_fator.js";
import type { UsuarioAtual } from "../servicos/rbac.js";
import { pagina, redirecionar } from "../web.js";

export const rotas = new Hono<Ambiente>();

const BASE = "/minha-conta/segundo-fator";

async function _tela(
  c: Ctx,
  usuario: UsuarioAtual,
  d: { erro?: string | null; mensagem?: string | null; cadastro?: { segredo: string; uri: string } | null; codigos?: string[] | null } = {},
  status = 200,
) {
  const tx = c.get("tx");
  const ligado = await segundo_fator.ativo(tx, usuario.id);
  const qr = d.cadastro ? await QRCode.toString(d.cadastro.uri, { type: "svg", margin: 1, width: 192 }) : null;
  return pagina(
    c,
    "paginas/segundo_fator.html",
    usuario,
    {
      ligado,
      restantes: ligado ? await segundo_fator.codigos_restantes(tx, usuario.id) : 0,
      cadastro: d.cadastro ?? null,
      qr_svg: qr,
      codigos: d.codigos ?? null,
      erro: d.erro ?? null,
      mensagem: d.mensagem ?? null,
      base: BASE,
    },
    status,
  );
}

rotas.get(BASE, async (c) => _tela(c, await usuarioLogado(c)));

rotas.post(`${BASE}/iniciar`, async (c) => {
  const usuario = await usuarioLogado(c);
  try {
    const cadastro = await segundo_fator.iniciar_cadastro(c.get("tx"), usuario.id, usuario.login);
    return _tela(c, usuario, { cadastro });
  } catch (erro) {
    if (!(erro instanceof segundo_fator.SegundoFatorJaLigado)) throw erro;
    return _tela(c, usuario, { erro: erro.message }, 422);
  }
});

rotas.post(`${BASE}/confirmar`, async (c) => {
  const usuario = await usuarioLogado(c);
  const f = await formulario(c);
  const tx = c.get("tx");
  const codigos = await segundo_fator.confirmar_cadastro(tx, usuario, f.texto("codigo"));
  if (!codigos) {
    // o segredo continua o mesmo: a pessoa tenta de novo sem reescanear
    const cadastro = await segundo_fator.cadastro_pendente(tx, usuario.id, usuario.login);
    if (!cadastro) return redirecionar(c, BASE);
    return _tela(c, usuario, { cadastro, erro: "Código inválido ou vencido. Confira o aplicativo e digite o código atual." }, 422);
  }
  return _tela(c, usuario, { codigos, mensagem: "Segundo fator ligado. Guarde os códigos de recuperação abaixo: eles não aparecem de novo." });
});

rotas.post(`${BASE}/desligar`, async (c) => {
  const usuario = await usuarioLogado(c);
  const tx = c.get("tx");
  const f = await formulario(c);
  // desligar pede a senha atual, conferida com o mesmo teto de tentativas da troca de senha
  const recusa = await autenticacao.conferir_senha_atual(tx, usuario.id, f.texto("senha_atual"), {
    usuario,
    ip: ipDoCliente(c),
    user_agent: c.req.header("user-agent") ?? null,
  });
  if (recusa?.bloqueada) {
    deleteCookie(c, autenticacao.COOKIE_SESSAO, { path: "/" });
    return redirecionar(c, "/login");
  }
  if (recusa) return _tela(c, usuario, { erro: recusa.mensagem }, 422);
  await segundo_fator.desligar(tx, usuario, usuario);
  return _tela(c, usuario, { mensagem: "Segundo fator desligado. A entrada volta a pedir só a senha." });
});
