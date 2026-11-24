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
import { cabecalhos, novoNonce, origemCruzada, resumoDoErro } from "./nucleo/seguranca.js";
import { ErroHttp, PermissaoNegada, RecusaDaApi, RedirecionaParaLogin } from "./nucleo/erros.js";
import { obterBanco, type Tx } from "./db/cliente.js";
import { instalarRegistroDeAcesso } from "./servicos/registro_acesso.js";
import * as recado from "./nucleo/recado.js";
import * as csrf from "./nucleo/csrf.js";
import { getCookie } from "hono/cookie";
import { COOKIE_SESSAO } from "./servicos/autenticacao.js";
import { pagina } from "./web.js";
import { usuarioOpcional } from "./dependencias.js";
import { ROTAS } from "./rotas/index.js";

/** Lançado de propósito para a transação desfazer: não é erro. */
class Desfeita extends Error {}

function pedeJson(c: Ctx): boolean {
  return new URL(c.req.url).pathname.startsWith("/api/");
}
/**
 * A resposta de erro sai como tela, e não como `{"detail": ...}`, quando quem
 * pediu é um navegador NAVEGANDO: `Accept` com `text/html`, ou o `*\/*` de um
 * link aberto de fora (o leitor de PDF, o app de e-mail, o favorito antigo —
 * M85: /pareceres/2/docx e /processos/1 mostravam JSON cru ao servidor).
 * O `*\/*` só conta num GET sem HX-Request nem X-Requested-With e fora de
 * /api: o HTMX e o `fetch` do quadro leem a resposta como fragmento, e a API
 * responde JSON sempre.
 */
function querHtml(c: Ctx): boolean {
  const aceita = c.req.header("accept") ?? "";
  if (aceita.includes("text/html")) return true;
  if (!aceita.includes("*/*") || c.req.method !== "GET" || pedeJson(c)) return false;
  return !c.req.header("hx-request") && !c.req.header("x-requested-with");
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

  // Registro de acesso (porte de `app/registro_acesso.py`): o mais externo,
  // para medir a requisição inteira e ver o status que de fato saiu.
  instalarRegistroDeAcesso(app);

  // O recado do redirecionamento vai em cookie assinado, e não na URL (`nucleo/recado.ts`):
  // `?mensagem=`/`?erro=` digitados no endereço não aparecem na tela.
  app.use("*", async (c, next) => {
    const { req, consumido } = recado.na_chegada(c.req.raw);
    if (req !== c.req.raw) c.req.raw = req;
    await next();
    const saida = recado.na_saida(req, c.res, consumido);
    if (saida !== c.res) {
      // o setter de `c.res` copia os cabeçalhos da resposta anterior por cima da nova
      // (o Location antigo voltaria): zera antes de trocar
      c.res = undefined as never;
      c.res = saida;
    }
  });

  // Cabeçalhos de segurança + nonce da CSP, em TODA resposta.
  app.use("*", async (c, next) => {
    const nonce = novoNonce();
    c.set("nonce", nonce);
    await next();
    const https = c.req.url.startsWith("https:");
    for (const [nome, valor] of cabecalhos(nonce, https)) {
      if (!c.res.headers.has(nome)) c.res.headers.set(nome, valor);
    }
    // Tela HTML não fica no cache nem no "voltar" do navegador: depois do
    // «sair», a seta de voltar reabria a tela protegida da pessoa anterior.
    if (!c.res.headers.has("cache-control") && (c.res.headers.get("content-type") ?? "").startsWith("text/html")) {
      c.res.headers.set("cache-control", "no-store");
    }
  });

  // CSRF: método que escreve vindo de outra origem é recusado antes de tocar
  // no banco (`origemCruzada` explica por que o SameSite=Lax não basta).
  app.use("*", async (c, next) => {
    if (origemCruzada(c.req.method, c.req.url, (n) => c.req.header(n))) {
      const recusa = "Pedido recusado: veio de outra origem (proteção contra CSRF).";
      if (pedeJson(c as Ctx)) return c.json({ erro: recusa, motivos: ["origem cruzada"] }, 403);
      return c.text(recusa, 403);
    }
    return next();
  });

  // A API escreve só com JSON (24/11/2026): formulário e `text/plain` são o que outro site
  // consegue disparar sem pré-checagem, e o leitor de JSON não olha o Content-Type. A recusa vem
  // antes do token CSRF, de que a API não precisa (o JSON passa pelo CORS, que não é liberado).
  app.use("/api/*", async (c, next) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) {
      const tipo = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (tipo !== "application/json") {
        return c.json(
          { erro: "A API só aceita envio em JSON.", motivos: ["Content-Type: application/json obrigatório"] },
          415,
        );
      }
    }
    return next();
  });

  // CSRF, segunda camada (`nucleo/csrf.ts`): com sessão, o formulário traz o token da sessão; e
  // todo HTML de quem tem sessão sai com o token posto nos formulários e no htmx.
  app.use("*", async (c, next) => {
    const sessao = getCookie(c, COOKIE_SESSAO) ?? "";
    if (sessao && csrf.exige_token(c.req.method, c.req.header("content-type"))) {
      let enviado = c.req.header(csrf.CABECALHO_CSRF) ?? null;
      const tipo = c.req.header("content-type") ?? "";
      if (!enviado && (tipo.includes("form-urlencoded") || tipo.includes("multipart/form-data"))) {
        try {
          const v = (await c.req.formData()).get(csrf.CAMPO_CSRF);
          enviado = typeof v === "string" ? v : null;
        } catch {
          enviado = null;
        }
      }
      if (!csrf.confere(sessao, enviado)) {
        const recusa =
          "Pedido recusado: a página estava desatualizada (proteção contra CSRF). " +
          "Recarregue a página e envie de novo — se você entrou de novo em outra aba, é isso.";
        if (pedeJson(c as Ctx)) return c.json({ erro: recusa, motivos: ["token CSRF ausente ou inválido"] }, 403);
        return c.text(recusa, 403);
      }
    }
    await next();
    const tipo_saida = c.res.headers.get("content-type") ?? "";
    if (sessao && tipo_saida.startsWith("text/html") && c.res.body) {
      const html = await c.res.text();
      const headers = new Headers(c.res.headers);
      headers.delete("content-length");
      const nova = new Response(csrf.injetar(html, csrf.token_da_sessao(sessao)), { status: c.res.status, headers });
      // o setter de `c.res` mistura os cabeçalhos da resposta anterior: zera antes
      c.res = undefined as never;
      c.res = nova;
    }
  });

  // A transação da requisição: COMMIT no retorno normal, ROLLBACK quando a
  // rota lança (ou pede `desfazer`). É o `obter_sessao` do Python.
  app.use("*", async (c, next) => {
    const caminho = new URL(c.req.url).pathname;
    if (caminho.startsWith("/estaticos/")) return next();
    // Leitura (GET/HEAD) corre sem BEGIN/COMMIT: com a função num continente e
    // o banco em outro, são duas idas a mais (~300 ms) por tela, e ler não
    // tem o que desfazer. Quem escreve segue na transação da requisição.
    if (c.req.method === "GET" || c.req.method === "HEAD") {
      c.set("tx", obterBanco() as unknown as Tx);
      await next();
      if (c.error || c.get("desfazer")) return;
    } else try {
      await obterBanco().transaction(async (tx) => {
        c.set("tx", tx);
        await next();
        if (c.error || c.get("desfazer")) throw new Desfeita();
      });
    } catch (erro) {
      if (!(erro instanceof Desfeita)) throw erro;
      return;
    }
    // gravou: o que esperava o COMMIT (`depoisDoCommit`) roda agora
    for (const f of c.get("depois_do_commit") ?? []) {
      try {
        await f();
      } catch (falha) {
        console.error("depois do commit falhou", resumoDoErro(falha));
      }
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
    // Texto maior que a coluna (22001) ou número fora do limite (22003): quem
    // digitou erra, e não "algo do nosso lado". Os formulários dos catálogos
    // não limitavam o tamanho, e uma sigla de campus longa virava "500 — erro
    // interno" sem dizer qual campo (teste de configurações, 26/10/2026).
    const codigo_pg = (erro as { code?: string }).code ?? (erro as { cause?: { code?: string } }).cause?.code;
    if (codigo_pg === "22001" || codigo_pg === "22003") {
      const detalhe =
        codigo_pg === "22001"
          ? "Um dos campos passa do tamanho permitido. Encurte o texto e envie de novo; nada foi gravado."
          : "Um dos números está fora do limite permitido. Confira o valor e envie de novo; nada foi gravado.";
      if (pedeJson(c)) return c.json({ erro: detalhe, motivos: [] }, 422);
      return telaDeErro(c, "422 — formulário incompleto", detalhe, null, 422);
    }
    // Registro que já existe (23505): reenvio do formulário, clique duplo ou
    // duas pessoas gravando ao mesmo tempo. A transação foi desfeita; quem
    // enviou precisa saber que o outro envio valeu, e não ler "erro interno".
    if (codigo_pg === "23505") {
      const detalhe =
        "Este registro já existe — provavelmente o envio anterior já valeu (formulário enviado duas vezes, ou outra pessoa gravou ao mesmo tempo). Atualize a página para conferir; este envio não gravou nada.";
      if (pedeJson(c)) return c.json({ erro: detalhe, motivos: [] }, 409);
      return telaDeErro(c, "409 — já existe", detalhe, null, 409);
    }
    // `resumoDoErro`: sem os valores da consulta nem o `detail` do Postgres —
    // o log do Netlify não é lugar de dado pessoal
    console.error("erro nao tratado", resumoDoErro(erro));
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
