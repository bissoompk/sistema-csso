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

  it("povoa como o Python (mesmo resumo), e toda conta entra com a senha impressa", async () => {
    const { db, novoCliente } = await bancoLimpo();
    const resumo = await naTransacao((tx) => povoar(tx));
    // O resumo que `ferramentas/ambiente_teste_cli.py` imprime, número a número.
    expect(resumo).toEqual({
      adicionais_vigentes: 2,
      certificados: 2,
      demandas: 7,
      epi_fichas: 5,
      epi_itens: 9,
      epi_lotes: 7,
      epi_requisicoes: 9,
      laudos: 3,
      pareceres: 3,
      pendencias: 20,
      pendencias_atrasadas: 5,
      processos: 11,
      servidores: SERVIDORES.length,
      turmas: 5,
    });

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
