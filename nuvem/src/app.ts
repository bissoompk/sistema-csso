/**
 * A aplicação: o `principal.py` do sistema na nuvem.
 *
 * Um único app Hono atende tudo — telas, fragmentos HTMX e a `/api/v1` — e
 * roda dentro de UMA função do Netlify (`netlify/functions/csso.mts`). Os
 * arquivos estáticos (`/estaticos/...`) não passam por aqui em produção: o
 * Netlify os serve direto do CDN, a partir de `public/`.
 */
import { Hono } from "hono";
import type { Ambiente, Ctx } from "./nucleo/contexto.js";
import { cabecalhos, novoNonce } from "./nucleo/seguranca.js";
import { ErroHttp, PermissaoNegada, RecusaDaApi, RedirecionaParaLogin } from "./nucleo/erros.js";
import { obterBanco } from "./db/cliente.js";
import { pagina } from "./web.js";
import { usuarioOpcional } from "./dependencias.js";
import { ROTAS } from "./rotas/index.js";

/** Lançado de propósito para a transação desfazer: não é erro. */
class Desfeita extends Error {}

function pedeJson(c: Ctx): boolean {
  return new URL(c.req.url).pathname.startsWith("/api/");
}
function querHtml(c: Ctx): boolean {
  return (c.req.header("accept") ?? "").includes("text/html");
}

/**
 * A tela de erro é tela: sai com a lateral, o menu e o caminho de volta.
 * A transação da requisição pode já estar desfeita; o usuário é resolvido de
 * novo numa leitura curta, e falhar aqui devolve a tela sem casca.
 */
async function telaDeErro(c: Ctx, titulo: string, detalhe: string, codigo: string | null, status: number) {
  let usuario = null;
  try {
    const cache = c.get("usuario_resolvido");
    if (cache !== undefined) {
      usuario = cache;
    } else {
      // A transação da requisição ainda está aberta aqui (o `onError` e o
      // `notFound` rodam dentro do middleware que a abriu): pedir OUTRA ao
      // banco com `CSSO_POOL_MAX=1` — o padrão da função do Netlify — travava
      // para sempre esperando a conexão que a própria requisição segura. Lê-se
      // num SAVEPOINT da transação corrente; se ela já estiver abortada (erro
      // de SQL), o savepoint falha e a tela sai sem casca, como previsto.
      const atual = c.get("tx");
      usuario = atual
        ? await atual.transaction(async (sp) => {
            c.set("tx", sp);
            try {
              return await usuarioOpcional(c);
            } finally {
              c.set("tx", atual);
            }
          })
        : await obterBanco().transaction(async (tx) => {
            c.set("tx", tx);
            return usuarioOpcional(c);
          });
    }
  } catch {
    usuario = null;
  }
  // o sino roda sobre `c.get('tx')`; fora da transação ele falha em silêncio
  return pagina(c, "paginas/erro.html", usuario, { titulo, detalhe, codigo }, status);
}

export function criarApp(): Hono<Ambiente> {
  const app = new Hono<Ambiente>();

  // Cabeçalhos de segurança + nonce da CSP, em TODA resposta.
  app.use("*", async (c, next) => {
    const nonce = novoNonce();
    c.set("nonce", nonce);
    await next();
    const https = c.req.url.startsWith("https:");
    for (const [nome, valor] of cabecalhos(nonce, https)) {
      if (!c.res.headers.has(nome)) c.res.headers.set(nome, valor);
    }
  });

  // A transação da requisição: COMMIT no retorno normal, ROLLBACK quando a
  // rota lança (ou pede `desfazer`). É o `obter_sessao` do Python.
  app.use("*", async (c, next) => {
    const caminho = new URL(c.req.url).pathname;
    if (caminho.startsWith("/estaticos/")) return next();
    try {
      await obterBanco().transaction(async (tx) => {
        c.set("tx", tx);
        await next();
        if (c.error || c.get("desfazer")) throw new Desfeita();
      });
    } catch (erro) {
      if (!(erro instanceof Desfeita)) throw erro;
    }
  });

  for (const rotas of ROTAS) app.route("/", rotas);

  app.notFound(async (c) => {
    if (querHtml(c)) return telaDeErro(c as Ctx, "404 — não encontrado", "Not Found", null, 404);
    return c.json({ detail: "Not Found" }, 404);
  });

  app.onError(async (erro, c0) => {
    const c = c0 as Ctx;
    if (erro instanceof RedirecionaParaLogin) {
      if (pedeJson(c)) {
        return c.json({ erro: "Sessão ausente ou expirada: entre pelo /login.", motivos: [] }, 401);
      }
      return c.redirect(erro.destino, 303);
    }
    if (erro instanceof RecusaDaApi) {
      return c.json({ erro: erro.erro, motivos: erro.motivos }, erro.status as any);
    }
    if (erro instanceof PermissaoNegada) {
      if (pedeJson(c)) {
        return c.json({ erro: erro.message, motivos: [`permissão exigida: ${erro.codigo}`] }, 403);
      }
      return telaDeErro(c, "403 — acesso negado", erro.message, erro.codigo, 403);
    }
    if (erro instanceof ErroHttp) {
      if (querHtml(c) && (erro.status === 401 || erro.status === 403)) {
        return telaDeErro(c, `${erro.status} — acesso negado`, erro.detalhe, null, erro.status);
      }
      if (querHtml(c) && erro.status === 404) {
        return telaDeErro(c, "404 — não encontrado", erro.detalhe, null, 404);
      }
      if (querHtml(c) && erro.status === 422) {
        return telaDeErro(c, "422 — formulário incompleto", erro.detalhe, null, 422);
      }
      return c.json({ detail: erro.detalhe }, erro.status as any);
    }
    console.error("erro nao tratado", erro);
    if (pedeJson(c)) return c.json({ erro: "Erro interno.", motivos: [] }, 500);
    return telaDeErro(
      c,
      "500 — erro interno",
      "Algo deu errado do nosso lado. Nada do que você enviou foi gravado.",
      null,
      500,
    );
  });

  return app;
}

let _app: Hono<Ambiente> | null = null;
export function obterApp(): Hono<Ambiente> {
  if (!_app) _app = criarApp();
  return _app;
}
