/**
 * Pedido do titular sobre o "quero ser avisado" (LGPD art. 18): a equipe
 * consulta por e-mail (contagem por tipo) e apaga; a consulta e o apagamento
 * ficam na trilha sem o e-mail; servidor comum não abre. Dados fictícios.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { bancoLimpo, contas, entrar } from "./ajuda";

const EMAIL = "titular.ficticio@exemplo.test";

const { db, novoCliente } = await bancoLimpo();
await contas(db);

async function _cadastros(email: string, n = 2) {
  const tipos = ["QUALQUER", "SETOR"] as const;
  const [campus] = await db.insert(e.campus).values({ sigla: `C${Math.random().toString(36).slice(2, 6)}`, nome: "Campus T", cidade: "Diamantina" }).returning();
  const [setor] = await db.insert(e.unidade_uorg).values({ sigla: `T${Math.random().toString(36).slice(2, 6)}`, nome_oficial: "SETOR T", nome_extenso: "Setor T", tipo: "INSTITUTO", campus_id: campus!.id }).returning();
  for (let i = 0; i < n; i++) {
    await db.insert(e.aviso_interesse).values({
      nome: "Pessoa Fictícia",
      email,
      email_normalizado: email.toLowerCase(),
      tipo: tipos[i]!,
      unidade_id: tipos[i] === "SETOR" ? setor!.id : null,
      consentimento_em: new Date(),
      consentimento_versao: "2026-10",
      confirmado_em: i === 0 ? new Date() : null,
    });
  }
}

describe("pedido do titular (aviso da vitrine)", () => {
  beforeEach(async () => {
    await db.delete(e.aviso_interesse);
  });

  it("consulta mostra a contagem por tipo e grava a trilha sem o e-mail", async () => {
    await _cadastros(EMAIL);
    const cli = await entrar(novoCliente(), "coordenador_csso");
    expect((await cli.get("/turmas/vitrine/titular", { seguir: false })).status).toBe(200);
    const r = await cli.post("/turmas/vitrine/titular/consultar", { email: EMAIL.toUpperCase() }, { seguir: false });
    expect(r.status).toBe(200);
    expect(r.text).toContain("Qualquer curso");
    expect(r.text).toContain("Aguardando confirmação");
    const trilha = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "AVISO_INTERESSE_CONSULTADO"));
    expect(trilha).toHaveLength(1);
    expect(trilha[0]!.descricao).toContain("2 cadastro(s)");
    expect(JSON.stringify(trilha)).not.toContain("exemplo.test");
  });

  it("apagar remove todos os cadastros do e-mail e só dele", async () => {
    await _cadastros(EMAIL);
    await _cadastros("outra.ficticia@exemplo.test", 1);
    const cli = await entrar(novoCliente(), "coordenador_csso");
    const r = await cli.post("/turmas/vitrine/titular/apagar", { email: EMAIL }, { seguir: false });
    expect(r.status).toBe(200);
    expect(r.text).toContain("2 cadastro(s) apagado(s)");
    const sobrou = await db.select().from(e.aviso_interesse);
    expect(sobrou).toHaveLength(1);
    expect(sobrou[0]!.email_normalizado).toBe("outra.ficticia@exemplo.test");
    const trilha = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "AVISO_INTERESSE_APAGADO"));
    expect(trilha).toHaveLength(1);
    expect(JSON.stringify(trilha)).not.toContain("exemplo.test");
  });

  it("e-mail inválido volta com recado; servidor comum recebe 403", async () => {
    const cli = await entrar(novoCliente(), "coordenador_csso");
    const r = await cli.post("/turmas/vitrine/titular/consultar", { email: "sem-arroba" }, { seguir: false });
    expect(r.text).toContain("Informe um e-mail válido.");
    const srv = await entrar(novoCliente(), "servidor_consulta");
    expect((await srv.get("/turmas/vitrine/titular", { seguir: false })).status).toBe(403);
    expect((await srv.post("/turmas/vitrine/titular/apagar", { email: EMAIL }, { seguir: false })).status).toBe(403);
  });
});
