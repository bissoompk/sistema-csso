/**
 * F5 do módulo de acidentes: o plano de ação. Número estável; máquina de
 * estado; concluir exige o que foi feito e cancelar exige o motivo; pendência
 * por ação que fecha ao concluir ou cancelar; nunca se apaga; versão velha dá
 * conflito; texto com CPF ou saúde é recusado; quem não investiga não mexe.
 * Dados fictícios.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import { somar_dias, hoje_iso } from "../src/dominio/datas.js";
import * as plano from "../src/servicos/acidente_acao.js";
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

const BASE: plano.DadosAcao = {
  achado: "Piso molhado sem sinalização",
  acao: "Instalar sinalização de piso molhado na entrada do laboratório",
  tipo_acao: "SINALIZACAO",
  responsavel_usuario_id: null,
  responsavel_unidade_uorg_id: null,
  responsavel_texto: "Chefia do laboratório",
  prazo: somar_dias(hoje_iso(), 15),
  prioridade: "ALTA",
};

const pendencia = (acao_id: number) =>
  db.select().from(e.pendencia).where(eq(e.pendencia.chave, `ACIDENTE_ACAO_PRAZO:${acao_id}`)).then((r) => r[0]);

describe("criar", () => {
  it("numera em sequência no caso e abre uma pendência por ação, com o prazo da ação", async () => {
    const { oc, equipe } = await em_investigacao(db);
    const a1 = await db.transaction((tx) => plano.criar(tx, equipe, oc, BASE));
    const a2 = await db.transaction((tx) => plano.criar(tx, equipe, oc, { ...BASE, acao: "Revisar o procedimento de limpeza" }));
    expect([a1.numero, a2.numero]).toEqual([1, 2]);
    expect(a1.estado).toBe("PENDENTE");
    const p = await pendencia(a1.id);
    expect(p).toBeTruthy();
    expect(p!.prazo).toBe(BASE.prazo);
    expect(p!.responsavel_id).toBe(oc.responsavel_id);
    expect(p!.concluida).toBe(false);
  });

  it("recusa prazo no passado, tipo inválido, ação vazia, CPF e termo de saúde", async () => {
    const { oc, equipe } = await em_investigacao(db);
    const tenta = (d: Partial<plano.DadosAcao>) => db.transaction((tx) => plano.criar(tx, equipe, oc, { ...BASE, ...d }));
    await expect(tenta({ prazo: somar_dias(hoje_iso(), -1) })).rejects.toThrow(/passado/);
    await expect(tenta({ tipo_acao: "XYZ" })).rejects.toThrow(/tipo/);
    await expect(tenta({ acao: "  " })).rejects.toThrow(/Informe a ação/);
    await expect(tenta({ acao: "Orientar fulano 123.456.789-09" })).rejects.toThrow(/CPF/);
    await expect(tenta({ achado: "Estava com diagnóstico de fratura" })).rejects.toThrow(/saúde/);
  });

  it("quem não investiga não cria (secretaria)", async () => {
    const { oc } = await em_investigacao(db);
    const secretaria = await usuarioAtual(db, "secretaria_csso");
    await expect(db.transaction((tx) => plano.criar(tx, secretaria, oc, BASE))).rejects.toThrow();
  });

  it("caso cancelado não recebe ação", async () => {
    const { oc, equipe } = await em_investigacao(db);
    await db.execute(sql`UPDATE acidente_ocorrencia SET estado = 'CANCELADA', cancelamento_motivo = 'DUPLICADA' WHERE id = ${oc.id}`);
    const [cancelada] = await db.select().from(e.acidente_ocorrencia).where(eq(e.acidente_ocorrencia.id, oc.id));
    await expect(db.transaction((tx) => plano.criar(tx, equipe, cancelada!, BASE))).rejects.toThrow(/cancelada/);
  });

  it("depois do relatório o plano continua aceitando ação (a prevenção acompanha)", async () => {
    const { oc, equipe } = await em_investigacao(db);
    await db.execute(sql`UPDATE acidente_ocorrencia SET estado = 'RELATORIO_EMITIDO' WHERE id = ${oc.id}`);
    const [emitido] = await db.select().from(e.acidente_ocorrencia).where(eq(e.acidente_ocorrencia.id, oc.id));
    const a = await db.transaction((tx) => plano.criar(tx, equipe, emitido!, BASE));
    expect(a.numero).toBe(1);
  });
});

describe("a máquina de estado", () => {
  it("PENDENTE → EM_ANDAMENTO → CONCLUIDA fecha a pendência; concluir exige o que foi feito", async () => {
    const { oc, equipe } = await em_investigacao(db);
    const a = await db.transaction((tx) => plano.criar(tx, equipe, oc, BASE));
    await expect(db.transaction((tx) => plano.concluir(tx, equipe, oc, a.id, "feito", null, 1))).rejects.toThrow(/não pode ir/);
    const b = await db.transaction((tx) => plano.iniciar(tx, equipe, oc, a.id, 1));
    expect(b.estado).toBe("EM_ANDAMENTO");
    expect(b.versao).toBe(2);
    await expect(db.transaction((tx) => plano.concluir(tx, equipe, oc, a.id, "  ", null, 2))).rejects.toThrow(/o que foi feito/);
    const c = await db.transaction((tx) => plano.concluir(tx, equipe, oc, a.id, "Placas instaladas na entrada.", null, 2));
    expect(c.estado).toBe("CONCLUIDA");
    expect(c.concluida_em).not.toBeNull();
    expect((await pendencia(a.id))!.concluida).toBe(true);
    const evs = await db.select().from(e.historico_evento).where(and(eq(e.historico_evento.tipo_evento, "ACIDENTE_ACAO_CONCLUIDA"), eq(e.historico_evento.entidade_id, oc.id)));
    expect(evs).toHaveLength(1);
  });

  it("concluir com evidência guarda o anexo na ação", async () => {
    const { oc, equipe } = await em_investigacao(db);
    const a = await db.transaction((tx) => plano.criar(tx, equipe, oc, BASE));
    await db.transaction((tx) => plano.iniciar(tx, equipe, oc, a.id, 1));
    const pdf = new TextEncoder().encode("%PDF-1.4 evidencia ficticia");
    const c = await db.transaction((tx) => plano.concluir(tx, equipe, oc, a.id, "Feito.", { nome: "foto.pdf", conteudo: pdf }, 2));
    expect(c.conclusao_anexo_id).not.toBeNull();
    await expect(
      db.transaction((tx) => plano.concluir(tx, equipe, oc, a.id, "Feito.", { nome: "x.exe", conteudo: new Uint8Array([1, 2, 3]) }, 3)),
    ).rejects.toThrow();
  });

  it("cancelar exige o motivo, fecha a pendência e a ação continua no plano", async () => {
    const { oc, equipe } = await em_investigacao(db);
    const a = await db.transaction((tx) => plano.criar(tx, equipe, oc, BASE));
    await expect(db.transaction((tx) => plano.cancelar(tx, equipe, oc, a.id, "", 1))).rejects.toThrow(/motivo/);
    const c = await db.transaction((tx) => plano.cancelar(tx, equipe, oc, a.id, "Medida substituída pela obra do piso.", 1));
    expect(c.estado).toBe("CANCELADA");
    expect((await pendencia(a.id))!.concluida).toBe(true);
    const todas = await db.transaction((tx) => plano.do_caso(tx, oc.id));
    expect(todas).toHaveLength(1);
    // terminada, não se altera nem volta
    await expect(db.transaction((tx) => plano.iniciar(tx, equipe, oc, a.id, 2))).rejects.toThrow(/não pode ir/);
    await expect(db.transaction((tx) => plano.alterar(tx, equipe, oc, a.id, BASE, 2))).rejects.toThrow(/já terminou/);
  });

  it("nunca se apaga: o banco recusa o delete", async () => {
    const { oc, equipe } = await em_investigacao(db);
    const a = await db.transaction((tx) => plano.criar(tx, equipe, oc, BASE));
    await expect(db.execute(sql`DELETE FROM acidente_acao WHERE id = ${a.id}`)).rejects.toThrow();
  });
});

describe("alterar", () => {
  it("grava o diff por campo, move o prazo da pendência e sobe a versão", async () => {
    const { oc, equipe } = await em_investigacao(db);
    const a = await db.transaction((tx) => plano.criar(tx, equipe, oc, BASE));
    const novo_prazo = somar_dias(hoje_iso(), 40);
    const b = await db.transaction((tx) => plano.alterar(tx, equipe, oc, a.id, { ...BASE, prazo: novo_prazo, prioridade: "BAIXA" }, 1));
    expect(b.versao).toBe(2);
    expect((await pendencia(a.id))!.prazo).toBe(novo_prazo);
    const evs = await db.select().from(e.historico_evento).where(and(eq(e.historico_evento.tipo_evento, "ACIDENTE_ACAO_ALTERADA"), eq(e.historico_evento.entidade_id, oc.id)));
    expect(evs.map((x) => x.campo).sort()).toEqual(["prazo", "prioridade"]);
  });

  it("versão velha dá conflito e nada é gravado", async () => {
    const { oc, equipe } = await em_investigacao(db);
    const a = await db.transaction((tx) => plano.criar(tx, equipe, oc, BASE));
    await db.transaction((tx) => plano.alterar(tx, equipe, oc, a.id, { ...BASE, prioridade: "BAIXA" }, 1));
    await expect(
      db.transaction((tx) => plano.alterar(tx, equipe, oc, a.id, { ...BASE, prioridade: "MEDIA" }, 1)),
    ).rejects.toBeInstanceOf(plano.AcaoAlterada);
    const [linha] = await db.select().from(e.acidente_acao).where(eq(e.acidente_acao.id, a.id));
    expect(linha!.prioridade).toBe("BAIXA");
  });

  it("ação de outro caso não é achada", async () => {
    const um = await em_investigacao(db);
    const a = await db.transaction((tx) => plano.criar(tx, um.equipe, um.oc, BASE));
    const comunicar = await import("../src/servicos/acidente_comunicacao.js");
    const { dados } = await import("./acidente_ajuda.js");
    const titular_ = await usuarioAtual(db, "servidor_consulta");
    const outra = await db.transaction((tx) => comunicar.comunicar(tx, titular_, dados()));
    const outro = { oc: outra, equipe: um.equipe };
    await expect(db.transaction((tx) => plano.iniciar(tx, outro.equipe, outro.oc, a.id, 1))).rejects.toBeInstanceOf(plano.AcaoInexistente);
  });
});

describe("pela tela", () => {
  it("a aba lista a ação e o formulário cria; a lista geral mostra as vencidas", async () => {
    const { oc } = await em_investigacao(db);
    const cli = await entrar(novoCliente(), "tecnico_seguranca");
    const r = await cli.post(
      `/acidentes/${oc.id}/acoes`,
      { acao: "Revisar a escala de limpeza do laboratório", tipo_acao: "PROCEDIMENTO", prioridade: "MEDIA", prazo: somar_dias(hoje_iso(), 5) },
      { seguir: false },
    );
    expect([302, 303]).toContain(r.status);
    const aba = await cli.get(`/acidentes/${oc.id}?aba=acoes`);
    expect(aba.text).toContain("Revisar a escala de limpeza");
    const geral = await cli.get("/acidentes/acoes");
    expect(geral.status).toBe(200);
    expect(geral.text).toContain(oc.protocolo);
    // vencida só com prazo passado
    await db.execute(sql`UPDATE acidente_acao SET prazo = ${somar_dias(hoje_iso(), -3)} WHERE ocorrencia_id = ${oc.id}`);
    const venc = await cli.get("/acidentes/acoes?mostrar=vencidas");
    expect(venc.text).toContain("vencida");
  });

  it("recusa volta à aba com erro (422) e a secretaria não cria (403)", async () => {
    const { oc } = await em_investigacao(db);
    const cli = await entrar(novoCliente(), "tecnico_seguranca");
    const r = await cli.post(`/acidentes/${oc.id}/acoes`, { acao: "", tipo_acao: "EPI", prioridade: "ALTA" }, { seguir: false });
    expect(r.status).toBe(422);
    const sec = await entrar(novoCliente(), "secretaria_csso");
    expect((await sec.post(`/acidentes/${oc.id}/acoes`, { acao: "x", tipo_acao: "EPI", prioridade: "ALTA" }, { seguir: false })).status).toBe(403);
  });
});
