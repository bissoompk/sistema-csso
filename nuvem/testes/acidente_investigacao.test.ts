/**
 * F4 do módulo de acidentes: a investigação MAPA. Controle otimista (tela
 * velha dá 409 e nada é gravado); diff na trilha; edição travada depois do
 * relatório; linha do tempo e barreiras se desativam, não se apagam; texto com
 * CPF ou saúde é recusado; quem não investiga não edita. Dados fictícios.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import * as investigacao from "../src/servicos/acidente_investigacao.js";
import { bancoLimpo, contas, entrar, usuarioAtual, type Cliente } from "./ajuda.js";
import { em_investigacao } from "./acidente_ajuda.js";

let db: Banco;
let novoCliente: () => Cliente;

beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  novoCliente = amb.novoCliente;
  await contas(db);
});

describe("o MAPA", () => {
  it("salva com a versão lida e registra o diff, campo a campo, na trilha", async () => {
    const { oc, equipe } = await em_investigacao(db);
    const inv = await db.transaction((tx) => investigacao.obter(tx, oc));
    expect(inv.versao).toBe(1);
    const nova = await db.transaction((tx) =>
      investigacao.salvar(tx, equipe, oc, { trabalho_habitual: "Arrumação das prateleiras toda sexta.", ambiente_fator: "SIM" }, 1),
    );
    expect(nova.versao).toBe(2);
    expect(nova.trabalho_habitual).toBe("Arrumação das prateleiras toda sexta.");
    const evs = await db
      .select()
      .from(e.historico_evento)
      .where(and(eq(e.historico_evento.tipo_evento, "ACIDENTE_INVESTIGACAO_SALVA"), eq(e.historico_evento.entidade_id, oc.id)));
    expect(evs.map((x) => x.campo).sort()).toEqual(["ambiente_fator", "trabalho_habitual"]);
    // RN-19: a trilha diz qual campo mudou, nunca o texto escrito
    for (const x of evs) {
      expect(x.descricao).toBe(`${x.campo} alterado`);
      expect(x.valor_anterior).toBeNull();
      expect(x.valor_novo).toBeNull();
      expect(x.descricao).not.toContain("prateleiras");
    }
  });

  it("a tela velha é recusada (409 pela tela) e nada é gravado", async () => {
    const { oc, equipe } = await em_investigacao(db);
    await db.transaction((tx) => investigacao.salvar(tx, equipe, oc, { objetivo: "Primeira versão" }, 1));
    await expect(db.transaction((tx) => investigacao.salvar(tx, equipe, oc, { objetivo: "Por cima" }, 1))).rejects.toBeInstanceOf(
      investigacao.InvestigacaoAlterada,
    );
    const cli = await entrar(novoCliente(), "tecnico_seguranca");
    const r = await cli.post(`/acidentes/${oc.id}/investigacao`, { versao: "1", objetivo: "Digitado na tela velha" }, { seguir: false });
    expect(r.status).toBe(409);
    expect(r.text).toContain("Digitado na tela velha");
    expect(r.text).toContain("Não gravado");
    const [linha] = await db.select().from(e.acidente_investigacao).where(eq(e.acidente_investigacao.ocorrencia_id, oc.id));
    expect(linha!.objetivo).toBe("Primeira versão");
  });

  it("depois do relatório a investigação trava", async () => {
    const { oc, equipe } = await em_investigacao(db);
    await db.execute(sql`UPDATE acidente_ocorrencia SET estado = 'RELATORIO_EMITIDO' WHERE id = ${oc.id}`);
    const [travada] = await db.select().from(e.acidente_ocorrencia).where(eq(e.acidente_ocorrencia.id, oc.id));
    await expect(db.transaction((tx) => investigacao.salvar(tx, equipe, travada!, { objetivo: "x" }, 1))).rejects.toThrow(/travada/);
    await expect(
      db.transaction((tx) => investigacao.acrescentar_evento(tx, equipe, travada!, { momento: "09:00", descricao: "x" })),
    ).rejects.toThrow(/travada/);
  });

  it("recusa CPF e termo de saúde nos campos narrativos", async () => {
    const { oc, equipe } = await em_investigacao(db);
    await expect(db.transaction((tx) => investigacao.salvar(tx, equipe, oc, { sintese: "Fulano 123.456.789-09" }, 1))).rejects.toThrow(/CPF/);
    await expect(
      db.transaction((tx) => investigacao.salvar(tx, equipe, oc, { mudanca_individuo: "Estava com diagnóstico de fratura" }, 1)),
    ).rejects.toThrow(/saúde/);
  });

  it("quem não investiga não edita (secretaria tria, mas não investiga)", async () => {
    const { oc } = await em_investigacao(db);
    const secretaria = await usuarioAtual(db, "secretaria_csso");
    await expect(db.transaction((tx) => investigacao.salvar(tx, secretaria, oc, { objetivo: "x" }, 1))).rejects.toThrow();
    const cli = await entrar(novoCliente(), "secretaria_csso");
    expect((await cli.post(`/acidentes/${oc.id}/investigacao`, { versao: "1", objetivo: "x" }, { seguir: false })).status).toBe(403);
    // e a aba diz que é restrita
    expect((await cli.get(`/acidentes/${oc.id}?aba=investigacao`)).text).toContain("Restrito à equipe que investiga");
  });
});

describe("linha do tempo e barreiras", () => {
  it("acrescentam pela tela e se desativam sem apagar", async () => {
    const { oc } = await em_investigacao(db);
    const cli = await entrar(novoCliente(), "tecnico_seguranca");
    expect((await cli.post(`/acidentes/${oc.id}/investigacao/linha`, { momento: "T-10min", descricao: "Início da arrumação" }, { seguir: false })).status).toBe(303);
    expect(
      (await cli.post(`/acidentes/${oc.id}/investigacao/barreiras`, { tipo: "FISICA", situacao: "AUSENTE", descricao: "Batente na prateleira" }, { seguir: false })).status,
    ).toBe(303);
    const ficha = await cli.get(`/acidentes/${oc.id}?aba=investigacao`);
    expect(ficha.text).toContain("Início da arrumação");
    expect(ficha.text).toContain("Batente na prateleira");
    const [linha] = await db.select().from(e.acidente_evento_linha);
    await cli.post(`/acidentes/${oc.id}/investigacao/linha/${linha!.id}/desativar`, {});
    const linhas = await db.select().from(e.acidente_evento_linha);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]!.ativo).toBe(false);
    expect((await cli.get(`/acidentes/${oc.id}?aba=investigacao`)).text).not.toContain("Início da arrumação");
  });

  it("barreira com tipo fora da lista é recusada (422)", async () => {
    const { oc } = await em_investigacao(db);
    const cli = await entrar(novoCliente(), "tecnico_seguranca");
    const r = await cli.post(`/acidentes/${oc.id}/investigacao/barreiras`, { tipo: "MAGICA", situacao: "AUSENTE", descricao: "x" }, { seguir: false });
    expect(r.status).toBe(422);
  });
});
