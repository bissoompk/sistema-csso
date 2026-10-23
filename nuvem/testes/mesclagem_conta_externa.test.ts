/**
 * Junção de cadastros com a conta de terceirizado ou discente
 * (`participante.usuario_id`, 23/10/2026): a conta passa ao cadastro que fica;
 * duas contas, ou conta externa com cadastro de servidor, não se juntam.
 * Dados fictícios.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Banco } from "../src/db/cliente.js";
import * as e from "../src/db/esquema/index.js";
import * as mesclagem from "../src/servicos/mesclagem.js";
import * as participante from "../src/servicos/participante.js";
import { bancoLimpo, contas, criarUsuario, naTransacao, usuarioAtual } from "./ajuda.js";

let db: Banco;

beforeEach(async () => {
  db = (await bancoLimpo()).db;
  await contas(db);
});

async function externo(nome: string, conta: number | null) {
  const p = await naTransacao((tx) => participante.criar_externo(tx, { nome, vinculo: "TERCEIRIZADO" }));
  if (conta !== null) await db.update(e.participante).set({ usuario_id: conta }).where(eq(e.participante.id, p.id));
  return p.id;
}

const conta_de = async (id: number) =>
  (await db.select({ u: e.participante.usuario_id }).from(e.participante).where(eq(e.participante.id, id)))[0]!.u;

describe("juntar cadastros com conta externa", () => {
  it("a conta do absorvido passa ao mantido, e fica no registro da junção", async () => {
    const conta = await criarUsuario(db, { login: "terc.a@exemplo.org", email: "terc.a@exemplo.org", perfis: ["terceirizado"] });
    const mantido = await externo("Ana Fictícia Rocha", null);
    const absorvido = await externo("Ana F. Rocha", conta.id);
    const quem = await usuarioAtual(db, "coordenador_csso");
    await naTransacao((tx) => mesclagem.mesclar(tx, quem, mantido, absorvido, "mesma pessoa"));
    expect(await conta_de(mantido)).toBe(conta.id);
    expect(await conta_de(absorvido)).toBeNull();
    const [reg] = await db.select().from(e.participante_mesclagem);
    expect(reg!.movido.conta_movida).toBe(conta.id);
  });

  it("duas contas diferentes não se juntam", async () => {
    const a = await criarUsuario(db, { login: "terc.b@exemplo.org", email: "terc.b@exemplo.org", perfis: ["terceirizado"] });
    const b = await criarUsuario(db, { login: "terc.c@exemplo.org", email: "terc.c@exemplo.org", perfis: ["terceirizado"] });
    const m = await externo("Bruno Fictício Dias", a.id);
    const x = await externo("Bruno F. Dias", b.id);
    const quem = await usuarioAtual(db, "coordenador_csso");
    await expect(naTransacao((tx) => mesclagem.mesclar(tx, quem, m, x, "mesma pessoa"))).rejects.toThrow(/contas diferentes/);
  });

  it("conta externa não se junta a cadastro de servidor", async () => {
    const conta = await criarUsuario(db, { login: "terc.d@exemplo.org", email: "terc.d@exemplo.org", perfis: ["terceirizado"] });
    const [s] = await db.insert(e.servidor).values({ siape: "5556667", nome: "Carla Fictícia", situacao: "ATIVO" }).returning();
    const doServidor = await naTransacao((tx) => participante.de_servidor(tx, s!));
    const x = await externo("Carla Fictícia", conta.id);
    const quem = await usuarioAtual(db, "coordenador_csso");
    await expect(naTransacao((tx) => mesclagem.mesclar(tx, quem, doServidor.id, x, "mesma pessoa"))).rejects.toThrow(
      /conta de terceirizado ou discente/,
    );
  });
});
