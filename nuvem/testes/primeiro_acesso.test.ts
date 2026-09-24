/**
 * O primeiro acesso: banco sem nenhuma conta. Arquivo próprio porque exige o
 * banco VIRGEM de usuários — cada teste troca de banco (`bancoLimpo()` de novo).
 * Porte de `test_web_fluxo.py` (bootstrap, senha fraca) e de
 * `test_login_robusto.py` (primeiro acesso não pede nome de usuário).
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { bancoLimpo, contas } from "./ajuda";

describe("primeiro acesso", () => {
  it("sem nenhum usuário, /login manda para /primeiro-acesso; e ele cria o superintendente auditado", async () => {
    const { db, cliente } = await bancoLimpo();
    const r = await cliente.get("/login", { seguir: false });
    expect(r.status).toBe(303);
    expect(r.location).toContain("/primeiro-acesso");

    await cliente.post(
      "/primeiro-acesso",
      { nome: "Chefe da Sisa", login: "sisa", email: "sisa@ufvjm.edu.br", senha: "PrimeiroAcesso2026" },
      { seguir: false },
    );
    const [u] = await db.select().from(e.usuario).where(eq(e.usuario.login, "sisa"));
    expect(u!.precisa_trocar_senha).toBe(true);
    const atribuicoes = await db.select().from(e.atribuicao).where(eq(e.atribuicao.usuario_id, u!.id));
    expect(atribuicoes.length).toBe(1);
    expect(atribuicoes[0]!.ato_normativo).toBe("BOOTSTRAP — substituir pelo ato real");
    const eventos = await db
      .select()
      .from(e.historico_evento)
      .where(eq(e.historico_evento.tipo_evento, "BOOTSTRAP_SUPERINTENDENTE"));
    expect(eventos.length).toBe(1);
  });

  it("não pede nome de usuário, e a conta entra pelo e-mail em minúsculas", async () => {
    const { cliente } = await bancoLimpo();
    const corpo = (await cliente.get("/primeiro-acesso")).text;
    expect(corpo).not.toContain("Usuário</label>");
    expect(corpo).toContain("E-mail institucional");
    const r = await cliente.post(
      "/primeiro-acesso",
      { nome: "Fabrício Raimundi Andrade", email: "Fabricio.Andrade@ufvjm.edu.br", senha: "primeira1" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    const entrou = await cliente.post(
      "/login",
      { login: "fabricio.andrade@ufvjm.edu.br", senha: "primeira1" },
      { seguir: false },
    );
    expect(entrou.status).toBe(303);
  });

  it("senha fraca é recusada, e o que não é segredo volta", async () => {
    const { cliente } = await bancoLimpo();
    const r = await cliente.post("/primeiro-acesso", { nome: "X", login: "x", email: "x@y.z", senha: "123" });
    expect(r.text).toContain("Senha fraca");
    expect(r.text).toContain('value="x@y.z"');
  });

  it("senha de seis caracteres é aceita", async () => {
    const { cliente } = await bancoLimpo();
    const r = await cliente.post(
      "/primeiro-acesso",
      { nome: "Chefe", login: "chefe", email: "c@ufvjm.edu.br", senha: "csso26" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    const entrada = await cliente.post("/login", { login: "chefe", senha: "csso26" }, { seguir: false });
    expect(entrada.status).toBe(303);
  });

  it("bloqueado quando já existe usuário", async () => {
    const { db, cliente } = await bancoLimpo();
    await contas(db);
    const r = await cliente.get("/primeiro-acesso", { seguir: false });
    expect(r.status).toBe(303);
    expect(r.location).toContain("/login");
  });

  it("na nuvem, requisição vinda da internet não faz primeiro acesso", async () => {
    const { cliente } = await bancoLimpo();
    const r = await cliente.get("/primeiro-acesso", { cabecalhos: { "x-nf-client-connection-ip": "200.1.2.3" } });
    expect(r.text).toContain("O primeiro acesso só pode ser feito na própria máquina");
    const p = await cliente.post(
      "/primeiro-acesso",
      { nome: "X", email: "x@ufvjm.edu.br", senha: "csso26" },
      { seguir: false, cabecalhos: { "x-nf-client-connection-ip": "200.1.2.3" } },
    );
    expect(p.location).toBe("/login");
  });
});
