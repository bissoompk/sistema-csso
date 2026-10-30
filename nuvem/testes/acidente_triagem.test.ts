/**
 * F1 do módulo de acidentes: a triagem. Transições pela máquina G;
 * complementação pedida e respondida (CAT/SP v2, volta à triagem);
 * retificação gera a versão nova sem regredir o estado; cancelar exige motivo;
 * o controle otimista recusa a tela velha. Dados fictícios.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import * as comunicacao from "../src/servicos/acidente_comunicacao.js";
import * as triagem from "../src/servicos/acidente_triagem.js";
import { bancoLimpo, contas, usuarioAtual } from "./ajuda.js";
import { dados, em_investigacao, titular } from "./acidente_ajuda.js";

let db: Banco;

beforeEach(async () => {
  db = (await bancoLimpo()).db;
  await contas(db);
});

async function comunicada() {
  const { usuario } = await titular(db);
  const oc = await db.transaction((tx) => comunicacao.comunicar(tx, usuario, dados()));
  return { oc, titular: usuario, equipe: await usuarioAtual(db, "tecnico_seguranca") };
}

const ler = async (id: number) => (await db.select().from(e.acidente_ocorrencia).where(eq(e.acidente_ocorrencia.id, id)))[0]!;

async function pendencia(chave: string) {
  return (await db.select().from(e.pendencia).where(eq(e.pendencia.chave, chave)))[0];
}

describe("assumir e mudar a situação", () => {
  it("assumir leva RECEBIDA à triagem, fecha a tarefa de triar e passa o prazo a quem conduz", async () => {
    const { oc, equipe } = await comunicada();
    await db.transaction((tx) => triagem.assumir(tx, equipe, oc, oc.versao));
    const agora = await ler(oc.id);
    expect(agora.estado).toBe("EM_TRIAGEM");
    expect(agora.responsavel_id).toBe(equipe.id);
    expect((await pendencia(`ACIDENTE_TRIAR:${oc.id}`))!.concluida).toBe(true);
    expect((await pendencia(`ACIDENTE_PRAZO_COMUNICACAO:${oc.id}`))!.responsavel_id).toBe(equipe.id);
  });

  it("vai à investigação só pela triagem, e abre a tarefa de investigar", async () => {
    const { oc, equipe } = await comunicada();
    await expect(db.transaction((tx) => triagem.mudar_estado(tx, equipe, oc, "EM_INVESTIGACAO", oc.versao))).rejects.toThrow();
    const a = await ler(oc.id);
    await db.transaction((tx) => triagem.mudar_estado(tx, equipe, a, "EM_TRIAGEM", a.versao));
    const b = await ler(oc.id);
    await db.transaction((tx) => triagem.mudar_estado(tx, equipe, b, "EM_INVESTIGACAO", b.versao));
    expect((await ler(oc.id)).estado).toBe("EM_INVESTIGACAO");
    expect((await pendencia(`ACIDENTE_INVESTIGAR:${oc.id}`))!.concluida).toBe(false);
  });

  it("destinos que têm ato próprio são recusados por aqui", async () => {
    const { oc, equipe } = await comunicada();
    for (const destino of ["CANCELADA", "AGUARDANDO_COMPLEMENTACAO", "CONCLUIDA", "RELATORIO_EMITIDO"]) {
      await expect(db.transaction((tx) => triagem.mudar_estado(tx, equipe, oc, destino, oc.versao))).rejects.toThrow(/botão próprio/);
    }
  });

  it("a tela velha é recusada (controle otimista)", async () => {
    const { oc, equipe } = await comunicada();
    const velha = { ...oc };
    await db.transaction((tx) => triagem.assumir(tx, equipe, oc, oc.versao));
    await expect(
      db.transaction((tx) => triagem.mudar_estado(tx, equipe, { ...velha, estado: "EM_TRIAGEM" }, "EM_INVESTIGACAO", velha.versao)),
    ).rejects.toBeInstanceOf(triagem.OcorrenciaAlterada);
  });

  it("quem não tria não assume", async () => {
    const { oc, titular: t } = await comunicada();
    await expect(db.transaction((tx) => triagem.assumir(tx, t, oc, oc.versao))).rejects.toThrow();
  });
});

describe("complementação", () => {
  it("pedida da triagem, respondida pelo comunicante: CAT/SP v2 e volta à triagem", async () => {
    const { oc, equipe, titular: t } = await comunicada();
    await db.transaction((tx) => triagem.assumir(tx, equipe, oc, oc.versao));
    const a = await ler(oc.id);
    await db.transaction((tx) => triagem.pedir_complementacao(tx, equipe, a, "Informe o equipamento usado.", a.versao));
    const b = await ler(oc.id);
    expect(b.estado).toBe("AGUARDANDO_COMPLEMENTACAO");
    const [pedido] = await db.select().from(e.acidente_complementacao).where(eq(e.acidente_complementacao.ocorrencia_id, oc.id));
    const tarefa = (await pendencia(`ACIDENTE_COMPLEMENTACAO:${pedido!.id}`))!;
    expect(tarefa.responsavel_id).toBe(t.id);

    await db.transaction((tx) => triagem.responder_complementacao(tx, t, b, "Era a pipeta automática."));
    const c = await ler(oc.id);
    expect(c.estado).toBe("EM_TRIAGEM");
    expect(c.cat_sp_versao).toBe(2);
    const [v2] = await db
      .select()
      .from(e.acidente_cat_sp)
      .where(and(eq(e.acidente_cat_sp.ocorrencia_id, oc.id), eq(e.acidente_cat_sp.versao, 2)));
    expect(v2!.origem).toBe("COMPLEMENTACAO");
    expect((v2!.contexto_congelado as comunicacao.ContextoCatSp).complementacoes[0]!.resposta).toBe("Era a pipeta automática.");
    expect((await pendencia(`ACIDENTE_COMPLEMENTACAO:${pedido!.id}`))!.concluida).toBe(true);
  });

  it("quem não comunicou nem é o acidentado não responde", async () => {
    const { oc, equipe } = await comunicada();
    await db.transaction((tx) => triagem.assumir(tx, equipe, oc, oc.versao));
    const a = await ler(oc.id);
    await db.transaction((tx) => triagem.pedir_complementacao(tx, equipe, a, "Falta o local exato.", a.versao));
    const outro = await usuarioAtual(db, "secretaria_csso");
    const b = await ler(oc.id);
    await expect(db.transaction((tx) => triagem.responder_complementacao(tx, outro, b, "x"))).rejects.toThrow(
      /Só quem comunicou/,
    );
  });

  it("a equipe retoma sem resposta: a tarefa do comunicante fecha", async () => {
    const { oc, equipe } = await comunicada();
    await db.transaction((tx) => triagem.assumir(tx, equipe, oc, oc.versao));
    const a = await ler(oc.id);
    await db.transaction((tx) => triagem.pedir_complementacao(tx, equipe, a, "Falta o local exato.", a.versao));
    const b = await ler(oc.id);
    await db.transaction((tx) => triagem.mudar_estado(tx, equipe, b, "EM_TRIAGEM", b.versao));
    const [pedido] = await db.select().from(e.acidente_complementacao).where(eq(e.acidente_complementacao.ocorrencia_id, oc.id));
    expect((await pendencia(`ACIDENTE_COMPLEMENTACAO:${pedido!.id}`))!.concluida).toBe(true);
  });
});

describe("retificar", () => {
  it("gera a versão nova, muda os fatos e NÃO regride o estado", async () => {
    const { oc, equipe } = await comunicada();
    await db.transaction((tx) => triagem.assumir(tx, equipe, oc, oc.versao));
    const a = await ler(oc.id);
    await db.transaction((tx) => triagem.mudar_estado(tx, equipe, a, "EM_INVESTIGACAO", a.versao));
    const b = await ler(oc.id);
    const d = dados();
    d.fatos.local_especificacao = "Laboratório de química, bancada 5";
    await db.transaction((tx) => triagem.retificar(tx, equipe, b, { fatos: d.fatos, relato: d.relato, motivo: "Bancada errada" }, b.versao));
    const c = await ler(oc.id);
    expect(c.estado).toBe("EM_INVESTIGACAO");
    expect(c.cat_sp_versao).toBe(2);
    expect(c.local_especificacao).toBe("Laboratório de química, bancada 5");
    const versoes = await db.select().from(e.acidente_cat_sp).where(eq(e.acidente_cat_sp.ocorrencia_id, oc.id));
    expect(versoes.map((v) => v.origem).sort()).toEqual(["COMUNICACAO", "RETIFICACAO_SST"]);
  });

  it("sem motivo, ou sem nada mudado, é recusada", async () => {
    const { oc, equipe } = await comunicada();
    const d = dados();
    await expect(db.transaction((tx) => triagem.retificar(tx, equipe, oc, { fatos: d.fatos, relato: d.relato, motivo: "" }, oc.versao))).rejects.toThrow(
      /motivo/,
    );
    await expect(
      db.transaction((tx) => triagem.retificar(tx, equipe, oc, { fatos: d.fatos, relato: d.relato, motivo: "conferência" }, oc.versao)),
    ).rejects.toThrow(/Nada mudou/);
  });

  it("os fatos não mudam sem versão nova da CAT/SP (a trava do banco)", async () => {
    const { oc } = await comunicada();
    await expect(
      db.update(e.acidente_ocorrencia).set({ local_especificacao: "outra" }).where(eq(e.acidente_ocorrencia.id, oc.id)),
    ).rejects.toThrow();
  });
});

describe("cancelar e prorrogar", () => {
  it("cancelar exige motivo da lista (e texto no 'outro'), fecha as tarefas e encerra", async () => {
    const { oc, equipe } = await comunicada();
    await expect(db.transaction((tx) => triagem.cancelar(tx, equipe, oc, "", null, oc.versao))).rejects.toThrow(/motivo/);
    await expect(db.transaction((tx) => triagem.cancelar(tx, equipe, oc, "OUTRO", null, oc.versao))).rejects.toThrow(/explique/);
    await db.transaction((tx) => triagem.cancelar(tx, equipe, oc, "DUPLICADA", null, oc.versao));
    const c = await ler(oc.id);
    expect(c.estado).toBe("CANCELADA");
    expect(c.cancelamento_motivo).toBe("DUPLICADA");
    const abertas = await db
      .select()
      .from(e.pendencia)
      .where(and(eq(e.pendencia.entidade_id, oc.id), eq(e.pendencia.entidade, "acidente_ocorrencia"), eq(e.pendencia.concluida, false)));
    expect(abertas).toHaveLength(0);
    await expect(db.transaction((tx) => triagem.assumir(tx, equipe, c, c.versao))).rejects.toThrow(/encerrada/);
  });

  it("em investigação já não se cancela", async () => {
    const { oc, equipe } = await comunicada();
    await db.transaction((tx) => triagem.assumir(tx, equipe, oc, oc.versao));
    const a = await ler(oc.id);
    await db.transaction((tx) => triagem.mudar_estado(tx, equipe, a, "EM_INVESTIGACAO", a.versao));
    const b = await ler(oc.id);
    await expect(db.transaction((tx) => triagem.cancelar(tx, equipe, b, "DUPLICADA", null, b.versao))).rejects.toThrow(/investigação/);
  });

  it("prorrogar fica ao lado do prazo legal, com motivo, e move a tarefa", async () => {
    const { oc, equipe } = await comunicada();
    const depois = (await import("../src/dominio/datas.js")).somar_dias(oc.prazo_comunicacao, 5);
    await db.transaction((tx) => triagem.prorrogar_prazo(tx, equipe, oc, depois, "Aguardando o atestado do SIASS", oc.versao));
    const c = await ler(oc.id);
    expect(c.prazo_comunicacao).toBe(oc.prazo_comunicacao);
    expect(c.prazo_prorrogado_ate).toBe(depois);
    expect((await pendencia(`ACIDENTE_PRAZO_COMUNICACAO:${oc.id}`))!.prazo).toBe(depois);
  });
});

describe("reabrir a investigação (coordenação)", () => {
  it("só a coordenação reabre caso com relatório emitido, por motivo da lista; a investigação destrava", async () => {
    const { oc, equipe } = await em_investigacao(db);
    const coord = await usuarioAtual(db, "coordenador_csso");
    await db.update(e.acidente_ocorrencia).set({ estado: "RELATORIO_EMITIDO" }).where(eq(e.acidente_ocorrencia.id, oc.id));
    const emitida = await ler(oc.id);
    await expect(db.transaction((tx) => triagem.reabrir(tx, equipe, emitida, "INFORMACAO_NOVA", emitida.versao))).rejects.toThrow(
      /com a coordenação/,
    );
    await expect(db.transaction((tx) => triagem.reabrir(tx, coord, emitida, "porque sim", emitida.versao))).rejects.toThrow(/motivo/);
    await db.transaction((tx) => triagem.reabrir(tx, coord, emitida, "INFORMACAO_NOVA", emitida.versao));
    expect((await ler(oc.id)).estado).toBe("EM_INVESTIGACAO");
    const [ev] = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "ACIDENTE_REABERTO"));
    expect(ev!.descricao).toContain("INFORMACAO_NOVA");
    // em investigação não há o que reabrir
    const aberta = await ler(oc.id);
    await expect(db.transaction((tx) => triagem.reabrir(tx, coord, aberta, "OUTRO", aberta.versao))).rejects.toThrow(/não está num ponto/);
  });
});
