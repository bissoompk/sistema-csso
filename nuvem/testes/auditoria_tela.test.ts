/**
 * A tela /auditoria e a conferência da cadeia inteira pelo botão.
 * Porte das partes de tela de `test_auditoria_integridade.py`,
 * `test_web_fluxo.py` e `test_rotas_permissoes.py`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { cadeia_integra } from "../src/servicos/auditoria.js";
import { bancoLimpo, contas, entrar, type AmbienteDeTeste } from "./ajuda";

let amb: AmbienteDeTeste = await bancoLimpo();
beforeEach(async () => {
  amb = await bancoLimpo();
  await contas(amb.db);
});

describe("/auditoria", () => {
  it("exige permissão, e o 403 sai com a casca", async () => {
    await entrar(amb.cliente, "secretaria_csso");
    const r = await amb.cliente.get("/auditoria");
    expect(r.status).toBe(403);
    expect(r.text).toContain('<aside class="lateral">');
  });

  it("o auditor vê a trilha", async () => {
    await entrar(amb.cliente, "auditor_interno");
    const r = await amb.cliente.get("/auditoria");
    expect(r.status).toBe(200);
    expect(r.text).toContain("Cadeia inteira");
  });

  it("corrigir o SIAPE na tela não acusa adulteração", async () => {
    const [famed] = await amb.db.select().from(e.unidade_uorg).where(eq(e.unidade_uorg.codigo_uorg, "250"));
    const [cargo] = await amb.db.select().from(e.cargo).where(eq(e.cargo.nome, "TECNICO DE LABORATORIO AREA"));
    const [sv] = await amb.db
      .insert(e.servidor)
      .values({ siape: "1110654", nome: "Marco Antônio Alves Schetino", cargo_id: cargo!.id, unidade_uorg_id: famed!.id })
      .returning();
    await entrar(amb.cliente, "coordenador_csso");
    const r = await amb.cliente.post(
      `/servidores/${sv!.id}`,
      { nome: "Marco Antônio Alves Schetino", siape: "1110655", email: "", situacao: "ATIVO" },
      { seguir: false },
    );
    expect(r.status, r.text.slice(0, 300)).toBe(303);
    const [ok, defeito] = await cadeia_integra(amb.db);
    expect(ok, `cadeia acusada no evento ${defeito}`).toBe(true);

    await entrar(amb.cliente, "auditor_interno");
    const corpo = (await amb.cliente.get("/auditoria")).text;
    expect(corpo).toContain("1110655");
    expect(corpo).toContain("eventos desta página conferem");
  });

  it("filtra por tipo de evento", async () => {
    await entrar(amb.cliente, "coordenador_csso");
    await amb.cliente.post("/servidores", { siape: "1110654", nome: "Marco" }, { seguir: false });
    const corpo = (await amb.cliente.get("/auditoria?tipo_evento=SERVIDOR_CRIADO")).text;
    expect(corpo).toContain("SERVIDOR_CRIADO");
    expect(corpo).not.toContain("LOTACAO_ALTERADA");
  });

  it("conferir a cadeia inteira grava a conferência e diz o resultado", async () => {
    await entrar(amb.cliente, "coordenador_csso");
    await amb.cliente.post("/servidores", { siape: "1110654", nome: "Marco" }, { seguir: false });
    await entrar(amb.cliente, "auditor_interno");
    const r = await amb.cliente.post("/auditoria/conferir");
    expect(r.status).toBe(200);
    expect(r.text).toContain("Cadeia conferida");
    expect(r.text).toContain("encadeamento íntegro");
    const [conf] = await amb.db.select().from(e.conferencia_cadeia).where(and(eq(e.conferencia_cadeia.integra, true)));
    expect(conf).toBeDefined();
  });

  it("conferir é POST: o GET não existe", async () => {
    await entrar(amb.cliente, "auditor_interno");
    expect((await amb.cliente.get("/auditoria/conferir")).status).toBe(404);
  });
});
