/**
 * Desligamento por inatividade (22/10/2026): 60 minutos sem pedido derrubam a
 * sessão, o navegador avisa aos 55 e o login explica o motivo. A lista de
 * sessões abertas de /minha-conta saiu no mesmo dia, no lugar disto.
 * Ver DESVIOS.md, "Desligamento por inatividade (22/10/2026)".
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as e from "../src/db/esquema/index.js";
import { obterConfig, redefinirConfig } from "../src/config.js";
import * as autenticacao from "../src/servicos/autenticacao.js";
import { bancoLimpo, contas, entrar, type Cliente } from "./ajuda";

const { db, novoCliente } = await bancoLimpo();
await contas(db);

const MIN = 60_000;

function hashDe(cliente: Cliente): string {
  return autenticacao._hash_token(cliente.cookies.get(autenticacao.COOKIE_SESSAO)!);
}

async function paradaHa(cliente: Cliente, minutos: number): Promise<void> {
  await db
    .update(e.sessao)
    .set({ ultimo_uso_em: new Date(Date.now() - minutos * MIN) })
    .where(eq(e.sessao.token_hash, hashDe(cliente)));
}

async function ultimoUso(cliente: Cliente): Promise<Date> {
  const [s] = await db.select().from(e.sessao).where(eq(e.sessao.token_hash, hashDe(cliente)));
  return s!.ultimo_uso_em!;
}

describe("o limite no servidor", () => {
  it("o padrão é 60 minutos", () => {
    expect(obterConfig().sessaoInatividadeMinutos).toBe(60);
  });

  it("parada há mais de 60 minutos, a sessão cai e o próximo pedido vai ao login", async () => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    await paradaHa(cliente, 62);
    const r = await cliente.get("/processos", { seguir: false });
    expect(r.status).toBe(303);
    expect(r.location).toContain("/login");
  });

  it("aos 59 minutos ainda vale, e o pedido renova o relógio", async () => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    await paradaHa(cliente, 59);
    expect((await cliente.get("/processos", { seguir: false })).status).toBe(200);
    expect(Date.now() - (await ultimoUso(cliente)).getTime()).toBeLessThan(MIN);
  });

  it("tolera o passo de um minuto da regravação: 60,5 minutos na coluna ainda valem", async () => {
    // a coluna pode estar até 1 min atrás do último pedido de verdade; cair
    // aqui seria cair antes dos 60 minutos que o aviso do navegador promete
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    await paradaHa(cliente, 60.5);
    expect((await cliente.get("/processos", { seguir: false })).status).toBe(200);
  });

  it("o teto absoluto de 12 h continua valendo mesmo em uso", async () => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    await db
      .update(e.sessao)
      .set({ expira_em: new Date(Date.now() - MIN), ultimo_uso_em: new Date() })
      .where(eq(e.sessao.token_hash, hashDe(cliente)));
    expect((await cliente.get("/processos", { seguir: false })).status).toBe(303);
  });
});

describe("a renovação do botão \"Continuar conectado\"", () => {
  it("GET /quem-sou-eu renova o último uso e estende a sessão", async () => {
    const cliente = await entrar(novoCliente(), "tecnico_seguranca");
    await paradaHa(cliente, 56);
    const r = await cliente.get("/quem-sou-eu");
    expect(r.json().autenticado).toBe(true);
    expect(Date.now() - (await ultimoUso(cliente)).getTime()).toBeLessThan(MIN);
    // o que era 56 min parado volta a zero: daqui a "mais 50" ainda vale
    await paradaHa(cliente, 50);
    expect((await cliente.get("/processos", { seguir: false })).status).toBe(200);
  });

  it("com a sessão já caída, /quem-sou-eu diz que não está autenticado (o aviso leva ao login)", async () => {
    const cliente = await entrar(novoCliente(), "tecnico_seguranca");
    await paradaHa(cliente, 90);
    expect((await cliente.get("/quem-sou-eu")).json().autenticado).toBe(false);
  });
});

describe("o limite chega à página", () => {
  it("página logada leva data-sessao-inatividade=\"60\" no <body>", async () => {
    const cliente = await entrar(novoCliente(), "servidor_consulta");
    const r = await cliente.get("/minha-conta");
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/<body[^>]* data-sessao-inatividade="60"/);
  });

  it("página deslogada não tem o atributo", async () => {
    const r = await novoCliente().get("/login");
    expect(r.status).toBe(200);
    expect(r.text).not.toContain("data-sessao-inatividade");
  });

  it("com o limite desligado (0), nem a página logada tem o atributo", async () => {
    const antes = process.env.CSSO_SESSAO_INATIVIDADE_MINUTOS;
    process.env.CSSO_SESSAO_INATIVIDADE_MINUTOS = "0";
    redefinirConfig();
    try {
      const cliente = await entrar(novoCliente(), "servidor_consulta");
      const r = await cliente.get("/minha-conta");
      expect(r.status).toBe(200);
      expect(r.text).not.toContain("data-sessao-inatividade");
    } finally {
      if (antes === undefined) delete process.env.CSSO_SESSAO_INATIVIDADE_MINUTOS;
      else process.env.CSSO_SESSAO_INATIVIDADE_MINUTOS = antes;
      redefinirConfig();
    }
  });

  it("o csso.js tem o bloco do aviso, com o contrato do atributo e a renovação", () => {
    const js = readFileSync(path.resolve(__dirname, "../public/estaticos/js/csso.js"), "utf8");
    expect(js).toContain("// 12. O desligamento por inatividade");
    expect(js).toContain("data-sessao-inatividade");
    expect(js).toContain("/quem-sou-eu");
    expect(js).toContain("/login?motivo=inatividade");
    expect(js).toContain("Por segurança, você será desconectado em ");
    expect(js).toContain("Continuar conectado");
    expect(js).toContain("Sair agora");
    expect(js).toContain("localStorage");
  });
});

describe("a tela de login explica o motivo", () => {
  it("?motivo=inatividade mostra a mensagem", async () => {
    const r = await novoCliente().get("/login?motivo=inatividade&proximo=%2Fprocessos");
    expect(r.text).toContain("Sua sessão foi encerrada por inatividade.");
    expect(r.text).toContain('name="proximo" value="/processos"');
  });

  it("motivo desconhecido ou herdado do objeto não mostra nada nem reflete o texto", async () => {
    for (const motivo of ["toString", "constructor", "__proto__", "<b>oi</b>"]) {
      const r = await novoCliente().get(`/login?motivo=${encodeURIComponent(motivo)}`);
      expect(r.status, motivo).toBe(200);
      expect(r.text, motivo).not.toContain('class="aviso aviso-alerta"');
      expect(r.text, motivo).not.toContain("<b>oi</b>");
    }
  });
});

describe("Minha conta sem a lista de sessões", () => {
  it("a tela não lista sessões nem oferece encerrar", async () => {
    await entrar(novoCliente(), "engenheiro_seguranca");
    const cliente = await entrar(novoCliente(), "engenheiro_seguranca");
    const r = await cliente.get("/minha-conta");
    expect(r.status).toBe(200);
    expect(r.text).not.toContain("Sessões abertas");
    expect(r.text).not.toContain("esta sessão");
    expect(r.text).not.toContain("/minha-conta/sessoes");
    expect(r.text).not.toContain("Encerrar todas as outras");
  });

  it("as rotas de encerrar saíram (404)", async () => {
    const cliente = await entrar(novoCliente(), "engenheiro_seguranca");
    expect((await cliente.post("/minha-conta/sessoes/encerrar-outras", {}, { seguir: false })).status).toBe(404);
    expect((await cliente.post("/minha-conta/sessoes/1/encerrar", {}, { seguir: false })).status).toBe(404);
  });
});
