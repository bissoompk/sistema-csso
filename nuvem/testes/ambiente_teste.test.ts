/**
 * O ambiente de teste (`ferramentas/ambiente-teste.ts`). O Python cobrava as
 * travas de DISCO (`test_ambiente_de_teste.py`); aqui a trava é o banco, e o
 * que se cobra é que ele recusa banco remoto e que as contas entram.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { bancoLocal, CONTAS, povoar, SENHA, SERVIDORES } from "../ferramentas/ambiente-teste.js";
import { bancoLimpo, naTransacao } from "./ajuda";

describe("ambiente de teste", () => {
  it("só recria banco em localhost", () => {
    expect(bancoLocal("postgres://postgres:csso@localhost:55432/csso")).toBe(true);
    expect(bancoLocal("postgres://u:p@127.0.0.1/x")).toBe(true);
    expect(bancoLocal("postgres://u:p@aws-0-sa-east-1.pooler.supabase.com:6543/postgres")).toBe(false);
    expect(bancoLocal("isto não é url")).toBe(false);
  });

  it("povoa contas, servidores e habilitações, e toda conta entra com a senha impressa", async () => {
    const { db, novoCliente } = await bancoLimpo();
    const resumo = await naTransacao((tx) => povoar(tx));
    expect(resumo).toEqual({ contas: CONTAS.length, servidores: SERVIDORES.length, habilitacoes: 3 });

    const [conta] = await db.select().from(e.usuario).where(eq(e.usuario.login, "servidor"));
    const [adelaide] = await db.select().from(e.servidor).where(eq(e.servidor.siape, "3010011"));
    expect(conta!.servidor_id).toBe(adelaide!.id);
    const lotacoes = await db.select().from(e.servidor_lotacao);
    expect(lotacoes.length).toBe(SERVIDORES.length);

    for (const [login] of CONTAS) {
      const r = await novoCliente().post("/login", { login, senha: SENHA }, { seguir: false });
      expect(r.status, login).toBe(303);
      expect(r.location, login).toBe("/inicio");
    }
  });
});
