/**
 * F7 do módulo de acidentes: encaminhar ao SIASS, decisão da perícia e
 * conclusão. Encaminhar exige relatório; a decisão é append-only (correção =
 * linha nova); concluir exige decisão ou motivo; a observação pericial recusa
 * «doença»; as pendências fecham. Dados fictícios.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import { hoje_iso } from "../src/dominio/datas.js";
import * as siass from "../src/servicos/acidente_siass.js";
import { bancoLimpo, contas, entrar, usuarioAtual, type Cliente } from "./ajuda.js";
import { com_relatorio, em_investigacao } from "./acidente_ajuda.js";

let db: Banco;
let novoCliente: () => Cliente;

beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  novoCliente = amb.novoCliente;
  await contas(db);
});

const ENC: siass.DadosEncaminhamento = { meio: "SEI", nup_sei: "23086.000123/2026-45", encaminhado_em: hoje_iso(), observacao: null };
const DEC: siass.DadosDecisao = { resultado: "ACIDENTE_EM_SERVICO_RECONHECIDO", decidida_em: hoje_iso(), numero_cat_siass: "SIASS-2026/77", observacao: "Reconhecido conforme o relatório." };

const pend = (chave: string) => db.select().from(e.pendencia).where(eq(e.pendencia.chave, chave)).then((r) => r[0]);

describe("encaminhar", () => {
  it("antes do relatório emitido não se encaminha", async () => {
    const sem = await em_investigacao(db);
    await expect(db.transaction((tx) => siass.encaminhar(tx, sem.equipe, sem.oc, ENC, sem.oc.versao))).rejects.toThrow(/relatório/);
  });

  it("com o relatório emitido leva a ENCAMINHADA_SIASS, fecha o prazo legal e abre a espera da perícia", async () => {
    const c = await com_relatorio(db);
    expect(c.oc.estado).toBe("RELATORIO_EMITIDO");
    const linha = await db.transaction((tx) => siass.encaminhar(tx, c.equipe, c.oc, ENC, c.oc.versao));
    expect(linha.meio).toBe("SEI");
    expect(linha.nup_sei).toBe("23086.000123/2026-45");
    const [rel] = await db.select().from(e.acidente_relatorio).where(eq(e.acidente_relatorio.id, linha.relatorio_id));
    expect(rel!.variante).toBe("COMPLETA");
    expect((await c.ler()).estado).toBe("ENCAMINHADA_SIASS");
    expect((await pend(`ACIDENTE_PRAZO_COMUNICACAO:${c.oc.id}`))!.concluida).toBe(true);
    const espera = await pend(`ACIDENTE_AGUARDA_PERICIA:${c.oc.id}`);
    expect(espera).toBeTruthy();
    expect(espera!.concluida).toBe(false);
  });

  it("valida meio, NUP e data; pelo SEI o NUP é obrigatório; quem não é do SIASS é recusado", async () => {
    const c = await com_relatorio(db);
    const tenta = (d: Partial<siass.DadosEncaminhamento>) => db.transaction((tx) => siass.encaminhar(tx, c.equipe, c.oc, { ...ENC, ...d }, c.oc.versao));
    await expect(tenta({ meio: "POMBO" })).rejects.toThrow(/meio/);
    await expect(tenta({ nup_sei: "123" })).rejects.toThrow(/NUP/);
    await expect(tenta({ nup_sei: null })).rejects.toThrow(/NUP/);
    await expect(tenta({ encaminhado_em: "2999-01-01" })).rejects.toThrow(/futuro/);
    const secretaria = await usuarioAtual(db, "secretaria_csso");
    await expect(db.transaction((tx) => siass.encaminhar(tx, secretaria, c.oc, ENC, c.oc.versao))).rejects.toThrow();
    expect((await c.ler()).estado).toBe("RELATORIO_EMITIDO");
  });

  it("versão velha da ocorrência recusa e nada é gravado", async () => {
    const c = await com_relatorio(db);
    await expect(db.transaction((tx) => siass.encaminhar(tx, c.equipe, c.oc, ENC, c.oc.versao - 1))).rejects.toThrow(/alterada/);
    expect(await db.select().from(e.acidente_encaminhamento)).toHaveLength(0);
  });

  it("novo encaminhamento depois do primeiro só acrescenta a linha (append-only, o estado não muda)", async () => {
    const c = await com_relatorio(db);
    await db.transaction((tx) => siass.encaminhar(tx, c.equipe, c.oc, ENC, c.oc.versao));
    const oc = await c.ler();
    await db.transaction((tx) => siass.encaminhar(tx, c.equipe, oc, { ...ENC, meio: "EMAIL_INSTITUCIONAL", nup_sei: null }, oc.versao));
    expect(await db.select().from(e.acidente_encaminhamento)).toHaveLength(2);
    expect((await c.ler()).estado).toBe("ENCAMINHADA_SIASS");
    await expect(db.execute(sql`UPDATE acidente_encaminhamento SET meio = 'PRESENCIAL'`)).rejects.toThrow();
  });
});

describe("decisão pericial", () => {
  async function encaminhada() {
    const c = await com_relatorio(db);
    await db.transaction((tx) => siass.encaminhar(tx, c.equipe, c.oc, ENC, c.oc.versao));
    return { ...c, oc: await c.ler() };
  }

  it("antes do encaminhamento não se registra decisão", async () => {
    const antes = await com_relatorio(db);
    await expect(db.transaction((tx) => siass.registrar_decisao(tx, antes.equipe, antes.oc, DEC))).rejects.toThrow(/depois do encaminhamento/);
  });

  it("registra a decisão e fecha a espera da perícia", async () => {
    const c = await encaminhada();
    const d = await db.transaction((tx) => siass.registrar_decisao(tx, c.equipe, c.oc, DEC));
    expect(d.substitui_id).toBeNull();
    expect((await pend(`ACIDENTE_AGUARDA_PERICIA:${c.oc.id}`))!.concluida).toBe(true);
  });

  it("a observação pericial recusa «doença» (RN-21), CPF e termo de saúde; resultado e número da CAT são validados", async () => {
    const c = await encaminhada();
    const tenta = (x: Partial<siass.DadosDecisao>) => db.transaction((tx) => siass.registrar_decisao(tx, c.equipe, c.oc, { ...DEC, ...x }));
    await expect(tenta({ observacao: "Doença do trabalho confirmada" })).rejects.toThrow(/saúde/);
    await expect(tenta({ observacao: "Perito fulano 123.456.789-09" })).rejects.toThrow(/CPF/);
    await expect(tenta({ resultado: "TALVEZ" })).rejects.toThrow(/resultado/);
    await expect(tenta({ numero_cat_siass: "../../etc" })).rejects.toThrow(/CAT/);
    expect(await db.select().from(e.acidente_decisao_pericial)).toHaveLength(0);
  });

  it("a correção é linha nova que aponta a anterior; nada se altera nem se apaga", async () => {
    const c = await encaminhada();
    const d1 = await db.transaction((tx) => siass.registrar_decisao(tx, c.equipe, c.oc, DEC));
    const d2 = await db.transaction((tx) => siass.registrar_decisao(tx, c.equipe, c.oc, { ...DEC, resultado: "NAO_RECONHECIDO" }));
    expect(d2.substitui_id).toBe(d1.id);
    const s = await db.transaction((tx) => siass.situacao(tx, c.oc.id));
    expect(s.decisoes.map((x) => x.vigente)).toEqual([false, true]);
    await expect(db.execute(sql`UPDATE acidente_decisao_pericial SET resultado = 'OUTRO'`)).rejects.toThrow();
    await expect(db.execute(sql`DELETE FROM acidente_decisao_pericial`)).rejects.toThrow();
  });
});

describe("concluir", () => {
  it("de ENCAMINHADA_SIASS exige a decisão OU o motivo; conclui e fecha as pendências", async () => {
    const c = await com_relatorio(db);
    await db.transaction((tx) => siass.encaminhar(tx, c.equipe, c.oc, ENC, c.oc.versao));
    let oc = await c.ler();
    await expect(db.transaction((tx) => siass.concluir(tx, c.equipe, oc, null, oc.versao))).rejects.toThrow(/decisão/);
    await db.transaction((tx) => siass.registrar_decisao(tx, c.equipe, oc, DEC));
    oc = await c.ler();
    await db.transaction((tx) => siass.concluir(tx, c.equipe, oc, null, oc.versao));
    const final = await c.ler();
    expect(final.estado).toBe("CONCLUIDA");
    expect(final.concluida_em).not.toBeNull();
    expect((await pend(`ACIDENTE_AGUARDA_PERICIA:${c.oc.id}`))!.concluida).toBe(true);
    await expect(db.transaction((tx) => siass.concluir(tx, c.equipe, final, "de novo", final.versao))).rejects.toThrow(/já está concluído/);
  });

  it("sem decisão, concluir com motivo vale", async () => {
    const c = await com_relatorio(db);
    await db.transaction((tx) => siass.encaminhar(tx, c.equipe, c.oc, ENC, c.oc.versao));
    const oc = await c.ler();
    await db.transaction((tx) => siass.concluir(tx, c.equipe, oc, "A perícia informou que não fará decisão formal.", oc.versao));
    const final = await c.ler();
    expect(final.estado).toBe("CONCLUIDA");
    expect(final.conclusao_motivo).toMatch(/perícia/);
  });

  it("direto de RELATORIO_EMITIDO só para o caso marcado «não requer CAT no SIASS», com motivo", async () => {
    const requer = await com_relatorio(db, "SIM");
    await expect(db.transaction((tx) => siass.concluir(tx, requer.equipe, requer.oc, "Sem necessidade.", requer.oc.versao))).rejects.toThrow(/não requer/);
  });

  it("caso que não requer CAT conclui direto com motivo (e sem motivo é recusado)", async () => {
    const c = await com_relatorio(db, "NAO");
    await expect(db.transaction((tx) => siass.concluir(tx, c.equipe, c.oc, null, c.oc.versao))).rejects.toThrow(/motivo/);
    await db.transaction((tx) => siass.concluir(tx, c.equipe, c.oc, "Sem afastamento e sem lesão: não requer CAT.", c.oc.versao));
    const final = await c.ler();
    expect(final.estado).toBe("CONCLUIDA");
    expect((await pend(`ACIDENTE_PRAZO_COMUNICACAO:${c.oc.id}`))!.concluida).toBe(true);
    const evs = await db.select().from(e.historico_evento).where(and(eq(e.historico_evento.tipo_evento, "ACIDENTE_CONCLUIDO"), eq(e.historico_evento.entidade_id, c.oc.id)));
    expect(evs).toHaveLength(1);
  });

  it("antes do relatório não se conclui", async () => {
    const c = await em_investigacao(db);
    await expect(db.transaction((tx) => siass.concluir(tx, c.equipe, c.oc, "x", c.oc.versao))).rejects.toThrow(/relatório/);
  });
});

describe("pela tela", () => {
  it("encaminha, registra a decisão e conclui pelos formulários; a secretaria recebe 403", async () => {
    const c = await com_relatorio(db);
    const cli = await entrar(novoCliente(), "tecnico_seguranca");
    const r1 = await cli.post(
      `/acidentes/${c.oc.id}/siass`,
      { meio: "SEI", nup_sei: "23086.000123/2026-45", encaminhado_em: hoje_iso(), versao_ocorrencia: String(c.oc.versao) },
      { seguir: false },
    );
    expect([302, 303]).toContain(r1.status);
    const aba = await cli.get(`/acidentes/${c.oc.id}?aba=siass`);
    expect(aba.text).toContain("23086.000123/2026-45");
    const r2 = await cli.post(`/acidentes/${c.oc.id}/siass/decisao`, { resultado: "OUTRO", decidida_em: hoje_iso(), observacao: "Doença" }, { seguir: false });
    expect(r2.status).toBe(422);
    const r3 = await cli.post(`/acidentes/${c.oc.id}/siass/decisao`, { resultado: "OUTRO", decidida_em: hoje_iso() }, { seguir: false });
    expect([302, 303]).toContain(r3.status);
    const oc = await c.ler();
    const r4 = await cli.post(`/acidentes/${c.oc.id}/siass/concluir`, { versao_ocorrencia: String(oc.versao) }, { seguir: false });
    expect([302, 303]).toContain(r4.status);
    expect((await c.ler()).estado).toBe("CONCLUIDA");
    const sec = await entrar(novoCliente(), "secretaria_csso");
    expect((await sec.post(`/acidentes/${c.oc.id}/siass`, { meio: "SEI" }, { seguir: false })).status).toBe(403);
  });
});
