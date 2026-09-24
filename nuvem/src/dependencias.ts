/**
 * Quem está pedindo: sessão do cookie -> usuário -> permissão.
 * Porte de `app/dependencias.py`. Primeira das três camadas de checagem
 * (rota -> serviço -> repositório).
 *
 * No FastAPI isto era injeção de dependência (`UsuarioDep`, `exigir(...)`);
 * aqui são funções que a rota chama no começo:
 *
 *     const usuario = await usuarioLogado(c);
 *     exigir(usuario, "processo.ver");
 */
import { getCookie } from "hono/cookie";
import type { Ctx } from "./nucleo/contexto.js";
import { ErroHttp, RedirecionaParaLogin } from "./nucleo/erros.js";
import * as autenticacao from "./servicos/autenticacao.js";
import { carregar_usuario_atual, type UsuarioAtual } from "./servicos/rbac.js";

export async function usuarioOpcional(c: Ctx): Promise<UsuarioAtual | null> {
  const cache = c.get("usuario_resolvido");
  if (cache !== undefined) return cache;
  const tx = c.get("tx");
  const token = getCookie(c, autenticacao.COOKIE_SESSAO);
  const registro = await autenticacao.sessao_valida(tx, token ?? null);
  let usuario: UsuarioAtual | null = null;
  if (registro) {
    // id numérico, nunca o login (ROPA §6): é o que vai para o log de acesso
    c.set("conta_id", registro.usuario_id);
    try {
      usuario = await carregar_usuario_atual(tx, registro.usuario_id);
    } catch {
      usuario = null;
    }
  }
  c.set("usuario_resolvido", usuario);
  return usuario;
}

/** O `/login?proximo=...` de quem chegou sem sessão — com a query e o motivo. */
export function destinoDeLogin(c: Ctx): string {
  const url = new URL(c.req.url);
  let proximo: string;
  if (c.req.method === "GET" || c.req.method === "HEAD") {
    proximo = url.pathname + url.search;
  } else {
    proximo = "/inicio";
    const referer = c.req.header("referer");
    if (referer) {
      try {
        const r = new URL(referer, url);
        if (r.host === url.host && r.pathname.startsWith("/")) proximo = r.pathname + r.search;
      } catch {
        /* referer torto: volta ao início */
      }
    }
  }
  const params = new URLSearchParams({ proximo });
  if (getCookie(c, autenticacao.COOKIE_SESSAO)) {
    params.set("motivo", c.req.method === "GET" || c.req.method === "HEAD" ? "sessao" : "envio");
  }
  return "/login?" + params.toString().replace(/\+/g, "%20");
}

export async function usuarioLogado(c: Ctx): Promise<UsuarioAtual> {
  const atual = await usuarioOpcional(c);
  if (!atual) throw new RedirecionaParaLogin(destinoDeLogin(c));
  return atual;
}

/** 403 duro quando falta permissão (o `exigir(...)` de rota do Python). */
export function exigir(usuario: UsuarioAtual, ...codigos: string[]): UsuarioAtual {
  for (const codigo of codigos) {
    if (!usuario.pode(codigo)) throw new ErroHttp(403, `Permissão necessária: ${codigo}`);
  }
  return usuario;
}

/** Atalho: logado + permissões. */
export async function usuarioCom(c: Ctx, ...codigos: string[]): Promise<UsuarioAtual> {
  return exigir(await usuarioLogado(c), ...codigos);
}

/**
 * O corpo do formulário como o `Form(...)` do FastAPI o via: campo simples
 * vira string; campo repetido (checkbox, `name="x"` várias vezes) é lido com
 * `todos()`. Arquivo vem como `File`.
 */
export async function formulario(c: Ctx) {
  const tipo = c.req.header("content-type") ?? "";
  const dados =
    tipo.includes("multipart/form-data") || tipo.includes("application/x-www-form-urlencoded")
      ? await c.req.formData()
      : new FormData();
  return {
    dados,
    /** valor de texto (o primeiro), ou `padrao` */
    texto(nome: string, padrao = ""): string {
      const v = dados.get(nome);
      return typeof v === "string" ? v : padrao;
    },
    /** valor opcional: `null` quando ausente ou vazio */
    opcional(nome: string): string | null {
      const v = dados.get(nome);
      return typeof v === "string" && v !== "" ? v : null;
    },
    inteiro(nome: string): number | null {
      const v = dados.get(nome);
      if (typeof v !== "string" || !/^-?\d+$/.test(v.trim())) return null;
      return Number(v.trim());
    },
    todos(nome: string): string[] {
      return dados.getAll(nome).filter((v): v is string => typeof v === "string");
    },
    arquivo(nome: string): File | null {
      const v = dados.get(nome);
      return v instanceof File && v.size > 0 ? v : null;
    },
    arquivos(nome: string): File[] {
      return dados.getAll(nome).filter((v): v is File => v instanceof File && v.size > 0);
    },
    tem(nome: string): boolean {
      return dados.has(nome);
    },
  };
}
export type Formulario = Awaited<ReturnType<typeof formulario>>;
