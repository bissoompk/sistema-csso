/**
 * /login — o que a tela faz com quem já está dentro e com o «voltar» do
 * navegador (26/10/2026).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { bancoLimpo, contas, entrar, type Cliente } from "./ajuda.js";

let cliente: Cliente;
beforeEach(async () => {
  const amb = await bancoLimpo();
  cliente = amb.cliente;
  await contas(amb.db);
});

describe("login", () => {
  it("quem já tem sessão não vê o formulário: vai ao início, ou ao `proximo` do sistema", async () => {
    await entrar(cliente, "coordenador_csso");
    const a = await cliente.get("/login", { seguir: false });
    expect(a.status).toBe(303);
    expect(a.headers.get("location")).toBe("/inicio");
    const b = await cliente.get("/login?proximo=/turmas", { seguir: false });
    expect(b.headers.get("location")).toBe("/turmas");
    const c = await cliente.get("/login?proximo=https://outro.site", { seguir: false });
    expect(c.headers.get("location")).toBe("/inicio");
  });

  it("sem sessão o formulário aparece, e a tela HTML não fica no cache do navegador", async () => {
    const r = await cliente.get("/login", { seguir: false });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    await entrar(cliente, "coordenador_csso");
    const p = await cliente.get("/inicio", { seguir: false });
    expect(p.headers.get("cache-control")).toBe("no-store");
  });
});
