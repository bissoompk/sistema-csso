/**
 * /login, /sair, /primeiro-acesso, /trocar-senha e /quem-sou-eu.
 * Porte de `app/rotas/autenticacao.py`.
 */
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { obterConfig } from "../config.js";
import { cookieSeguro } from "../nucleo/seguranca.js";
import { ErroHttp } from "../nucleo/erros.js";
import { formulario, usuarioLogado, usuarioOpcional, type Formulario } from "../dependencias.js";
import * as autenticacao from "../servicos/autenticacao.js";
import { usuario as tabela_usuario } from "../db/esquema/index.js";
import { pagina, redirecionar } from "../web.js";

export const rotas = new Hono<Ambiente>();

type ComSocket = { incoming?: { socket?: { remoteAddress?: string } } } | undefined;

/**
 * O endereço de quem pediu.
 *
 * No Netlify a função não vê o socket do cliente: o IP vem no cabeçalho
 * `x-nf-client-connection-ip`, que o próprio Netlify escreve na borda. No
 * servidor local (`@hono/node-server`) vem do socket. Nos testes (`app.fetch`
 * sem ambiente) não há nenhum dos dois.
 */
export function ipDoCliente(c: Ctx): string | null {
  const netlify = c.req.header("x-nf-client-connection-ip");
  if (netlify) return netlify;
  const endereco = (c.env as ComSocket)?.incoming?.socket?.remoteAddress;
  return endereco ? endereco.replace(/^::ffff:/, "") : null;
}

/**
 * O primeiro acesso só na própria máquina.
 *
 * DESVIO: na nuvem não existe "a própria máquina" — toda requisição chega pela
 * internet. O critério continua valendo para o servidor local (127.0.0.1) e
 * para os testes (requisição sem socket, o `testclient` do Python). Na nuvem o
 * primeiro superintendente se cria pela linha de comando, ou ligando
 * `CSSO_PRIMEIRO_ACESSO_REMOTO=sim` só durante a implantação. Ver DESVIOS.md.
 */
function _local(c: Ctx): boolean {
  if ((process.env.CSSO_PRIMEIRO_ACESSO_REMOTO ?? "").trim().toLowerCase() === "sim") return true;
  if (c.req.header("x-nf-client-connection-ip")) return false;
  const host = (c.env as ComSocket)?.incoming?.socket?.remoteAddress?.replace(/^::ffff:/, "") ?? "testclient";
  return ["127.0.0.1", "::1", "localhost", "testclient"].includes(host);
}

// O destino padrão depois de entrar é `/inicio`, e não `/`: `/` é o painel de
// Processos SEI e exige `processo.ver`. `/inicio` leva cada um à primeira tela
// que abre para ele.
export const INICIO = "/inicio";

// Os motivos que a tela de login sabe explicar: os dois primeiros vêm de
// `dependencias.destinoDeLogin`; `inatividade`, do aviso de inatividade do
// navegador (csso.js, bloco 12). Qualquer outro valor é ignorado — o parâmetro
// chega pela URL, e URL é entrada: o texto mostrado é sempre um destes.
export const MOTIVOS: Record<string, string> = {
  sessao:
    "Sua sessão expirou. Entre de novo para continuar de onde estava — o " +
    "endereço em que você estava é reaberto depois.",
  envio:
    "Sua sessão expirou antes de o envio ser gravado: o que você tinha " +
    "preenchido não foi salvo. Entre de novo e refaça — a tela de origem é " +
    "reaberta depois.",
  inatividade: "Sua sessão foi encerrada por inatividade.",
};

/**
 * Só caminho DESTE sistema volta do login: `?proximo=https://outro.site` seria
 * redirecionamento aberto. Vale só o que começa com uma barra e não com duas
 * (`//host`) nem com barra invertida (o navegador a normaliza para `/`).
 */
export function destino_seguro(proximo: string | null | undefined): string {
  const p = (proximo ?? "").trim();
  if (!p.startsWith("/") || p.startsWith("//") || p.startsWith("/\\")) return INICIO;
  // O navegador APAGA tab e quebra de linha de qualquer ponto da URL antes de
  // segui-la: `/<TAB>/atacante.example` virava `//atacante.example`. Controle e
  // barra invertida em qualquer posição: volta ao início.
  if (/[\u0000-\u001f\u007f\\]/.test(p)) return INICIO;
  return p;
}

/** Campo obrigatório ausente: o 422 do `Form(...)` do FastAPI. */
function exigidos(f: Formulario, ...nomes: string[]): void {
  const faltando = nomes.filter((n) => typeof f.dados.get(n) !== "string");
  if (faltando.length) throw new ErroHttp(422, `Campo obrigatório ausente: ${faltando.join(", ")}`);
}

rotas.get("/login", async (c) => {
  const tx = c.get("tx");
  if (!(await autenticacao.existe_algum_usuario(tx))) return redirecionar(c, "/primeiro-acesso");
  return pagina(c, "paginas/login.html", null, {
    proximo: destino_seguro(c.req.query("proximo") ?? INICIO),
    // `hasOwn`: `?motivo=toString` acharia o método herdado do objeto
    aviso_sessao: Object.hasOwn(MOTIVOS, c.req.query("motivo") ?? "") ? MOTIVOS[c.req.query("motivo")!] : null,
  });
});

rotas.post("/login", async (c) => {
  const cfg = obterConfig();
  const f = await formulario(c);
  exigidos(f, "login", "senha");
  const login = f.texto("login");
  const senha = f.texto("senha");
  const proximo = f.texto("proximo", INICIO);
  const tx = c.get("tx");
  let conta: autenticacao.Usuario;
  let token: string;
  try {
    [conta, token] = await autenticacao.autenticar(
      tx,
      login.trim(),
      senha,
      ipDoCliente(c),
      c.req.header("user-agent") ?? null,
    );
  } catch (erro) {
    if (!(erro instanceof autenticacao.FalhaDeAutenticacao)) throw erro;
    // O identificador volta; a senha, nunca (iria em claro para o HTML, para o
    // cache do navegador e para o histórico da tela).
    return pagina(c, "paginas/login.html", null, {
      erro: erro.message,
      proximo: destino_seguro(proximo),
      login,
    });
  }

  // o login é a única rota que estabelece identidade sem passar por
  // `usuarioOpcional`: sem isto ele sairia no registro de acesso como `conta=-`
  c.set("conta_id", conta.id);

  const destino = conta.precisa_trocar_senha ? "/trocar-senha" : destino_seguro(proximo);
  setCookie(c, autenticacao.COOKIE_SESSAO, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: cfg.sessaoHoras * 3600,
    // A REQUISIÇÃO decide (esquema da URL), nunca uma configuração de host:
    // cookie `Secure` sem TLS não volta, e a pessoa cairia no login sem aviso.
    secure: cookieSeguro(c.req.url),
  });
  return redirecionar(c, destino);
});

/**
 * Sair é POST (revisão de segurança, 25/09/2026). Como GET, qualquer página da
 * internet derrubava a sessão de quem a abrisse com um `<img src=".../sair">`
 * — o CSRF de logout, que o middleware de origem não alcança porque só confere
 * método que escreve. O GET continua existindo para o link antigo (favorito,
 * o app de bolso de versão anterior): mostra o botão, e só o botão sai.
 */
rotas.post("/sair", async (c) => {
  const token = getCookie(c, autenticacao.COOKIE_SESSAO);
  if (token) await autenticacao.revogar(c.get("tx"), token);
  deleteCookie(c, autenticacao.COOKIE_SESSAO, { path: "/" });
  return redirecionar(c, "/login");
});

rotas.get("/sair", async (c) => {
  const usuario = await usuarioOpcional(c);
  if (!usuario) return redirecionar(c, "/login");
  return pagina(c, "paginas/sair.html", usuario, { sem_casca: true });
});

rotas.get("/primeiro-acesso", async (c) => {
  const tx = c.get("tx");
  if (await autenticacao.existe_algum_usuario(tx)) return redirecionar(c, "/login");
  if (!_local(c)) {
    return pagina(c, "paginas/erro.html", null, {
      titulo: "Indisponível",
      detalhe: "O primeiro acesso só pode ser feito na própria máquina (127.0.0.1).",
      codigo: null,
    });
  }
  return pagina(c, "paginas/primeiro_acesso.html");
});

rotas.post("/primeiro-acesso", async (c) => {
  const tx = c.get("tx");
  const f = await formulario(c);
  exigidos(f, "nome", "email", "senha");
  const nome = f.texto("nome");
  const email = f.texto("email");
  const senha = f.texto("senha");
  const login = f.texto("login");
  if ((await autenticacao.existe_algum_usuario(tx)) || !_local(c)) return redirecionar(c, "/login");
  // a tela não pede mais nome de usuário: a entrada é pelo e-mail. A coluna
  // continua existindo e obrigatória, então sai do próprio e-mail.
  const escolhido = login.trim() || autenticacao.usuario_a_partir_do_email(email);
  try {
    // a senha foi escolhida agora, nesta tela: não é provisória (D28)
    await autenticacao.criar_primeiro_superintendente(tx, escolhido, nome.trim(), email.trim(), senha, {
      precisa_trocar_senha: false,
    });
  } catch (erro) {
    if (!(erro instanceof autenticacao.SenhaRecusada || erro instanceof autenticacao.PrimeiroAcessoRecusado)) {
      throw erro;
    }
    // Devolve o que NÃO é segredo; a senha jamais volta.
    return pagina(c, "paginas/primeiro_acesso.html", null, { erro: erro.message, nome, email, login });
  }
  return redirecionar(c, "/login");
});

/** A tela da troca, com o teto de tentativas que ela anuncia (o mesmo do login). */
function _tela_troca(
  c: Ctx,
  usuario: Awaited<ReturnType<typeof usuarioLogado>>,
  extra: { erro?: string; encerradas?: number } = {},
) {
  return pagina(c, "paginas/trocar_senha.html", usuario, { max_tentativas: obterConfig().maxTentativas, ...extra });
}

/**
 * `?feita=N` é a volta da troca (PRG): a tela confirma e diz quantas outras
 * sessões caíram (D8). Antes a troca ia direto para /inicio, sem aviso, e a
 * pessoa que trocou por desconfiança não sabia se a outra máquina tinha saído.
 * O número vem da URL e só vira texto; quem ainda precisa trocar vê o
 * formulário, digam o que disserem os parâmetros.
 */
rotas.get("/trocar-senha", async (c) => {
  const usuario = await usuarioLogado(c);
  const feita = c.req.query("feita");
  if (feita !== undefined && /^\d{1,4}$/.test(feita) && !usuario.precisa_trocar_senha) {
    return _tela_troca(c, usuario, { encerradas: Number(feita) });
  }
  return _tela_troca(c, usuario);
});

rotas.post("/trocar-senha", async (c) => {
  const usuario = await usuarioLogado(c);
  const tx = c.get("tx");
  const f = await formulario(c);
  exigidos(f, "senha_atual", "nova", "confirmacao");
  const senha_atual = f.texto("senha_atual");
  const nova = f.texto("nova");
  const confirmacao = f.texto("confirmacao");

  const contexto = { usuario, ip: ipDoCliente(c), user_agent: c.req.header("user-agent") ?? null };
  const recusa = await autenticacao.conferir_senha_atual(tx, usuario.id, senha_atual, contexto);
  if (recusa?.bloqueada) {
    // as sessões caíram (a desta também): a próxima tela é o login, com o porquê
    deleteCookie(c, autenticacao.COOKIE_SESSAO, { path: "/" });
    return pagina(c, "paginas/login.html", null, { erro: recusa.mensagem, proximo: INICIO, login: usuario.login });
  }
  if (recusa) return _tela_troca(c, usuario, { erro: recusa.mensagem });
  const [registro] = await tx.select().from(tabela_usuario).where(eq(tabela_usuario.id, usuario.id));
  if (!registro) return _tela_troca(c, usuario, { erro: "Senha atual incorreta." });
  if (nova !== confirmacao) {
    return _tela_troca(c, usuario, { erro: "A confirmação não confere." });
  }
  let encerradas: number;
  try {
    // O cookie da requisição diz "esta sessão é a de quem está trocando": ela
    // sobrevive, todas as outras caem. Sem ele a troca expulsaria a pessoa.
    encerradas = await autenticacao.trocar_senha(
      tx,
      registro,
      nova,
      getCookie(c, autenticacao.COOKIE_SESSAO) ?? null,
      contexto,
    );
  } catch (erro) {
    if (!(erro instanceof autenticacao.SenhaRecusada)) throw erro;
    return _tela_troca(c, usuario, { erro: erro.message });
  }
  return redirecionar(c, `/trocar-senha?feita=${encerradas}`);
});

rotas.get("/quem-sou-eu", async (c) => {
  const atual = await usuarioOpcional(c);
  if (!atual) return c.json({ autenticado: false });
  return c.json({
    autenticado: true,
    login: atual.login,
    nome: atual.nome,
    perfis: [...atual.perfis],
    permissoes: [...atual.permissoes].sort(),
  });
});
