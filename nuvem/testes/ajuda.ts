/**
 * Ajuda dos testes: banco limpo por arquivo, cliente HTTP com pote de cookies,
 * contas com perfil e login. O `conftest.py` do Python, em TypeScript.
 *
 * Uso (no topo do arquivo de teste — `afterAll` é registrado aqui dentro):
 *
 *     import { bancoLimpo, criarUsuario, entrar } from "./ajuda";
 *     const { db, cliente } = await bancoLimpo();
 *
 *     it("...", async () => {
 *       await criarUsuario(db, { login: "coord", perfis: ["coordenador_csso"] });
 *       await entrar(cliente, "coord");
 *       const r = await cliente.get("/processos");
 *       expect(r.status).toBe(200);
 *     });
 *
 * Cada arquivo ganha um banco `csso_t_<aleatório>` clonado de `csso_modelo`
 * (migrado e semeado pelo `globalSetup`), e o banco é apagado no `afterAll`.
 * Os arquivos rodam em paralelo; os testes DENTRO de um arquivo compartilham o
 * banco — quem precisa de banco virgem por teste chama `bancoLimpo()` de novo
 * dentro do teste (é barato) ou usa `contas()` com logins únicos.
 */
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { MODELO, urlServidor } from "./modelo.js";
import { redefinirConfig } from "../src/config.js";
import { fecharBanco, obterBanco, type Banco, type Executor } from "../src/db/cliente.js";
import * as esquema from "../src/db/esquema/index.js";
import * as autenticacao from "../src/servicos/autenticacao.js";
import { carregar_usuario_atual, type UsuarioAtual } from "../src/servicos/rbac.js";
import { obterApp } from "../src/app.js";
import type { Ambiente } from "../src/nucleo/contexto.js";

// O custo do Argon2id pelo mínimo, só dentro da suíte (o `_argon2_barato` do
// conftest). Continua Argon2id de verdade, com sal aleatório; `verify` lê os
// parâmetros do próprio hash. `PARAMETROS_ARGON2_PRODUCAO` não é tocado — há
// teste amarrado nele.
autenticacao._definir_parametros({ time_cost: 1, memory_cost: 8, parallelism: 1 });

export const SENHA_TESTE = "SenhaDeTeste2026";
export const ORIGEM = "http://testserver";
/** o `BodyInit` do DOM, que o `lib` deste projeto (só Node) não declara */
type Corpo = RequestInit["body"];

// =====================================================================
// Banco
// =====================================================================
async function comAdmin<T>(f: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const admin = postgres(urlServidor(), { max: 1, prepare: false, onnotice: () => {} });
  try {
    return await f(admin);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

/** Clona o modelo. Clones simultâneos do mesmo modelo podem colidir: tenta de novo. */
async function clonarModelo(nome: string): Promise<void> {
  for (let tentativa = 0; ; tentativa++) {
    try {
      await comAdmin((sql) => sql.unsafe(`CREATE DATABASE ${nome} TEMPLATE ${MODELO}`));
      return;
    } catch (erro) {
      const msg = String((erro as Error).message);
      if (tentativa < 20 && msg.includes("being accessed by other users")) {
        await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
        continue;
      }
      throw erro;
    }
  }
}

export interface AmbienteDeTeste {
  /** o banco (Drizzle) do arquivo */
  db: Banco;
  /** o app Hono (o mesmo que a função do Netlify serve) */
  app: Hono<Ambiente>;
  /** um cliente com pote de cookies próprio */
  cliente: Cliente;
  /** fábrica de clientes novos (outra "aba anônima"); `origem` para https */
  novoCliente: (origem?: string) => Cliente;
  nome: string;
  url: string;
}

let _atual: string | null = null;

/**
 * Banco novo clonado do modelo; aponta `DATABASE_URL` e o cliente do Drizzle
 * para ele. Chamado de novo, troca de banco (o anterior é apagado no fim).
 */
export async function bancoLimpo(): Promise<AmbienteDeTeste> {
  const nome = `csso_t_${(process.env.CSSO_MODELO ?? "csso_modelo").replace(/^csso_modelo_?/, "")}_${randomBytes(6).toString("hex")}`;
  await clonarModelo(nome);
  const url = urlServidor(nome);
  await fecharBanco();
  process.env.DATABASE_URL = url;
  redefinirConfig();
  const db = obterBanco(url);
  const primeiro = _atual === null;
  _atual = nome;
  const criados = [nome];
  if (primeiro) {
    try {
      afterAll(async () => {
        await fecharBanco();
        for (const n of _todos) {
          await comAdmin((sql) => sql.unsafe(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`)).catch(() => {});
        }
        // arquivo com banco novo por teste chega a dezenas de clones, e cada
        // DROP ... FORCE custa ~1 s com outras suítes rodando: 60 s não bastam
      }, 600_000);
    } catch {
      // chamado fora da coleta (dentro de um teste): o afterAll já foi
      // registrado pela primeira chamada, ou quem chamou limpa por conta própria
    }
  }
  _todos.push(...criados);
  const app = obterApp();
  return { db, app, cliente: new Cliente(app), novoCliente: (origem?: string) => new Cliente(app, origem), nome, url };
}
const _todos: string[] = [];

/** Roda `f` numa transação curta e confirma (o `with mod_banco.sessao() as s: ...; s.commit()`). */
export async function naTransacao<T>(f: (tx: Executor) => Promise<T>): Promise<T> {
  return obterBanco().transaction(async (tx) => f(tx));
}

// =====================================================================
// Cliente HTTP com pote de cookies
// =====================================================================
export type Campos = Record<string, string | number | boolean | null | undefined | (string | number)[] | File | Blob>;

export interface Opcoes {
  /** seguir redirecionamentos (padrão: sim, como o TestClient do Starlette) */
  seguir?: boolean;
  cabecalhos?: Record<string, string>;
  /** força multipart/form-data (padrão: só quando algum campo é arquivo) */
  multipart?: boolean;
}

export class Resposta {
  constructor(
    readonly status: number,
    readonly headers: Headers,
    readonly text: string,
    /** a URL (caminho + query) que produziu esta resposta, depois dos redirecionamentos */
    readonly url: string,
    /** os status dos redirecionamentos seguidos, na ordem */
    readonly historico: number[],
  ) {}
  get location(): string | null {
    return this.headers.get("location");
  }
  json<T = any>(): T {
    return JSON.parse(this.text) as T;
  }
  cabecalho(nome: string): string | null {
    return this.headers.get(nome);
  }
}

export class Cliente {
  /** nome -> valor */
  readonly cookies = new Map<string, string>();
  /** cabeçalhos mandados em toda requisição */
  readonly padrao: Record<string, string> = {};

  /** `origem`: `https://testserver` para o cliente que chega por TLS */
  constructor(
    private readonly app: Hono<Ambiente>,
    readonly origem: string = ORIGEM,
  ) {}

  private guardarCookies(res: Response): void {
    for (const linha of res.headers.getSetCookie()) {
      const [par, ...atributos] = linha.split(";");
      const i = par!.indexOf("=");
      const nome = par!.slice(0, i).trim();
      const valor = par!.slice(i + 1).trim();
      const attrs = atributos.map((a) => a.trim().toLowerCase());
      const expirou =
        attrs.some((a) => a === "max-age=0" || a.startsWith("max-age=-")) ||
        attrs.some((a) => a.startsWith("expires=") && new Date(a.slice(8)).getTime() < Date.now()) ||
        valor === "";
      if (expirou) this.cookies.delete(nome);
      else this.cookies.set(nome, decodeURIComponent(valor));
    }
  }

  private cabecalhoCookie(): string | null {
    if (!this.cookies.size) return null;
    return [...this.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
  }

  async requisitar(
    metodo: string,
    caminho: string,
    corpo: Corpo = null,
    opcoes: Opcoes & { tipo?: string } = {},
  ): Promise<Resposta> {
    const seguir = opcoes.seguir ?? true;
    const historico: number[] = [];
    let url = caminho;
    let met = metodo;
    let body: Corpo = corpo;
    let tipo = opcoes.tipo;
    for (let saltos = 0; saltos < 20; saltos++) {
      const cabecalhos = new Headers({ ...this.padrao, ...(opcoes.cabecalhos ?? {}) });
      if (tipo) cabecalhos.set("content-type", tipo);
      const cookie = this.cabecalhoCookie();
      if (cookie) cabecalhos.set("cookie", cookie);
      const req = new Request(new URL(url, this.origem), { method: met, headers: cabecalhos, body });
      const res = await this.app.fetch(req);
      this.guardarCookies(res);
      const texto = await res.text();
      const destino = res.headers.get("location");
      if (seguir && destino && [301, 302, 303, 307, 308].includes(res.status)) {
        historico.push(res.status);
        const proximo = new URL(destino, new URL(url, this.origem));
        url = proximo.pathname + proximo.search;
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && met !== "GET")) {
          met = "GET";
          body = null;
          tipo = undefined;
        }
        continue;
      }
      return new Resposta(res.status, res.headers, texto, url, historico);
    }
    throw new Error("redirecionamentos demais");
  }

  get(caminho: string, opcoes: Opcoes = {}): Promise<Resposta> {
    return this.requisitar("GET", caminho, null, opcoes);
  }

  /** POST de formulário: urlencoded, ou multipart quando há arquivo (ou `multipart: true`). */
  post(caminho: string, campos: Campos = {}, opcoes: Opcoes = {}): Promise<Resposta> {
    const temArquivo = Object.values(campos).some((v) => v instanceof Blob);
    if (opcoes.multipart || temArquivo) {
      const fd = new FormData();
      for (const [k, v] of Object.entries(campos)) {
        if (v === null || v === undefined) continue;
        if (Array.isArray(v)) for (const x of v) fd.append(k, String(x));
        else if (v instanceof Blob) fd.append(k, v, v instanceof File ? v.name : "arquivo");
        else fd.append(k, String(v));
      }
      // sem content-type: o Request põe o multipart com o boundary
      return this.requisitar("POST", caminho, fd, opcoes);
    }
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(campos)) {
      if (v === null || v === undefined) continue;
      if (Array.isArray(v)) for (const x of v) p.append(k, String(x));
      else p.append(k, String(v));
    }
    return this.requisitar("POST", caminho, p.toString(), { ...opcoes, tipo: "application/x-www-form-urlencoded" });
  }

  /** POST com corpo JSON (a `/api/v1`). */
  postJson(caminho: string, dados: unknown, opcoes: Opcoes = {}): Promise<Resposta> {
    return this.requisitar("POST", caminho, JSON.stringify(dados), { ...opcoes, tipo: "application/json" });
  }

  /** Qualquer método com corpo cru. */
  enviar(metodo: string, caminho: string, corpo: Corpo = null, opcoes: Opcoes & { tipo?: string } = {}) {
    return this.requisitar(metodo, caminho, corpo, opcoes);
  }
}

// =====================================================================
// Contas
// =====================================================================
export interface NovaConta {
  login: string;
  perfis?: string[];
  nome?: string;
  email?: string;
  senha?: string;
  precisa_trocar_senha?: boolean;
  servidor_id?: number | null;
  ativo?: boolean;
  campus_id?: number | null;
  vigencia_inicio?: string;
  vigencia_fim?: string | null;
}

/** Cria a conta e as atribuições (vigentes desde 2020). Devolve o registro do usuário. */
export async function criarUsuario(db: Executor, c: NovaConta) {
  const [conta] = await db
    .insert(esquema.usuario)
    .values({
      login: c.login,
      nome: c.nome ?? c.login,
      email: c.email ?? `${c.login}@teste.ufvjm.edu.br`,
      senha_hash: await autenticacao.gerar_hash(c.senha ?? SENHA_TESTE),
      precisa_trocar_senha: c.precisa_trocar_senha ?? false,
      servidor_id: c.servidor_id ?? null,
      ativo: c.ativo ?? true,
    })
    .returning();
  for (const codigo of c.perfis ?? []) {
    const [perfil] = await db.select().from(esquema.perfil).where(eq(esquema.perfil.codigo, codigo));
    if (!perfil) throw new Error(`perfil inexistente: ${codigo}`);
    await db.insert(esquema.atribuicao).values({
      usuario_id: conta!.id,
      perfil_id: perfil.id,
      campus_id: c.campus_id ?? null,
      vigencia_inicio: c.vigencia_inicio ?? "2020-01-01",
      vigencia_fim: c.vigencia_fim ?? null,
      ato_normativo: "Ato de teste",
    });
  }
  return conta!;
}

/** Os perfis do fixture `contas` do Python, com o nome de cada conta. */
export const PERFIS_DE_TESTE: readonly (readonly [string, string])[] = [
  ["coordenador_csso", "Coordenador de Teste"],
  ["tecnico_seguranca", "Técnica de Teste"],
  ["secretaria_csso", "Secretaria de Teste"],
  ["auditor_interno", "Auditor de Teste"],
  ["superintendente", "Superintendente de Teste"],
  ["admin_ti", "Admin TI de Teste"],
  ["consulta_progep", "PROGEP de Teste"],
  ["servidor_consulta", "Servidor de Teste"],
  ["engenheiro_seguranca", "Engenheiro de Teste"],
  ["medico_trabalho", "Médico de Teste"],
  ["almoxarife_sesmt", "Almoxarife de Teste"],
];

/**
 * O fixture `contas` do Python: uma conta por perfil, com login = código do
 * perfil e senha `SENHA_TESTE`; o coordenador recebe a habilitação técnica
 * semeada (Fabrício). Devolve `{perfil: [login, senha]}`.
 *
 * Idempotente dentro do mesmo banco: quem já existe não é recriado.
 */
export async function contas(db: Executor): Promise<Record<string, [string, string]>> {
  const criadas: Record<string, [string, string]> = {};
  for (const [codigo, nome] of PERFIS_DE_TESTE) {
    const [existe] = await db.select().from(esquema.usuario).where(eq(esquema.usuario.login, codigo));
    if (!existe) await criarUsuario(db, { login: codigo, nome, perfis: [codigo] });
    criadas[codigo] = [codigo, SENHA_TESTE];
  }
  const [coord] = await db.select().from(esquema.usuario).where(eq(esquema.usuario.login, "coordenador_csso"));
  await db
    .update(esquema.profissional_habilitado)
    .set({ usuario_id: coord!.id })
    .where(eq(esquema.profissional_habilitado.nome, "Fabrício Raimundi Andrade"));
  return criadas;
}

/** POST /login sem seguir; exige o 303 (o `entrar` do conftest). */
export async function entrar(cliente: Cliente, login: string, senha = SENHA_TESTE): Promise<Cliente> {
  const r = await cliente.post("/login", { login, senha }, { seguir: false });
  if (r.status !== 303) throw new Error(`login de ${login} falhou: ${r.status}\n${r.text.slice(0, 500)}`);
  return cliente;
}

/** A identidade resolvida de uma conta (o `UsuarioAtual` que as rotas recebem). */
export async function usuarioAtual(db: Executor, login: string): Promise<UsuarioAtual> {
  const [conta] = await db.select().from(esquema.usuario).where(eq(esquema.usuario.login, login));
  if (!conta) throw new Error(`conta inexistente: ${login}`);
  return carregar_usuario_atual(db, conta.id);
}
