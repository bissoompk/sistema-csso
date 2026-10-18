/**
 * O recorte por unidade da fila de pedidos de EPI enquanto o pedido é
 * rascunho (dívida técnica fechada em 18/10/2026). `campus_id` só é congelado
 * no envio; antes disso, valia "rascunho sem campus aparece para todo mundo".
 * Agora vale o campus ATUAL do servidor, e o autor sempre vê o que escreveu.
 */
import { asc, eq, ne } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as e from "../src/db/esquema/index.js";
import * as servico from "../src/servicos/epi_requisicao.js";
import { UsuarioAtual } from "../src/servicos/rbac.js";
import { bancoLimpo, contas } from "./ajuda";

const { db } = await bancoLimpo();
await contas(db);

const [u1] = await db.select().from(e.unidade_uorg).orderBy(asc(e.unidade_uorg.id)).limit(1);
const [u2] = await db.select().from(e.unidade_uorg).where(ne(e.unidade_uorg.campus_id, u1!.campus_id)).limit(1);
const [dono] = await db.select().from(e.usuario).where(eq(e.usuario.login, "servidor_consulta"));
const [autor] = await db.select().from(e.usuario).where(eq(e.usuario.login, "tecnico_seguranca"));

const [aqui] = await db.insert(e.servidor).values({ siape: "3030301", nome: "Lotado Aqui", unidade_uorg_id: u1!.id }).returning();
const [la] = await db.insert(e.servidor).values({ siape: "3030302", nome: "Lotado Lá", unidade_uorg_id: u2!.id }).returning();

const rascunho = async (servidor_id: number, solicitado_por_id: number, campus_id: number | null = null) =>
  (await db.insert(e.epi_requisicao).values({ servidor_id, solicitado_por_id, campus_id }).returning())[0]!.id;

const r_aqui = await rascunho(aqui!.id, dono!.id);
const r_la = await rascunho(la!.id, dono!.id);
const r_la_do_autor = await rascunho(la!.id, autor!.id);
const enviado_la = await rascunho(la!.id, dono!.id, u2!.campus_id);
const enviado_aqui = await rascunho(la!.id, dono!.id, u1!.campus_id);

const da_unidade = (id: number) =>
  new UsuarioAtual({ id, login: "x", nome: "X", permissoes: ["epi.ver"], perfis: ["tecnico_seguranca"], campi: [u1!.campus_id] });

describe("fila de pedidos de EPI, escopo de unidade", () => {
  it("rascunho entra pelo campus atual do servidor, e o enviado pelo campus congelado", async () => {
    const ids = (await servico.fila(db, da_unidade(999_999))).map((r) => r.id);
    expect(ids).toContain(r_aqui);
    expect(ids).not.toContain(r_la);
    expect(ids).not.toContain(r_la_do_autor);
    // o enviado vale pelo que congelou, mesmo que o servidor esteja lotado em outro campus
    expect(ids).toContain(enviado_aqui);
    expect(ids).not.toContain(enviado_la);
  });

  it("o autor sempre vê o próprio rascunho", async () => {
    const ids = (await servico.fila(db, da_unidade(autor!.id))).map((r) => r.id);
    expect(ids).toContain(r_la_do_autor);
    expect(ids).not.toContain(r_la);
  });

  it("a leitura por id segue a mesma regra", async () => {
    expect(await servico.no_escopo(db, da_unidade(999_999), r_la)).toBeNull();
    expect(await servico.no_escopo(db, da_unidade(999_999), r_aqui)).not.toBeNull();
  });

  it("unidade sem campus atribuído continua vendo a coordenadoria inteira", async () => {
    const todos = new UsuarioAtual({ id: 1, login: "x", nome: "X", permissoes: ["epi.ver"], perfis: ["tecnico_seguranca"], campi: [] });
    const ids = (await servico.fila(db, todos)).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([r_aqui, r_la, r_la_do_autor, enviado_la, enviado_aqui]));
  });
});
