/**
 * Cabeçalhos de segurança, CSP com nonce, o `Secure` do cookie e a tela de
 * erro com a casca. Porte de `test_rede_do_setor.py` (T-2, C-1/C-2) e de
 * `test_web_fluxo.py` (403/404 com a casca).
 *
 * Fora daqui: o registro de acesso (L-1/L-2) e `exportar-tudo` (K-2) são de
 * outros trechos; `/estaticos/*` não passa pelo app na nuvem (o CDN do Netlify
 * serve `public/`), então o caso do estático sai da lista de caminhos.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { redefinirConfig } from "../src/config.js";
import { bancoLimpo, contas, entrar, SENHA_TESTE, type Resposta } from "./ajuda";

const { db, novoCliente } = await bancoLimpo();
await contas(db);

const CABECALHOS = ["content-security-policy", "x-content-type-options", "referrer-policy", "x-frame-options"];
const CASCA = '<aside class="lateral">';

function cookieDeSessao(r: Resposta): string {
  const achado = r.headers.getSetCookie().find((c) => c.startsWith("csso_sessao="));
  if (!achado) throw new Error("nenhum cookie de sessão");
  return achado;
}

async function comCookieSeguro<T>(valor: string, f: () => Promise<T>): Promise<T> {
  const antes = process.env.CSSO_COOKIE_SEGURO;
  process.env.CSSO_COOKIE_SEGURO = valor;
  redefinirConfig();
  try {
    return await f();
  } finally {
    process.env.CSSO_COOKIE_SEGURO = antes;
    redefinirConfig();
  }
}

describe("o Secure do cookie sai da conexão (T-2)", () => {
  it("não sai Secure por http", async () => {
    const r = await novoCliente().post("/login", { login: "coordenador_csso", senha: SENHA_TESTE }, { seguir: false });
    expect(r.status).toBe(303);
    const c = cookieDeSessao(r);
    expect(c).not.toContain("Secure");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Path=/");
    expect(c).toContain("Max-Age=43200");
  });

  it("sai Secure por https", async () => {
    const r = await novoCliente("https://testserver").post(
      "/login",
      { login: "coordenador_csso", senha: SENHA_TESTE },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    expect(cookieDeSessao(r)).toContain("Secure");
  });

  it("e a sessão vale na requisição seguinte, por http", async () => {
    const cliente = novoCliente();
    await entrar(cliente, "coordenador_csso");
    expect((await cliente.get("/inicio", { seguir: false })).status).toBe(303);
    expect((await cliente.get("/modulos")).status).toBe(200);
  });

  it("o cookie de módulo segue a mesma decisão", async () => {
    for (const [origem, secure] of [
      ["http://testserver", false],
      ["https://testserver", true],
    ] as const) {
      const cliente = novoCliente(origem);
      await entrar(cliente, "coordenador_csso");
      // tela de módulo (a de erro também é tela, com a casca): grava a origem
      const r = await cliente.get("/processos/999999", { cabecalhos: { accept: "text/html" } });
      const modulo = r.headers.getSetCookie().find((c) => c.startsWith("csso_modulo="));
      expect(modulo, origem).toBeDefined();
      expect(modulo!.includes("Secure"), origem).toBe(secure);
      expect(cliente.cookies.get("csso_modulo")).toBe("processos-sei");
    }
  });

  it("CSSO_COOKIE_SEGURO=sim força Secure mesmo sem TLS", async () => {
    await comCookieSeguro("sim", async () => {
      const r = await novoCliente().post("/login", { login: "coordenador_csso", senha: SENHA_TESTE }, { seguir: false });
      expect(cookieDeSessao(r)).toContain("Secure");
    });
  });

  it("CSSO_COOKIE_SEGURO=nao desliga mesmo com TLS", async () => {
    await comCookieSeguro("nao", async () => {
      const r = await novoCliente("https://testserver").post(
        "/login",
        { login: "coordenador_csso", senha: SENHA_TESTE },
        { seguir: false },
      );
      expect(cookieDeSessao(r)).not.toContain("Secure");
    });
  });

  it("sair apaga o cookie de sessão", async () => {
    const cliente = novoCliente();
    await entrar(cliente, "coordenador_csso");
    const r = await cliente.get("/sair", { seguir: false });
    expect(r.location).toBe("/login");
    const c = cookieDeSessao(r);
    expect(c).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
    expect(cliente.cookies.has("csso_sessao")).toBe(false);
  });
});

describe("cabeçalhos e CSP (C-1/C-2)", () => {
  it.each(["/login", "/saude"])("cabeçalhos de segurança em %s", async (caminho) => {
    const r = await novoCliente().get(caminho);
    expect(r.status, caminho).toBe(200);
    for (const nome of CABECALHOS) expect(r.headers.has(nome), `${caminho} sem ${nome}`).toBe(true);
    expect(r.cabecalho("x-content-type-options")).toBe("nosniff");
    expect(r.cabecalho("x-frame-options")).toBe("DENY");
    expect(r.cabecalho("referrer-policy")).toBe("same-origin");
  });

  it("cabeçalhos também na tela de erro", async () => {
    const cliente = novoCliente();
    await entrar(cliente, "secretaria_csso");
    const r = await cliente.get("/saude/db", { cabecalhos: { accept: "text/html" } });
    expect(r.status).toBe(403);
    for (const nome of CABECALHOS) expect(r.headers.has(nome)).toBe(true);
  });

  it("a CSP não afrouxa o script", async () => {
    const csp = (await novoCliente().get("/login")).cabecalho("content-security-policy")!;
    const diretivas = Object.fromEntries(
      csp
        .split(";")
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => {
          const i = p.indexOf(" ");
          return i < 0 ? [p, ""] : [p.slice(0, i), p.slice(i + 1)];
        }),
    );
    expect(diretivas["script-src"]).not.toContain("'unsafe-inline'");
    expect(diretivas["script-src"]).not.toContain("'unsafe-eval'");
    expect(diretivas["script-src"]!.startsWith("'self' 'nonce-")).toBe(true);
    expect(diretivas["default-src"]).toBe("'self'");
    expect(diretivas["frame-ancestors"]).toBe("'none'");
    expect(diretivas["base-uri"]).toBe("'none'");
    expect(diretivas["object-src"]).toBe("'none'");
    expect(diretivas["form-action"]).toBe("'self'");
    expect(diretivas["style-src"]).toContain("'unsafe-inline'");
    expect(diretivas["style-src-elem"]).toBe("'self'");
  });

  it("HSTS só existe quando há https", async () => {
    expect((await novoCliente().get("/saude")).headers.has("strict-transport-security")).toBe(false);
    expect((await novoCliente("https://testserver").get("/saude")).headers.has("strict-transport-security")).toBe(true);
  });

  it("o nonce muda a cada resposta", async () => {
    const cliente = novoCliente();
    const marcas = new Set<string>();
    for (let i = 0; i < 3; i++) marcas.add((await cliente.get("/login")).cabecalho("content-security-policy")!);
    expect(marcas.size).toBe(3);
  });

  it.each(["/login", "/trocar-senha", "/modulos"])("todo script embutido de %s carrega o nonce da resposta", async (caminho) => {
    const cliente = novoCliente();
    if (caminho !== "/login") await entrar(cliente, "coordenador_csso");
    const r = await cliente.get(caminho);
    expect(r.status, caminho).toBe(200);
    const marca = /'nonce-([^']+)'/.exec(r.cabecalho("content-security-policy")!);
    expect(marca).toBeTruthy();
    const embutidos = [...r.text.matchAll(/<script([^>]*)>/g)].map((m) => m[1]!).filter((a) => !a.includes("src="));
    expect(embutidos.length, `${caminho} sem script embutido`).toBeGreaterThan(0);
    for (const atributos of embutidos) expect(atributos, caminho).toContain(`nonce="${marca![1]}"`);
  });

  it("o htmx não injeta o style que a CSP recusa", async () => {
    const corpo = (await novoCliente().get("/login")).text;
    expect(corpo).toContain('"includeIndicatorStyles":false');
    expect(corpo.indexOf("htmx-config")).toBeLessThan(corpo.indexOf("htmx.min.js"));
  });
});

describe("os templates, lidos do disco", () => {
  const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../templates");
  const semComentario = (s: string) => s.replace(/\{#[\s\S]*?#\}/g, "");
  function* html(pasta: string): Generator<string> {
    for (const nome of readdirSync(pasta)) {
      const p = path.join(pasta, nome);
      if (statSync(p).isDirectory()) yield* html(p);
      else if (nome.endsWith(".html")) yield p;
    }
  }

  it("nenhum template traz atributo de evento inline", () => {
    const achados: string[] = [];
    for (const arquivo of html(raiz)) {
      semComentario(readFileSync(arquivo, "utf8"))
        .split("\n")
        .forEach((linha, i) => {
          if (/\son[a-z]+\s*=\s*["']/i.test(linha)) achados.push(`${path.relative(raiz, arquivo)}:${i + 1}`);
        });
    }
    expect(achados).toEqual([]);
  });

  it("todo script embutido de template pede o nonce", () => {
    const sem: string[] = [];
    for (const arquivo of html(raiz)) {
      for (const m of semComentario(readFileSync(arquivo, "utf8")).matchAll(/<script([^>]*)>/g)) {
        if (!m[1]!.includes("src=") && !m[1]!.includes("nonce=")) sem.push(path.relative(raiz, arquivo));
      }
    }
    expect(sem).toEqual([]);
  });

  it("o htmx não precisa de unsafe-eval", () => {
    for (const arquivo of html(raiz)) {
      const texto = semComentario(readFileSync(arquivo, "utf8"));
      expect(texto.includes("hx-vals"), arquivo).toBe(false);
      for (const m of texto.matchAll(/hx-trigger="([^"]*)"/g)) expect(m[1]!.includes("["), arquivo).toBe(false);
    }
  });
});

describe("a tela de erro também é tela", () => {
  it("403 sai com a casca e com uma saída que abre", async () => {
    const cliente = novoCliente();
    await entrar(cliente, "secretaria_csso");
    const r = await cliente.get("/saude/db", { cabecalhos: { accept: "text/html" } });
    expect(r.status).toBe(403);
    expect(r.text).toContain(CASCA);
    expect(r.text).toContain("backup.executar");
    // a saída é o primeiro item de menu que a secretaria enxerga
    expect(r.text).toMatch(/<a class="botao" href="\/">Ir para Painel<\/a>/);
  });

  it("404 sai com a casca", async () => {
    const cliente = novoCliente();
    await entrar(cliente, "coordenador_csso");
    const r = await cliente.get("/nao-existe", { cabecalhos: { accept: "text/html" } });
    expect(r.status).toBe(404);
    expect(r.text).toContain(CASCA);
  });

  it("404 sem sessão não derruba a aplicação, e sai sem casca", async () => {
    const r = await novoCliente().get("/nao-existe", { cabecalhos: { accept: "text/html" } });
    expect(r.status).toBe(404);
    expect(r.text).not.toContain(CASCA);
  });

  it("404 para quem não pede HTML é JSON", async () => {
    const r = await novoCliente().get("/nao-existe");
    expect(r.status).toBe(404);
    expect(r.json()).toEqual({ detail: "Not Found" });
  });

  it("o rodapé institucional sai em toda tela", async () => {
    const cliente = novoCliente();
    await entrar(cliente, "coordenador_csso");
    const r = await cliente.get("/modulos");
    expect(r.text).toContain("Sistema de apoio da CSSO");
    expect(r.text).toContain("O processo oficial e o SEI.");
    expect((await novoCliente().get("/login")).text).toContain("O processo oficial e o SEI.");
  });
});
