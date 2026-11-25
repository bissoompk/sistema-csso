/**
 * Lote 3 (24/11/2026): a carga em HORAS ou TEMPOS pela porta da frente — catálogo, turma, carga por
 * dia, presença e a conferência com o horário. Resolve T2 (carga × horário), T3 (presença sem perda),
 * T5 (limite do dia) e T13 (exibição única).
 */
import { asc, desc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { bancoLimpo, contas, entrar, type Cliente, type Resposta } from "./ajuda";
import type { Banco } from "../src/db/cliente";
import * as e from "../src/db/esquema/index";
import { somar_dias } from "../src/dominio/datas";
import { hoje } from "../src/servicos/datas_br";
import { TURMA_CARGA_POR_DIA } from "../src/servicos/carga_turma";

const INICIO = somar_dias(hoje(), -3);
const dia = (n: number) => somar_dias(INICIO, n);
const FUTURO = somar_dias(hoje(), 20);

let { db, novoCliente } = await bancoLimpo();
let cliente: Cliente;

beforeEach(async () => {
  ({ db, novoCliente } = await bancoLimpo());
  await contas(db);
  cliente = novoCliente();
  await entrar(cliente, "coordenador_csso");
});

async function mensagem(r: Resposta): Promise<string> {
  expect(r.status, r.text.slice(0, 500)).toBe(303);
  return (await cliente.get(r.location!)).text;
}

async function catalogo(d: Record<string, string>): Promise<number> {
  const r = await cliente.post(
    "/treinamentos/catalogo",
    { codigo: "BRIG", nome: "Brigada de Incêndio — CBMMG", validade_meses: "12", ...d },
    { seguir: false },
  );
  expect(r.status, r.text.slice(0, 500)).toBe(303);
  const [t] = await db.select().from(e.treinamento).orderBy(desc(e.treinamento.id)).limit(1);
  return t!.id;
}

async function abrir_turma(treinamento_id: number, d: Record<string, string> = {}): Promise<Resposta> {
  return cliente.post(
    "/turmas",
    { treinamento_id: String(treinamento_id), data_inicio: INICIO, data_fim: dia(1), local: "Pátio", frequencia_minima_percentual: "75", ...d },
    { seguir: false },
  );
}

async function turma(treinamento_id: number, d: Record<string, string> = {}): Promise<number> {
  const r = await abrir_turma(treinamento_id, d);
  expect(r.status, r.text.slice(0, 800)).toBe(303);
  const [t] = await db.select().from(e.turma).orderBy(desc(e.turma.id)).limit(1);
  return t!.id;
}

async function em_andamento(turma_id: number) {
  for (const destino of ["INSCRICOES_ABERTAS", "EM_ANDAMENTO"]) {
    expect((await cliente.post(`/turmas/${turma_id}/situacao`, { destino }, { seguir: false })).status).toBe(303);
  }
}

async function inscrever(turma_id: number, siape: string, nome: string): Promise<number> {
  const [s] = await db.insert(e.servidor).values({ siape, nome }).returning();
  const r = await cliente.post(`/turmas/${turma_id}/inscricoes`, { servidor_id: String(s!.id) }, { seguir: false });
  expect(r.status, r.text.slice(0, 500)).toBe(303);
  const [i] = await db.select().from(e.inscricao).orderBy(desc(e.inscricao.id)).limit(1);
  return i!.id;
}

function lancar(turma_id: number, inscricao_id: number, campos: Record<string, string>) {
  return cliente.post(
    `/turmas/${turma_id}/presencas`,
    { inscricao_id: String(inscricao_id), data: INICIO, presente: "1", ...campos },
    { seguir: false },
  );
}

function carga_por_dia(turma_id: number, por_dia: Record<string, string>, extra: Record<string, string> = {}) {
  const campos = Object.fromEntries(Object.entries(por_dia).map(([d, v]) => [`carga_dia_${d}`, v]));
  return cliente.post(`/turmas/${turma_id}/carga-por-dia`, { ...campos, ...extra }, { seguir: false });
}

async function presencas(inscricao_id: number) {
  return db.select().from(e.turma_presenca).where(eq(e.turma_presenca.inscricao_id, inscricao_id)).orderBy(asc(e.turma_presenca.data));
}

async function frequencia(inscricao_id: number) {
  const [i] = await db.select().from(e.inscricao).where(eq(e.inscricao.id, inscricao_id));
  return i!.frequencia_percentual;
}

async function dias_gravados(turma_id: number) {
  return (await db.select().from(e.turma_carga_dia).where(eq(e.turma_carga_dia.turma_id, turma_id)).orderBy(asc(e.turma_carga_dia.data))).map(
    (c) => [c.data, c.quantidade],
  );
}

describe("catálogo: a unidade da carga", () => {
  it("tempos são inteiros, e o catálogo mostra '10 tempos'", async () => {
    const quebrado = await cliente.post(
      "/treinamentos/catalogo",
      { codigo: "BRIG", nome: "Brigada", carga_horaria_horas: "2,5", carga_unidade: "TEMPOS", validade_meses: "12" },
      { seguir: false },
    );
    expect(quebrado.text).toContain("Carga em tempos inválida: informe um número inteiro de tempos maior que zero.");
    const id = await catalogo({ carga_horaria_horas: "10", carga_unidade: "TEMPOS" });
    const [t] = await db.select().from(e.treinamento).where(eq(e.treinamento.id, id));
    expect([t!.carga_unidade, Number(t!.carga_horaria_horas)]).toEqual(["TEMPOS", 10]);
    const tela = (await cliente.get("/treinamentos/catalogo")).text;
    expect(tela).toContain("10 tempos");
    expect(tela).not.toMatch(/10 h\b/);
  });

  it("horas aceitam 4h30; sem unidade é HORAS; a trilha escreve a carga pela função única", async () => {
    const id = await catalogo({ carga_horaria_horas: "4h30" });
    const [t] = await db.select().from(e.treinamento).where(eq(e.treinamento.id, id));
    expect([t!.carga_unidade, t!.carga_horaria_horas]).toEqual(["HORAS", "4.5"]);
    const [ev] = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "TREINAMENTO_CRIADO"));
    expect(ev!.descricao).toContain("4h30 · validade");
    expect((await cliente.get("/treinamentos/catalogo")).text).toContain("4h30");
  });

  it("a unidade não muda depois que o treinamento tem turma", async () => {
    const id = await catalogo({ carga_horaria_horas: "8" });
    const sem_turma = await cliente.post(
      `/treinamentos/catalogo/${id}`,
      { nome: "Brigada de Incêndio — CBMMG", carga_horaria_horas: "10", carga_unidade: "TEMPOS", validade_meses: "12", ativo: "1" },
      { seguir: false },
    );
    expect(sem_turma.status).toBe(303);
    expect((await db.select().from(e.treinamento).where(eq(e.treinamento.id, id)))[0]!.carga_unidade).toBe("TEMPOS");
    await turma(id);
    const com_turma = await cliente.post(
      `/treinamentos/catalogo/${id}`,
      { nome: "Brigada de Incêndio — CBMMG", carga_horaria_horas: "8", carga_unidade: "HORAS", validade_meses: "12", ativo: "1" },
      { seguir: false },
    );
    expect(com_turma.text).toContain("A unidade da carga não muda depois que o treinamento tem turma (1)");
    expect((await db.select().from(e.treinamento).where(eq(e.treinamento.id, id)))[0]!.carga_unidade).toBe("TEMPOS");
  });
});

describe("turma em TEMPOS: carga por dia", () => {
  it("nasce com a unidade e a divisão automática gravada (3 tempos em 2 dias: 2 + 1)", async () => {
    const id = await turma(await catalogo({ carga_horaria_horas: "3", carga_unidade: "TEMPOS" }));
    const [t] = await db.select().from(e.turma).where(eq(e.turma.id, id));
    expect(t!.carga_unidade).toBe("TEMPOS");
    expect(await dias_gravados(id)).toEqual([[INICIO, 2], [dia(1), 1]]);
    const ficha = (await cliente.get(`/turmas/${id}`)).text;
    expect(ficha).toContain("3 tempos");
    expect(ficha).toContain('name="carga_dia_' + INICIO + '"');
  });

  it("a soma dos dias tem de ser a carga; corrigida, grava e a trilha registra", async () => {
    const id = await turma(await catalogo({ carga_horaria_horas: "3", carga_unidade: "TEMPOS" }));
    const errada = await mensagem(await carga_por_dia(id, { [INICIO]: "1", [dia(1)]: "1" }));
    expect(errada).toContain("A soma dos dias (1 + 1 = 2 tempos) tem de ser igual à carga da turma (3 tempos).");
    expect(await dias_gravados(id)).toEqual([[INICIO, 2], [dia(1), 1]]);
    const meio = await mensagem(await carga_por_dia(id, { [INICIO]: "1,5", [dia(1)]: "1,5" }));
    expect(meio).toContain("número inteiro de tempos");
    expect(await mensagem(await carga_por_dia(id, { [INICIO]: "1", [dia(1)]: "2" }))).toContain("carga por dia salva");
    expect(await dias_gravados(id)).toEqual([[INICIO, 1], [dia(1), 2]]);
    const [ev] = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, TURMA_CARGA_POR_DIA));
    expect(ev!.descricao).toContain(`${INICIO.split("-").reverse().join("/")}: 1 tempo`);
    expect(ev!.descricao).toContain("(antes:");
  });

  it("carga de tempos quebrada na turma é recusada", async () => {
    const t = await catalogo({ carga_horaria_horas: "10", carga_unidade: "TEMPOS" });
    const r = await abrir_turma(t, { carga_horaria_horas: "9,5" });
    expect(r.text).toContain("número inteiro de tempos");
    expect(await db.select().from(e.turma)).toHaveLength(0);
  });
});

describe("presença em tempos inteiros e o limite do dia (T5)", () => {
  async function turma_de_10_tempos() {
    const id = await turma(await catalogo({ carga_horaria_horas: "10", carga_unidade: "TEMPOS" }));
    await em_andamento(id);
    const i = await inscrever(id, "1110654", "Marco Antônio");
    return { id, i };
  }

  it("tempo quebrado é recusado; o dia não passa da carga daquele dia; a frequência sai em tempos", async () => {
    const { id, i } = await turma_de_10_tempos();
    expect(await mensagem(await lancar(id, i, { horas: "2,5" }))).toContain("número inteiro de tempos");
    // a carga do dia é 5 (10 em 2 dias): 6 num dia só é recusado, mesmo cabendo nos 10 da turma
    expect(await mensagem(await lancar(id, i, { horas: "6" }))).toContain("6 tempos em");
    expect(await presencas(i)).toEqual([]);
    await mensagem(await lancar(id, i, { horas: "5" }));
    await mensagem(await lancar(id, i, { data: dia(1), horas: "3" }));
    expect((await presencas(i)).map((p) => p.quantidade)).toEqual([5, 3]);
    expect(await frequencia(i)).toBe("80.00");
  });

  it("a grade mostra tempos, nunca horas", async () => {
    const { id, i } = await turma_de_10_tempos();
    await mensagem(await lancar(id, i, { horas: "5" }));
    const grade = (await cliente.get(`/turmas/${id}?aba=presencas`)).text;
    expect(grade).toContain("10 tempos");
    expect(grade).toContain("Tempos presentes");
    expect(grade).toContain('<td class="mono">5 tempos</td>');
    expect(grade).toContain("ajustar tempos");
    expect(grade).not.toMatch(/\d h\b|\d+h\d\d|\bhoras presentes/);
  });

  it("o limite do dia vale para a carga por dia ajustada (6 + 4)", async () => {
    const { id, i } = await turma_de_10_tempos();
    await mensagem(await carga_por_dia(id, { [INICIO]: "6", [dia(1)]: "4" }));
    await mensagem(await lancar(id, i, { horas: "6" }));
    expect(await mensagem(await lancar(id, i, { data: dia(1), horas: "5" }))).toContain("passa da carga daquele dia (4 tempos)");
    // e a carga por dia não desce abaixo do que já foi lançado
    const abaixo = await mensagem(await carga_por_dia(id, { [INICIO]: "5", [dia(1)]: "5" }));
    expect(abaixo).toContain("já há presença lançada de 6 tempos");
  });
});

describe("presença em minutos, sem perda (T3)", () => {
  it("4,5 h em dois dias: 135 + 135; quem falta um dia fica com 50%", async () => {
    const id = await turma(await catalogo({ carga_horaria_horas: "4,5" }));
    await em_andamento(id);
    const ana = await inscrever(id, "1110654", "Ana");
    const bia = await inscrever(id, "1110655", "Bia");
    expect(await dias_gravados(id)).toEqual([]); // em HORAS, a divisão automática não ocupa linha
    const r = await cliente.post(
      `/turmas/${id}/presencas/folha`,
      { presente: [`${ana}_${INICIO}`, `${ana}_${dia(1)}`, `${bia}_${INICIO}`] },
      { seguir: false },
    );
    expect(await mensagem(r)).toContain("Folha salva");
    expect((await presencas(ana)).map((p) => p.quantidade)).toEqual([135, 135]);
    expect((await presencas(bia)).map((p) => [p.presente, p.quantidade])).toEqual([[true, 135], [false, 0]]);
    expect(await frequencia(ana)).toBe("100.00");
    expect(await frequencia(bia)).toBe("50.00");
    const grade = (await cliente.get(`/turmas/${id}?aba=presencas`)).text;
    expect(grade).toContain("4h30");
    expect(grade).toContain("2h15");
  });

  it("ajuste em horas e minutos: '2h' e '1,25' viram 120 e 75 minutos", async () => {
    const id = await turma(await catalogo({ carga_horaria_horas: "4,5" }));
    await em_andamento(id);
    const ana = await inscrever(id, "1110654", "Ana");
    await mensagem(await lancar(id, ana, { horas: "2h" }));
    await mensagem(await lancar(id, ana, { data: dia(1), horas: "1,25" }));
    expect((await presencas(ana)).map((p) => p.quantidade)).toEqual([120, 75]);
    expect(await frequencia(ana)).toBe("72.22");
  });

  it("turma migrada com a divisão antiga por dia (138 + 132): a presença de 2,3 h no 1º dia segue cabendo", async () => {
    const id = await turma(await catalogo({ carga_horaria_horas: "4,5" }));
    await em_andamento(id);
    const ana = await inscrever(id, "1110654", "Ana");
    // o que a migração 0047 grava para a turma 0008 do banco de teste
    await db.insert(e.turma_carga_dia).values([
      { turma_id: id, data: INICIO, quantidade: 138 },
      { turma_id: id, data: dia(1), quantidade: 132 },
    ]);
    await mensagem(await lancar(id, ana, { horas: "2,3" }));
    expect(await mensagem(await lancar(id, ana, { data: dia(1), horas: "2,3" }))).toContain("passa da carga daquele dia (2h12)");
    await mensagem(await lancar(id, ana, { data: dia(1), horas: "2,2" }));
    expect((await presencas(ana)).map((p) => p.quantidade)).toEqual([138, 132]);
    expect(await frequencia(ana)).toBe("100.00");
  });

  it("a folha reenviada sem digitar não reescreve o que já foi lançado (a presença convertida fica)", async () => {
    const id = await turma(await catalogo({ carga_horaria_horas: "4,5" }));
    await em_andamento(id);
    const ana = await inscrever(id, "1110654", "Ana");
    await mensagem(await lancar(id, ana, { horas: "2h15" }));
    // como a migração deixa a turma antiga: 2,3 h viram 138 minutos (a divisão antiga em décimos)
    await db.update(e.turma_presenca).set({ quantidade: 138 }).where(eq(e.turma_presenca.inscricao_id, ana));
    await db.update(e.inscricao).set({ frequencia_percentual: "51.11" }).where(eq(e.inscricao.id, ana));
    const r = await cliente.post(`/turmas/${id}/presencas/folha`, { presente: [`${ana}_${INICIO}`] }, { seguir: false });
    expect(await mensagem(r)).toContain("Nada mudou na folha.");
    expect((await presencas(ana)).map((p) => p.quantidade)).toEqual([138]);
    expect(await frequencia(ana)).toBe("51.11");
  });
});

describe("a carga cabe no horário? (T2)", () => {
  it("horas: 8 h num dia das 8h às 12h é recusado sem justificativa; com ela, grava e a ficha mostra", async () => {
    const t = await catalogo({ carga_horaria_horas: "8" });
    const sem = await abrir_turma(t, { data_inicio: FUTURO, data_fim: FUTURO, hora_inicio: "08:00", hora_fim: "12:00" });
    expect(sem.text).toContain("A carga da turma (8 horas) passa do que o horário comporta: das 8h às 12h cabem 4 horas por dia");
    expect(sem.text).toContain("escreva a justificativa da carga");
    expect(await db.select().from(e.turma)).toHaveLength(0);
    const id = await turma(t, {
      data_inicio: FUTURO,
      data_fim: FUTURO,
      hora_inicio: "08:00",
      hora_fim: "12:00",
      justificativa_carga: "A parte prática acontece à tarde, no pátio do Corpo de Bombeiros.",
    });
    const [gravada] = await db.select().from(e.turma).where(eq(e.turma.id, id));
    expect(gravada!.justificativa_carga).toBe("A parte prática acontece à tarde, no pátio do Corpo de Bombeiros.");
    expect((await cliente.get(`/turmas/${id}`)).text).toContain("A parte prática acontece à tarde");
  });

  it("tempos: a régua é de 50 minutos, e a recusa fala em tempos", async () => {
    const t = await catalogo({ carga_horaria_horas: "10", carga_unidade: "TEMPOS" });
    const sem = await abrir_turma(t, { data_inicio: FUTURO, data_fim: somar_dias(FUTURO, 1), hora_inicio: "08:00", hora_fim: "12:00" });
    expect(sem.text).toContain("cabem 4 tempos por dia (a 50 minutos por tempo), e 2 dias dão 8 tempos");
    // das 8h às 12h10 cabem 5 tempos por dia: 10 em 2 dias cabe
    const id = await turma(t, { data_inicio: FUTURO, data_fim: somar_dias(FUTURO, 1), hora_inicio: "08:00", hora_fim: "12:10" });
    expect((await db.select().from(e.turma).where(eq(e.turma.id, id)))[0]!.justificativa_carga).toBeNull();
    // e a carga de um dia acima do horário também pede justificativa
    const um_dia = await mensagem(await carga_por_dia(id, { [FUTURO]: "6", [somar_dias(FUTURO, 1)]: "4" }));
    expect(um_dia).toContain("A carga de um dia passa do que o horário comporta (5 tempos das 8h às 12h10");
    expect(await mensagem(await carga_por_dia(id, { [FUTURO]: "6", [somar_dias(FUTURO, 1)]: "4" }, { justificativa_carga: "simulado no primeiro dia" }))).toContain(
      "carga por dia salva",
    );
  });

  it("4,5 h em dois dias das 8h às 10h15 cabe; mudar o horário para menos pede justificativa", async () => {
    const t = await catalogo({ carga_horaria_horas: "4,5" });
    const id = await turma(t, { data_inicio: FUTURO, data_fim: somar_dias(FUTURO, 1), hora_inicio: "08:00", hora_fim: "10:15" });
    const r = await cliente.post(
      `/turmas/${id}`,
      { data_inicio: FUTURO, data_fim: somar_dias(FUTURO, 1), local: "Pátio", frequencia_minima_percentual: "75", hora_inicio: "08:00", hora_fim: "10:00" },
      { seguir: false },
    );
    expect(await mensagem(r)).toContain("A carga da turma (4h30) passa do que o horário comporta: das 8h às 10h cabem 2 horas por dia");
    expect((await db.select().from(e.turma).where(eq(e.turma.id, id)))[0]!.hora_fim).toBe("10:15:00");
  });

  it("turma sem horário não é conferida (dia inteiro)", async () => {
    const t = await catalogo({ carga_horaria_horas: "40" });
    await turma(t, { data_inicio: FUTURO, data_fim: FUTURO });
  });
});
