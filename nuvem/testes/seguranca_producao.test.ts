/**
 * Revisão de segurança para a produção (internet pública, dado pessoal real):
 * CSRF por origem, recusa de subir com segredo de exemplo, tempo igual da
 * recusa de login e o texto do catálogo escapado na prévia do parecer.
 * Ver DESVIOS.md, "Produção — segurança".
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfiguracaoInsegura,
  ehProducao,
  exigirConfiguracaoDeProducao,
  obterConfig,
  problemasDeProducao,
  redefinirConfig,
} from "../src/config.js";
import { origemCruzada, resumoDoErro } from "../src/nucleo/seguranca.js";
import { renderizar } from "../src/web.js";
import { bancoLimpo, contas, entrar, SENHA_TESTE } from "./ajuda";

const { db, novoCliente } = await bancoLimpo();
await contas(db);

const BOA = {
  CSSO_AMBIENTE: "producao",
  CSSO_CHAVE_SECRETA: "k".repeat(43),
  CSSO_BACKUP_SENHA: "uma-senha-de-backup-longa",
  CSSO_COOKIE_SEGURO: "auto",
  DATABASE_URL: "postgresql://u:p@h:6543/postgres",
} as NodeJS.ProcessEnv;

describe("origemCruzada", () => {
  const url = "https://cssosisa.netlify.app/processos/1/sei";
  const h = (m: Record<string, string>) => (n: string) => m[n];

  it("método que não escreve nunca é recusado", () => {
    expect(origemCruzada("GET", url, h({ origin: "https://mal.netlify.app" }))).toBe(false);
    expect(origemCruzada("HEAD", url, h({ "sec-fetch-site": "cross-site" }))).toBe(false);
  });

  it("Sec-Fetch-Site decide quando vem: só same-origin e none passam", () => {
    expect(origemCruzada("POST", url, h({ "sec-fetch-site": "same-origin" }))).toBe(false);
    expect(origemCruzada("POST", url, h({ "sec-fetch-site": "none" }))).toBe(false);
    expect(origemCruzada("POST", url, h({ "sec-fetch-site": "cross-site" }))).toBe(true);
    // o subdomínio irmão (o buraco do SameSite=Lax) também é recusado
    expect(origemCruzada("POST", url, h({ "sec-fetch-site": "same-site" }))).toBe(true);
  });

  it("sem Sec-Fetch-Site, Origin; sem Origin, Referer", () => {
    expect(origemCruzada("POST", url, h({ origin: "https://cssosisa.netlify.app" }))).toBe(false);
    expect(origemCruzada("POST", url, h({ origin: "https://outro.netlify.app" }))).toBe(true);
    expect(origemCruzada("DELETE", url, h({ origin: "null" }))).toBe(true);
    expect(origemCruzada("POST", url, h({ origin: "lixo" }))).toBe(true);
    expect(origemCruzada("POST", url, h({ referer: "https://cssosisa.netlify.app/processos/1" }))).toBe(false);
    expect(origemCruzada("POST", url, h({ referer: "https://evil.example/x" }))).toBe(true);
  });

  it("sem nenhum dos três (não é navegador) passa", () => {
    expect(origemCruzada("POST", url, h({}))).toBe(false);
  });
});

describe("CSRF no app", () => {
  it("POST de outra origem é recusado com 403 e não autentica", async () => {
    const r = await novoCliente().post(
      "/login",
      { login: "coordenador_csso", senha: SENHA_TESTE },
      { seguir: false, cabecalhos: { origin: "https://atacante.example", "sec-fetch-site": "cross-site" } },
    );
    expect(r.status).toBe(403);
    expect(r.headers.getSetCookie().some((c) => c.startsWith("csso_sessao="))).toBe(false);
    expect(r.text).toContain("CSRF");
  });

  it("POST forjado com sessão válida não escreve", async () => {
    const cliente = novoCliente();
    await entrar(cliente, "coordenador_csso");
    const r = await cliente.post(
      "/trocar-senha",
      { senha_atual: SENHA_TESTE, nova: "Invadida2026x", confirmacao: "Invadida2026x" },
      { seguir: false, cabecalhos: { "sec-fetch-site": "same-site" } },
    );
    expect(r.status).toBe(403);
    // a senha antiga continua valendo
    await entrar(novoCliente(), "coordenador_csso");
  });

  it("API recebe a recusa em JSON", async () => {
    const r = await novoCliente().post("/api/v1/qualquer", {}, { seguir: false, cabecalhos: { origin: "https://x.example" } });
    expect(r.status).toBe(403);
    expect(r.json().motivos).toEqual(["origem cruzada"]);
  });

  it("POST da própria origem passa", async () => {
    const r = await novoCliente().post(
      "/login",
      { login: "coordenador_csso", senha: SENHA_TESTE },
      { seguir: false, cabecalhos: { origin: "http://testserver", "sec-fetch-site": "same-origin" } },
    );
    expect(r.status).toBe(303);
  });
});

describe("produção recusa configuração insegura", () => {
  const antes = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(BOA)) {
      if (antes[k] === undefined) delete process.env[k];
      else process.env[k] = antes[k];
    }
    delete process.env.CSSO_BACKUP_SENHA;
    if (antes.CSSO_BACKUP_SENHA !== undefined) process.env.CSSO_BACKUP_SENHA = antes.CSSO_BACKUP_SENHA;
    redefinirConfig();
  });

  it("reconhece produção com e sem acento", () => {
    expect(ehProducao("producao")).toBe(true);
    expect(ehProducao(" Produção ")).toBe(true);
    expect(ehProducao("homologacao")).toBe(false);
    expect(ehProducao("teste")).toBe(false);
  });

  it("configuração boa passa", () => {
    expect(problemasDeProducao(BOA)).toEqual([]);
    expect(() => exigirConfiguracaoDeProducao(BOA)).not.toThrow();
  });

  it.each([
    ["chave de exemplo", { CSSO_CHAVE_SECRETA: "desenvolvimento-inseguro-troque" }, "CSSO_CHAVE_SECRETA"],
    ["chave vazia", { CSSO_CHAVE_SECRETA: "" }, "CSSO_CHAVE_SECRETA"],
    ["chave curta", { CSSO_CHAVE_SECRETA: "curta" }, "CSSO_CHAVE_SECRETA"],
    ["cookie sem Secure", { CSSO_COOKIE_SEGURO: "nao" }, "CSSO_COOKIE_SEGURO"],
    ["sem banco", { DATABASE_URL: "" }, "DATABASE_URL"],
  ])("%s: recusa, dizendo a variável e não o valor", (_n, troca, variavel) => {
    const env = { ...BOA, ...troca } as NodeJS.ProcessEnv;
    let erro: unknown;
    try {
      exigirConfiguracaoDeProducao(env);
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(ConfiguracaoInsegura);
    expect((erro as Error).message).toContain(variavel);
    expect((erro as Error).message).not.toContain("desenvolvimento-inseguro-troque");
  });

  it("senha de backup ausente não derruba a produção: só o backup recusa", () => {
    for (const senha of [undefined, "backup-inseguro-troque", "curta"]) {
      const env = { ...BOA, CSSO_BACKUP_SENHA: senha } as NodeJS.ProcessEnv;
      expect(problemasDeProducao(env)).toEqual([]);
      expect(() => exigirConfiguracaoDeProducao(env)).not.toThrow();
    }
  });

  it("fora de produção, o mesmo problema é só aviso", () => {
    expect(() => exigirConfiguracaoDeProducao({ ...BOA, CSSO_AMBIENTE: "homologacao", CSSO_CHAVE_SECRETA: "" })).not.toThrow();
  });

  it("obterConfig lança em produção insegura (o app não atende)", () => {
    process.env.CSSO_AMBIENTE = "producao";
    process.env.CSSO_CHAVE_SECRETA = "desenvolvimento-inseguro-troque";
    redefinirConfig();
    expect(() => obterConfig()).toThrow(ConfiguracaoInsegura);
  });

  it("obterConfig atende em produção sem senha de backup, com aviso na casca", () => {
    Object.assign(process.env, BOA);
    delete process.env.CSSO_BACKUP_SENHA;
    redefinirConfig();
    expect(obterConfig().inseguro.join(" ")).toContain("CSSO_BACKUP_SENHA");
  });

  it("chave vazia fora de produção vira o valor de exemplo, com aviso", () => {
    process.env.CSSO_CHAVE_SECRETA = "";
    redefinirConfig();
    const cfg = obterConfig();
    expect(cfg.chaveSecreta).not.toBe("");
    expect(cfg.inseguro.join(" ")).toContain("CSSO_CHAVE_SECRETA");
  });
});

describe("recusa de login sem enumeração pela mensagem", () => {
  it("conta inexistente e senha errada dão a mesma resposta", async () => {
    const a = await novoCliente().post("/login", { login: "ninguem@nada.example", senha: "Errada123" });
    const b = await novoCliente().post("/login", { login: "coordenador_csso", senha: "Errada123" });
    expect(a.status).toBe(b.status);
    expect(a.text).toContain("Usuário ou senha inválidos.");
    expect(b.text).toContain("Usuário ou senha inválidos.");
  });
});

describe("prévia do parecer escapa o texto do catálogo", () => {
  it("fundamentação com HTML sai escapada, quebras de linha viram <br />", () => {
    const html = renderizar("partes/previa_parecer.html", {
      parecer: null,
      c: { fundamentacao_legal: '<img src=x onerror="alert(1)">\nArt. 2º', agentes_nocivos: [] },
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
    expect(html).toMatch(/&gt;<br \/>\s*Art\. 2º/);
  });
});

describe("log de erro não tratado sem dado pessoal", () => {
  it("tira os params da consulta e o detail do Postgres", () => {
    const causa = Object.assign(new Error("duplicate key"), {
      name: "PostgresError",
      code: "23505",
      constraint_name: "usuario_email_unique",
      detail: "Key (email)=(maria.silva@ufvjm.edu.br) already exists.",
    });
    const erro = new Error('Failed query: insert into "usuario" ("nome", "email") values ($1, $2)\nparams: Maria Silva,maria.silva@ufvjm.edu.br', {
      cause: causa,
    });
    erro.name = "DrizzleQueryError";
    const linha = resumoDoErro(erro);
    expect(linha).toContain('insert into "usuario"');
    expect(linha).toContain("code=23505");
    expect(linha).toContain("restricao=usuario_email_unique");
    expect(linha).not.toContain("Maria");
    expect(linha).not.toContain("maria.silva");
  });
});

describe("?proximo= do login", () => {
  it.each(["/\t/atacante.example", "/\n/atacante.example", "/\\atacante.example", "/x\\y", "/%0a"])(
    "%j não vira redirecionamento para fora",
    async (proximo) => {
      const { destino_seguro, INICIO } = await import("../src/rotas/autenticacao.js");
      if (proximo === "/%0a") expect(destino_seguro(proximo)).toBe("/%0a"); // codificado: é caminho
      else expect(destino_seguro(proximo)).toBe(INICIO);
    },
  );
});
