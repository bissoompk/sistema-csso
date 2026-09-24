/** Porte de `test_web_fluxo.py` (saúde) e `test_rotas_permissoes.py` (saúde pública). */
import { describe, expect, it } from "vitest";
import { bancoLimpo, contas, entrar } from "./ajuda";

const { db, novoCliente } = await bancoLimpo();
await contas(db);

describe("/saude", () => {
  it("responde sem autenticação, e só a prova de vida", async () => {
    const r = await novoCliente().get("/saude");
    expect(r.status).toBe(200);
    expect(r.json()).toEqual({ status: "ok" });
  });

  it("/saude/detalhe exige login", async () => {
    const cliente = novoCliente();
    expect((await cliente.get("/saude/detalhe", { seguir: false })).status).toBe(303);
    await entrar(cliente, "coordenador_csso");
    const dados = (await cliente.get("/saude/detalhe")).json();
    expect(dados.ambiente).toBe("teste");
    expect(dados.versao).toBeTruthy();
  });

  it("/saude/db: login, e só para quem opera a máquina ou a trilha", async () => {
    const cliente = novoCliente();
    expect((await cliente.get("/saude/db", { seguir: false })).status).toBe(303);
    await entrar(cliente, "secretaria_csso");
    expect((await cliente.get("/saude/db")).status).toBe(403);
    await entrar(cliente, "admin_ti");
    const r = await cliente.get("/saude/db");
    expect(r.status).toBe(200);
    expect(r.json().integrity_check).toBe("ok");
  });
});
