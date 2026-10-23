/**
 * O vínculo decide o perfil no cadastro da conta (23/10/2026): servidor →
 * `servidor_consulta` (com o servidor do cadastro), terceirizado e discente →
 * os perfis deles, que comunicam acidente e se inscrevem em treinamento mas
 * não pedem EPI, e nunca se ligam a servidor. Dados fictícios.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import { carregar_usuario_atual } from "../src/servicos/rbac.js";
import { bancoLimpo, contas, entrar, type Cliente } from "./ajuda.js";

let db: Banco;
let novoCliente: () => Cliente;

beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  novoCliente = amb.novoCliente;
  await contas(db);
});

const conta = async (email: string) => (await db.select().from(e.usuario).where(eq(e.usuario.email, email)))[0];
async function perfis_de(id: number) {
  const linhas = await db.query.atribuicao.findMany({ where: eq(e.atribuicao.usuario_id, id), with: { perfil: true } });
  return linhas.map((a) => a.perfil.codigo).sort();
}

describe("cadastrar conta com vínculo", () => {
  it.each([
    ["TERCEIRIZADO", "terceirizado"],
    ["DISCENTE", "discente"],
  ])("%s nasce com o perfil %s, sem servidor", async (vinculo, perfil) => {
    const sup = await entrar(novoCliente(), "superintendente");
    const email = `${perfil}.ficticio@exemplo.org`;
    const r = await sup.post("/usuarios", { nome: "Pessoa Fictícia", email, vinculo });
    expect(r.status).toBe(200);
    expect(r.text).toContain(`perfil ${perfil}`);
    const c = (await conta(email))!;
    expect(c.servidor_id).toBeNull();
    expect(await perfis_de(c.id)).toEqual([perfil]);
    const atual = await carregar_usuario_atual(db, c.id);
    expect(atual.pode("acidente.comunicar")).toBe(true);
    expect(atual.pode("turma.inscrever_se")).toBe(true);
    expect(atual.pode("epi.requisitar")).toBe(false);
    expect(atual.pode("epi.ver")).toBe(false);
  });

  it("terceirizado não se vincula a servidor, nem no cadastro nem depois", async () => {
    const [sv] = await db.insert(e.servidor).values({ siape: "7100001", nome: "Servidor Fictício" }).returning();
    const sup = await entrar(novoCliente(), "superintendente");
    const r = await sup.post("/usuarios", { nome: "T", email: "t1@exemplo.org", vinculo: "TERCEIRIZADO", servidor: sv!.siape });
    expect(r.text).toContain("não se vincula a servidor");
    expect(await conta("t1@exemplo.org")).toBeUndefined();
    await sup.post("/usuarios", { nome: "T", email: "t2@exemplo.org", vinculo: "TERCEIRIZADO" });
    const c = (await conta("t2@exemplo.org"))!;
    const depois = await sup.post(`/usuarios/${c.id}/servidor`, { servidor: sv!.siape });
    expect(depois.text).toContain("não se vincula a servidor");
    expect((await conta("t2@exemplo.org"))!.servidor_id).toBeNull();
  });

  it("servidor: com o SIAPE nasce ligado e com servidor_consulta; sem servidor achado, é recusado", async () => {
    const [sv] = await db.insert(e.servidor).values({ siape: "7100002", nome: "Servidora Fictícia" }).returning();
    const sup = await entrar(novoCliente(), "superintendente");
    const sem = await sup.post("/usuarios", { nome: "S", email: "s0@exemplo.org", vinculo: "SERVIDOR" });
    expect(sem.text).toContain("pede o servidor do cadastro");
    expect(await conta("s0@exemplo.org")).toBeUndefined();
    await sup.post("/usuarios", { nome: "S", email: "s1@exemplo.org", vinculo: "SERVIDOR", servidor: sv!.siape });
    const c = (await conta("s1@exemplo.org"))!;
    expect(c.servidor_id).toBe(sv!.id);
    expect(await perfis_de(c.id)).toEqual(["servidor_consulta"]);
  });

  it("vínculo servidor pede perfil.conceder; terceirizado não (é regra, não concessão)", async () => {
    const ti = await entrar(novoCliente(), "admin_ti");
    const s = await ti.post("/usuarios", { nome: "S", email: "s2@exemplo.org", vinculo: "SERVIDOR" });
    expect(s.text).toContain("perfil.conceder");
    expect(await conta("s2@exemplo.org")).toBeUndefined();
    await ti.post("/usuarios", { nome: "T", email: "t3@exemplo.org", vinculo: "TERCEIRIZADO" });
    const c = (await conta("t3@exemplo.org"))!;
    expect(await perfis_de(c.id)).toEqual(["terceirizado"]);
  });

  it("conta externa ligada a servidor por engano não recebe a concessão do titular (o EPI)", async () => {
    const [sv] = await db.insert(e.servidor).values({ siape: "7100003", nome: "X" }).returning();
    await db.update(e.usuario).set({ servidor_id: sv!.id }).where(eq(e.usuario.login, "discente"));
    const c = (await db.select().from(e.usuario).where(eq(e.usuario.login, "discente")))[0]!;
    const atual = await carregar_usuario_atual(db, c.id);
    expect(atual.pode("epi.requisitar")).toBe(false);
    expect(atual.pode("processo.ver")).toBe(false);
  });

  it("vínculo fora da lista é recusado", async () => {
    const sup = await entrar(novoCliente(), "superintendente");
    const r = await sup.post("/usuarios", { nome: "V", email: "v@exemplo.org", vinculo: "VISITANTE" });
    expect(r.text).toContain("escolha o vínculo");
  });

  it("o terceirizado não abre o pedido de EPI (403)", async () => {
    const cli = await entrar(novoCliente(), "terceirizado");
    expect((await cli.get("/epis/requisicoes/nova", { seguir: false })).status).toBe(403);
  });
});
