/**
 * NUVEM (24/10/2026): os locais de treinamento (`servicos/local_treinamento.ts`,
 * `/treinamentos/locais`), a turma que usa o local (com o texto livre ainda
 * valendo), os avisos de capacidade e de choque de sala, e o bloco "Turmas
 * encerrando" do Início de Treinamentos (`hub_treinamentos.turmas_encerrando`).
 */
import { and, asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as e from "../src/db/esquema/index.js";
import { hoje_iso, somar_dias } from "../src/dominio/datas.js";
import type { Banco } from "../src/db/cliente.js";
import * as hub from "../src/servicos/hub_treinamentos.js";
import * as local_treinamento from "../src/servicos/local_treinamento.js";
import * as servico_participante from "../src/servicos/participante.js";
import * as servico_presenca from "../src/servicos/presenca.js";
import * as servico_turma from "../src/servicos/turma.js";
import { RegraDaTurma } from "../src/servicos/turma.js";
import { bancoLimpo, contas, criarUsuario, entrar, usuarioAtual, type Campos, type Cliente, type Resposta } from "./ajuda";

const HOJE = hoje_iso();
const FUTURO = somar_dias(HOJE, 40);

let db: Banco;
let cliente: Cliente;
let novoCliente: () => Cliente;

await bancoLimpo();

beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  cliente = amb.cliente;
  novoCliente = amb.novoCliente;
  await contas(db);
});

function texto(html: string): string {
  return html
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

/** O texto da tela depois do POST (a recusa é 200; o sucesso, 303 com o recado). */
async function msg(c: Cliente, r: Resposta): Promise<string> {
  if (r.status === 200) return texto(r.text);
  expect(r.status, r.text.slice(0, 500)).toBe(303);
  return texto((await c.get(r.location!)).text);
}

async function campus(sigla: string): Promise<number> {
  const [c] = await db.select().from(e.campus).where(eq(e.campus.sigla, sigla));
  if (c) return c.id;
  const [novo] = await db.insert(e.campus).values({ sigla, nome: `Campus ${sigla}`, cidade: "Diamantina" }).returning();
  return novo!.id;
}

async function treinamento(): Promise<typeof e.treinamento.$inferSelect> {
  const [ja] = await db.select().from(e.treinamento).where(eq(e.treinamento.codigo, "NR-35"));
  if (ja) return ja;
  const [t] = await db
    .insert(e.treinamento)
    .values({ codigo: "NR-35", nome: "Trabalho em Altura — NR-35", carga_horaria_horas: "8", validade_meses: 24 })
    .returning();
  return t!;
}

async function local(dados: Partial<typeof e.local_treinamento.$inferInsert> = {}) {
  const [l] = await db
    .insert(e.local_treinamento)
    .values({ nome: "Auditório da Reitoria", capacidade: 20, ...dados })
    .returning();
  return l!;
}

/** Abre a turma pela tela; devolve a resposta e a última turma gravada. */
async function abrir(dados: Campos = {}) {
  const t = await treinamento();
  await entrar(cliente, "coordenador_csso");
  const r = await cliente.post(
    "/turmas",
    { treinamento_id: String(t.id), data_inicio: FUTURO, data_fim: FUTURO, ...dados },
    { seguir: false },
  );
  const ultima = (await db.select().from(e.turma).orderBy(asc(e.turma.id))).at(-1);
  return { r, turma: ultima };
}

async function ler_turma(id: number) {
  const [t] = await db.select().from(e.turma).where(eq(e.turma.id, id));
  return t!;
}

/** A turma direto pelo serviço (para as que não passam pela tela). */
async function turma_servico(d: Partial<servico_turma.DadosTurma> = {}) {
  const coord = await usuarioAtual(db, "coordenador_csso");
  return servico_turma.criar_turma(db, coord, {
    treinamento: await treinamento(),
    data_inicio: FUTURO,
    data_fim: FUTURO,
    ...d,
  });
}

// =====================================================================
// Cadastro dos locais
// =====================================================================
describe("cadastro de locais", () => {
  it("quem gere o catálogo cadastra, edita, inativa e reativa — tudo na trilha", async () => {
    const jk = await campus("JK");
    await entrar(cliente, "coordenador_csso");
    const r = await cliente.post(
      "/treinamentos/locais",
      { nome: "  Sala   204 ", campus_id: String(jk), endereco: "Reitoria, 2º andar", capacidade: "30", observacoes: "projetor" },
      { seguir: false },
    );
    expect(await msg(cliente, r)).toContain("Local “Sala 204” cadastrado");
    const [l] = await db.select().from(e.local_treinamento);
    expect(l).toMatchObject({ nome: "Sala 204", campus_id: jk, endereco: "Reitoria, 2º andar", capacidade: 30, ativo: true });
    const criado = await db
      .select()
      .from(e.historico_evento)
      .where(and(eq(e.historico_evento.entidade, "local_treinamento"), eq(e.historico_evento.entidade_id, l!.id)));
    expect(criado.map((x) => x.tipo_evento)).toEqual([local_treinamento.LOCAL_CRIADO]);

    const tela = texto((await cliente.get("/treinamentos/locais")).text);
    expect(tela).toContain("Sala 204");
    expect(tela).toContain("Reitoria, 2º andar");
    expect(tela).toContain("Cadastrar local");

    const ed = await cliente.post(
      `/treinamentos/locais/${l!.id}`,
      { nome: "Sala 205", campus_id: String(jk), endereco: "Reitoria, 2º andar", capacidade: "25", observacoes: "" },
      { seguir: false },
    );
    expect(await msg(cliente, ed)).toContain("alteração gravada");
    const diffs = await db
      .select()
      .from(e.historico_evento)
      .where(and(eq(e.historico_evento.entidade, "local_treinamento"), eq(e.historico_evento.tipo_evento, "CAMPO_ALTERADO")));
    expect(diffs.map((x) => x.campo).sort()).toEqual(["capacidade", "nome", "observacoes"]);

    expect(await msg(cliente, await cliente.post(`/treinamentos/locais/${l!.id}/inativar`, {}, { seguir: false }))).toContain(
      "inativado",
    );
    expect((await db.select().from(e.local_treinamento))[0]!.ativo).toBe(false);
    await cliente.post(`/treinamentos/locais/${l!.id}/reativar`, {}, { seguir: false });
    expect((await db.select().from(e.local_treinamento))[0]!.ativo).toBe(true);
    const tipos = (await db.select().from(e.historico_evento).where(eq(e.historico_evento.entidade, "local_treinamento"))).map(
      (x) => x.tipo_evento,
    );
    expect(tipos).toEqual(expect.arrayContaining([local_treinamento.LOCAL_INATIVADO, local_treinamento.LOCAL_REATIVADO]));
  });

  it("recusa nome em branco, capacidade inválida e nome repetido no mesmo campus, com o popup reaberto", async () => {
    const jk = await campus("JK");
    await local({ nome: "Auditório", campus_id: jk });
    await entrar(cliente, "coordenador_csso");
    const branco = await cliente.post("/treinamentos/locais", { nome: "   ", capacidade: "" }, { seguir: false });
    expect(branco.status).toBe(200);
    expect(texto(branco.text)).toContain("Preencha o nome do local");
    const zero = await cliente.post("/treinamentos/locais", { nome: "Sala X", capacidade: "0" }, { seguir: false });
    expect(texto(zero.text)).toContain("Capacidade: informe quantas pessoas cabem");
    expect(zero.text).toContain('value="Sala X"');
    const repetido = await cliente.post("/treinamentos/locais", { nome: "auditório", campus_id: String(jk) }, { seguir: false });
    expect(texto(repetido.text)).toContain("Já existe o local “Auditório” no campus JK");
    // o mesmo nome noutro campus (ou sem campus) é outro lugar
    const outro = await cliente.post("/treinamentos/locais", { nome: "Auditório" }, { seguir: false });
    expect(outro.status).toBe(303);
    expect(await db.select().from(e.local_treinamento)).toHaveLength(2);
  });

  it("sem treinamento.gerenciar: lê a lista e recebe 403 ao gravar; o titular e quem não entrou não abrem", async () => {
    const l = await local();
    const c = await entrar(novoCliente(), "secretaria_csso");
    const tela = await c.get("/treinamentos/locais");
    expect(tela.status).toBe(200);
    expect(tela.text).not.toContain("Cadastrar local");
    for (const caminho of ["/treinamentos/locais", `/treinamentos/locais/${l.id}`, `/treinamentos/locais/${l.id}/inativar`]) {
      expect((await c.post(caminho, { nome: "Invasão" }, { seguir: false })).status, caminho).toBe(403);
    }
    expect((await db.select().from(e.local_treinamento))[0]).toMatchObject({ nome: "Auditório da Reitoria", ativo: true });
    const titular = await entrar(novoCliente(), "servidor_consulta");
    expect((await titular.get("/treinamentos/locais", { seguir: false })).status).toBe(403);
    const anonimo = await novoCliente().get("/treinamentos/locais", { seguir: false });
    expect([302, 303, 401]).toContain(anonimo.status);
  });

  it("Locais entra no menu do módulo, em Cadastros", async () => {
    const corpo = (await (await entrar(novoCliente(), "coordenador_csso")).get("/turmas")).text;
    expect(corpo).toContain('href="/treinamentos/locais"');
  });
});

// =====================================================================
// A turma e o local
// =====================================================================
describe("a turma usa o local cadastrado ou o texto livre", () => {
  it("com local cadastrado, a turma grava o vínculo e o nome; a ficha mostra o endereço", async () => {
    const l = await local({ endereco: "Prédio da Reitoria, sala 204" });
    const { r, turma } = await abrir({ local_id: String(l.id), local: "texto ignorado" });
    expect(r.status, r.text.slice(0, 400)).toBe(303);
    expect(turma).toMatchObject({ local_id: l.id, local: "Auditório da Reitoria" });
    const ficha = texto((await cliente.get(`/turmas/${turma!.id}`)).text);
    expect(ficha).toContain("Auditório da Reitoria");
    expect(ficha).toContain("Prédio da Reitoria, sala 204");
    // o formulário de edição oferece o seletor, com o local escolhido
    expect(ficha).toMatch(new RegExp(`<option value="${l.id}"[^>]*selected`));
  });

  it("sem local escolhido, vale o texto livre, como antes; e a tela sem locais cadastrados mostra só o texto", async () => {
    const lista = (await (await entrar(cliente, "coordenador_csso")).get("/turmas")).text;
    expect(lista).not.toContain('name="local_id"');
    const { turma } = await abrir({ local: "Quadra do Campus JK" });
    expect(turma).toMatchObject({ local_id: null, local: "Quadra do Campus JK" });
    await local();
    expect((await cliente.get("/turmas")).text).toContain('name="local_id"');
    const { turma: outra } = await abrir({ local_id: "", local: "Ginásio" });
    expect(outra).toMatchObject({ local_id: null, local: "Ginásio" });
  });

  it("trocar para “outro local” solta o cadastrado; o formulário antigo com texto novo também", async () => {
    const l = await local();
    const { turma } = await abrir({ local_id: String(l.id) });
    const base = { data_inicio: FUTURO, data_fim: FUTURO, frequencia_minima_percentual: "75" };
    await cliente.post(`/turmas/${turma!.id}`, { ...base, local_id: "", local: "Sala improvisada" }, { seguir: false });
    expect(await ler_turma(turma!.id)).toMatchObject({ local_id: null, local: "Sala improvisada" });
    await cliente.post(`/turmas/${turma!.id}`, { ...base, local_id: String(l.id), local: "" }, { seguir: false });
    expect(await ler_turma(turma!.id)).toMatchObject({ local_id: l.id, local: "Auditório da Reitoria" });
    // sem o seletor (formulário antigo): o mesmo texto mantém o vínculo, outro texto o solta
    await cliente.post(`/turmas/${turma!.id}`, { ...base, local: "Auditório da Reitoria" }, { seguir: false });
    expect((await ler_turma(turma!.id)).local_id).toBe(l.id);
    await cliente.post(`/turmas/${turma!.id}`, { ...base, local: "Outro prédio" }, { seguir: false });
    expect(await ler_turma(turma!.id)).toMatchObject({ local_id: null, local: "Outro prédio" });
  });

  it("recusa o local de outro campus e o inativo; a turma que já tinha o inativo fica com ele", async () => {
    const jk = await campus("JK");
    const mucuri = await campus("MUC");
    const do_jk = await local({ nome: "Sala do JK", campus_id: jk });
    const { r } = await abrir({ local_id: String(do_jk.id), campus_id: String(mucuri) });
    expect(r.status).toBe(200);
    expect(texto(r.text)).toContain("é do campus JK, e a turma é do campus MUC");
    const { turma } = await abrir({ local_id: String(do_jk.id), campus_id: String(jk) });
    expect(turma!.local_id).toBe(do_jk.id);
    const coord = await usuarioAtual(db, "coordenador_csso");
    await local_treinamento.mudar_ativo(db, coord, do_jk.id, false);
    await expect(turma_servico({ local_id: do_jk.id })).rejects.toThrow(RegraDaTurma);
    // a turma que já o tinha se edita sem trocar, e o seletor dela ainda o mostra
    const ed = await cliente.post(
      `/turmas/${turma!.id}`,
      { data_inicio: FUTURO, data_fim: FUTURO, campus_id: String(jk), local_id: String(do_jk.id), frequencia_minima_percentual: "75", observacoes: "ok" },
      { seguir: false },
    );
    expect(await msg(cliente, ed)).toContain("Turma atualizada");
    expect((await cliente.get(`/turmas/${turma!.id}`)).text).toContain("(inativo)");
    // a lista da turma nova não o oferece
    // (a linha da turma, na lista, continua dizendo "Sala do JK")
    await local({ nome: "Sala ativa" });
    const lista = (await cliente.get("/turmas")).text;
    expect(lista).toContain('name="local_id"');
    expect(lista).toContain("Sala do JK");
    expect(lista).not.toContain(`<option value="${do_jk.id}" data-campus`);
  });

  it("renomear o local leva o nome às turmas não encerradas; a cancelada fica com o do dia", async () => {
    const l = await local();
    const viva = await turma_servico({ local_id: l.id });
    const cancelada = await turma_servico({ local_id: l.id });
    const coord = await usuarioAtual(db, "coordenador_csso");
    await servico_turma.mudar_situacao(db, coord, cancelada, "CANCELADA", { motivo: "sem quórum" });
    const r = await local_treinamento.editar(db, coord, l.id, {
      nome: "Auditório Prof. Fulano",
      campus_id: null,
      endereco: null,
      capacidade: 20,
      observacoes: null,
    });
    expect(r.turmas_renomeadas).toBe(1);
    expect((await ler_turma(viva.id)).local).toBe("Auditório Prof. Fulano");
    expect((await ler_turma(cancelada.id)).local).toBe("Auditório da Reitoria");
    const trilha = await db
      .select()
      .from(e.historico_evento)
      .where(and(eq(e.historico_evento.entidade, "turma"), eq(e.historico_evento.entidade_id, viva.id), eq(e.historico_evento.campo, "local")));
    expect(trilha).toHaveLength(1);
  });
});

// =====================================================================
// Os avisos
// =====================================================================
describe("avisos do local (não bloqueiam)", () => {
  it("vagas acima da capacidade: a turma salva, com o aviso no recado e na ficha", async () => {
    const l = await local({ capacidade: 20 });
    const { r, turma } = await abrir({ local_id: String(l.id), vagas: "30" });
    const tela = await msg(cliente, r);
    expect(turma!.vagas).toBe(30);
    expect(tela).toContain("Turma " + turma!.codigo + " aberta. Atenção: Vagas acima da capacidade");
    expect(tela).toContain("comporta 20 pessoa(s)");
    expect(tela).toContain("Aviso do local");
    // dentro da capacidade, nada
    const ok = await abrir({ local_id: String(l.id), vagas: "20", data_inicio: somar_dias(FUTURO, 5), data_fim: somar_dias(FUTURO, 5) });
    expect(await msg(cliente, ok.r)).not.toContain("Atenção:");
  });

  it("choque de sala sem horário (dia inteiro), com o código da outra turma", async () => {
    const l = await local({ capacidade: null });
    const primeira = await turma_servico({ local_id: l.id, data_inicio: FUTURO, data_fim: somar_dias(FUTURO, 2) });
    const { r } = await abrir({ local_id: String(l.id), data_inicio: somar_dias(FUTURO, 2), data_fim: somar_dias(FUTURO, 3) });
    const tela = await msg(cliente, r);
    expect(tela).toContain(`Choque de sala: a turma ${primeira.codigo} também usa “Auditório da Reitoria”`);
    expect(tela).toContain("dia inteiro");
    // datas que não se cruzam: sem aviso
    const longe = await abrir({ local_id: String(l.id), data_inicio: somar_dias(FUTURO, 10), data_fim: somar_dias(FUTURO, 10) });
    expect(await msg(cliente, longe.r)).not.toContain("Choque de sala");
  });

  it("choque de sala com horário: manhã e tarde convivem, horários que se cruzam avisam, sem hora avisa", async () => {
    const l = await local({ capacidade: null });
    const manha = await turma_servico({ local_id: l.id, hora_inicio: "08:00", hora_fim: "12:00" });
    const tarde = await turma_servico({ local_id: l.id, hora_inicio: "12:00", hora_fim: "17:00" });
    expect(await local_treinamento.avisos_da_turma(db, tarde)).toEqual([]);
    const meio = await turma_servico({ local_id: l.id, hora_inicio: "10:00", hora_fim: "14:00" });
    const avisos = await local_treinamento.avisos_da_turma(db, meio);
    expect(avisos).toHaveLength(2);
    expect(avisos.join(" ")).toContain(manha.codigo);
    expect(avisos.join(" ")).toContain(tarde.codigo);
    expect(avisos.join(" ")).toContain("8h às 12h");
    const dia_todo = await turma_servico({ local_id: l.id });
    expect(await local_treinamento.avisos_da_turma(db, dia_todo)).toHaveLength(3);
    // e só a partir das 16h (sem fim) choca com a da tarde
    const fim_de_tarde = await turma_servico({ local_id: l.id, hora_inicio: "16:00" });
    const deste = (await local_treinamento.avisos_da_turma(db, fim_de_tarde)).join(" ");
    expect(deste).toContain(tarde.codigo);
    expect(deste).not.toContain(manha.codigo);
  });

  it("a turma cancelada não conta, e a cancelada não recebe aviso", async () => {
    const l = await local({ capacidade: null });
    const coord = await usuarioAtual(db, "coordenador_csso");
    const cancelada = await turma_servico({ local_id: l.id });
    await servico_turma.mudar_situacao(db, coord, cancelada, "CANCELADA", { motivo: "remarcada" });
    const nova = await turma_servico({ local_id: l.id });
    expect(await local_treinamento.avisos_da_turma(db, nova)).toEqual([]);
    expect(await local_treinamento.avisos_da_turma(db, cancelada)).toEqual([]);
    // na ficha da nova, nenhum aviso
    await entrar(cliente, "coordenador_csso");
    expect(texto((await cliente.get(`/turmas/${nova.id}`)).text)).not.toContain("Choque de sala");
  });

  it("a edição que cria o choque avisa ao salvar e a ficha mantém o aviso", async () => {
    const l = await local({ capacidade: null });
    const outra = await turma_servico({ local_id: l.id });
    const { turma } = await abrir({ local: "Sala livre", data_inicio: somar_dias(FUTURO, 1), data_fim: somar_dias(FUTURO, 1) });
    const r = await cliente.post(
      `/turmas/${turma!.id}`,
      { data_inicio: FUTURO, data_fim: FUTURO, local_id: String(l.id), frequencia_minima_percentual: "75" },
      { seguir: false },
    );
    const tela = await msg(cliente, r);
    expect(tela).toContain(`Turma atualizada. Atenção: Choque de sala: a turma ${outra.codigo}`);
    expect(tela).toContain("Aviso do local");
  });
});

// =====================================================================
// O painel: Turmas encerrando
// =====================================================================
describe("Turmas encerrando, no Início de Treinamentos", () => {
  async function servidor(siape: string, nome: string) {
    const [s] = await db.insert(e.servidor).values({ siape, nome }).returning();
    return s!;
  }

  it("lista a que termina em 30 dias e a atrasada, com presença, nota e certificado que faltam", async () => {
    const coord = await usuarioAtual(db, "coordenador_csso");
    const ontem = somar_dias(HOJE, -1);
    // atrasada: terminou ontem, em andamento, dois inscritos e um dia lançado para um só
    const atrasada = await turma_servico({
      data_inicio: somar_dias(HOJE, -2),
      data_fim: ontem,
      nota_minima_aprovacao: "7",
      local: "Sala 1",
    });
    await servico_turma.mudar_situacao(db, coord, atrasada, "EM_ANDAMENTO");
    const ana = await servico_participante.de_servidor(db, await servidor("3000001", "Ana Teste"), coord);
    const bia = await servico_participante.de_servidor(db, await servidor("3000002", "Bia Teste"), coord);
    const i_ana = await servico_turma.inscrever(db, coord, atrasada, ana);
    await servico_turma.inscrever(db, coord, atrasada, bia);
    for (const dia of [somar_dias(HOJE, -2), ontem]) {
      await servico_presenca.lancar_presenca(db, coord, i_ana, { data: dia, presente: true, horas: "4" });
    }
    await servico_presenca.lancar_nota(db, coord, (await servico_turma.carregar_inscricao(db, i_ana.id))!, "8");
    // encerrando: termina em 10 dias, sem nota mínima, um inscrito
    const proxima = await turma_servico({ data_inicio: somar_dias(HOJE, 10), data_fim: somar_dias(HOJE, 10) });
    await servico_turma.inscrever(db, coord, proxima, ana);
    // fora: termina em 40 dias; e a cancelada
    await turma_servico({ data_inicio: somar_dias(HOJE, 40), data_fim: somar_dias(HOJE, 40) });
    const cancelada = await turma_servico({ data_inicio: somar_dias(HOJE, 5), data_fim: somar_dias(HOJE, 5) });
    await servico_turma.mudar_situacao(db, coord, cancelada, "CANCELADA", { motivo: "x" });

    const r = await hub.turmas_encerrando(db, coord, HOJE);
    expect(r.total).toBe(2);
    expect(r.itens.map((t) => t.codigo)).toEqual([atrasada.codigo, proxima.codigo]);
    expect(r.itens[0]).toMatchObject({
      atrasada: true,
      inscritos: 2,
      sem_presenca: 1,
      sem_nota: 1,
      sem_certificado: 2,
      local: "Sala 1",
    });
    expect(r.itens[1]).toMatchObject({ atrasada: false, inscritos: 1, sem_presenca: 1, sem_nota: null, sem_certificado: 1 });

    await entrar(cliente, "coordenador_csso");
    const tela = texto((await cliente.get("/treinamentos")).text);
    expect(tela).toContain("Turmas encerrando");
    expect(tela).toContain(`href="/turmas/${atrasada.id}"`);
    expect(tela).toContain("atrasada");
    expect(tela).toContain("presença não lançada de 1 inscrito(s); nota faltando de 1; 2 certificado(s) não emitido(s); concluir a turma");
    expect(tela).not.toContain(cancelada.codigo);
  });

  it("a concluída sai da lista; sem nenhuma, a tela diz", async () => {
    const coord = await usuarioAtual(db, "coordenador_csso");
    const t = await turma_servico({ data_inicio: HOJE, data_fim: HOJE });
    await servico_turma.mudar_situacao(db, coord, t, "EM_ANDAMENTO");
    await servico_turma.mudar_situacao(db, coord, t, "CONCLUIDA");
    expect((await hub.turmas_encerrando(db, coord, HOJE)).total).toBe(0);
    await entrar(cliente, "coordenador_csso");
    expect(texto((await cliente.get("/treinamentos")).text)).toContain("Nenhuma turma encerrando.");
  });

  it("respeita o escopo do painel: o setor promotor de quem lê", async () => {
    const [cpel] = await db.select().from(e.unidade_uorg).where(eq(e.unidade_uorg.sigla, "CPEL"));
    await criarUsuario(db, { login: "tec_cpel_local", perfis: ["tecnico_seguranca"], setores: ["CPEL"] });
    await criarUsuario(db, { login: "tec_csso_local", perfis: ["tecnico_seguranca"] });
    const da_cpel = await turma_servico({ data_inicio: somar_dias(HOJE, 3), data_fim: somar_dias(HOJE, 3), unidade_promotora_id: cpel!.id });
    const sem_setor = await turma_servico({ data_inicio: somar_dias(HOJE, 4), data_fim: somar_dias(HOJE, 4) });
    const cpel_ve = await hub.turmas_encerrando(db, await usuarioAtual(db, "tec_cpel_local"), HOJE);
    expect(cpel_ve.itens.map((t) => t.codigo)).toEqual([da_cpel.codigo]);
    const csso_ve = await hub.turmas_encerrando(db, await usuarioAtual(db, "tec_csso_local"), HOJE);
    expect(csso_ve.itens.map((t) => t.codigo)).toEqual([sem_setor.codigo]);
    const tela = (await (await entrar(novoCliente(), "tec_csso_local")).get("/treinamentos")).text;
    expect(tela).toContain(sem_setor.codigo);
    expect(tela).not.toContain(da_cpel.codigo);
  });
});
