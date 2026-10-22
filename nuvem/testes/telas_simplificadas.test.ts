/**
 * NUVEM: o que a revisão das telas de 19/10/2026 mudou — código do treinamento
 * a partir do nome, telas do titular só com servidor vinculado, habilitação
 * ligada à conta, primeiros passos do EPI e nomes legíveis.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { bancoLimpo, contas, entrar } from "./ajuda";

const { db, cliente } = await bancoLimpo();
await contas(db);

describe("telas simplificadas", () => {
  it("treinamento sem código ganha um a partir do nome, sem repetir", async () => {
    await entrar(cliente, "coordenador_csso");
    for (const _ of [1, 2]) {
      await cliente.post(
        "/treinamentos/catalogo",
        { codigo: "", nome: _ === 1 ? "Brigada de incêndio" : "Brigada de incêndio!", carga_horaria_horas: "4" },
        { seguir: false },
      );
    }
    const codigos = (await db.select().from(e.treinamento)).map((t) => t.codigo).sort();
    expect(codigos).toEqual(["BRIGADA_DE_INCENDIO", "BRIGADA_DE_INCENDIO_2"]);
  });

  it("telas do titular só aparecem para conta com servidor", async () => {
    await entrar(cliente, "coordenador_csso");
    const [conta] = await db.select().from(e.usuario).where(eq(e.usuario.login, "coordenador_csso"));
    await db.update(e.usuario).set({ servidor_id: null }).where(eq(e.usuario.id, conta!.id));
    const sem = (await cliente.get("/turmas")).text;
    expect(sem).not.toContain('href="/certificados/meus"');
    expect(sem).toContain(">Instrutores<");
    const [servidor] = await db.select().from(e.servidor).limit(1);
    if (servidor) {
      await db.update(e.usuario).set({ servidor_id: servidor.id }).where(eq(e.usuario.id, conta!.id));
      expect((await cliente.get("/turmas")).text).toContain('href="/certificados/meus"');
    }
  });

  it("a habilitação se liga a uma conta, com trilha", async () => {
    await entrar(cliente, "superintendente");
    const [h] = await db.select().from(e.profissional_habilitado).limit(1);
    const [conta] = await db.select().from(e.usuario).where(eq(e.usuario.login, "engenheiro_seguranca"));
    // a habilitação interna se liga à conta do servidor do mesmo SIAPE (D3)
    const [sv] = await db.insert(e.servidor).values({ siape: h!.siape!, nome: h!.nome }).returning();
    await db.update(e.usuario).set({ servidor_id: sv!.id }).where(eq(e.usuario.id, conta!.id));
    const r = await cliente.post(`/habilitacoes/${h!.id}/conta`, { usuario_id: String(conta!.id) }, { seguir: false });
    expect(r.status).toBe(303);
    const [depois] = await db.select().from(e.profissional_habilitado).where(eq(e.profissional_habilitado.id, h!.id));
    expect(depois!.usuario_id).toBe(conta!.id);
    const eventos = await db
      .select()
      .from(e.historico_evento)
      .where(eq(e.historico_evento.tipo_evento, "HABILITACAO_VINCULADA"));
    expect(eventos).toHaveLength(1);
    const tela = (await cliente.get("/usuarios")).text;
    expect(tela).toContain("Engenheiro de Segurança do Trabalho");
    expect(tela).not.toContain(">ENG_SEG_TRABALHO<");
  });

  it("quem só consulta não liga habilitação", async () => {
    await entrar(cliente, "secretaria_csso");
    const [h] = await db.select().from(e.profissional_habilitado).limit(1);
    const r = await cliente.post(`/habilitacoes/${h!.id}/conta`, { usuario_id: "" }, { seguir: false });
    expect(r.status).toBe(403);
  });

  it("EPI com catálogo vazio mostra os primeiros passos", async () => {
    await entrar(cliente, "coordenador_csso");
    await db.delete(e.epi_item);
    const tela = (await cliente.get("/epis")).text;
    expect(tela).toContain("Primeiros passos na gestão de EPI");
    expect(tela).not.toContain("RN-32");
  });
});
