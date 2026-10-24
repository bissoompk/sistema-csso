/**
 * Qualificação do instrutor (24/10/2026): cadastro com comprovante, quem
 * cadastra e quem baixa, a situação, o aviso ao escalar na turma e a pendência
 * de vencimento (`servicos/qualificacao_instrutor.ts`).
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as e from "../src/db/esquema/index.js";
import { somar_dias } from "../src/dominio/datas.js";
import type { Banco } from "../src/db/cliente.js";
import * as datas_br from "../src/servicos/datas_br.js";
import * as pendencias from "../src/servicos/pendencias.js";
import * as q from "../src/servicos/qualificacao_instrutor.js";
import * as rotinas from "../src/servicos/rotinas.js";
import * as servico_turma from "../src/servicos/turma.js";
import { bancoLimpo, contas, entrar, naTransacao, usuarioAtual, type Cliente } from "./ajuda";

const HOJE = datas_br.hoje();
const INICIO = somar_dias(HOJE, 30);
const FIM = somar_dias(INICIO, 2);
const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");

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

function _arquivo(bytes: Uint8Array, nome = "comprovante.pdf", tipo = "application/pdf") {
  return new File([bytes as Uint8Array<ArrayBuffer>], nome, { type: tipo });
}

async function _treinamento(codigo: string, norma: string | null): Promise<number> {
  const [t] = await db
    .insert(e.treinamento)
    .values({ codigo, nome: `Treinamento ${codigo}`, carga_horaria_horas: "8", norma_referencia: norma })
    .returning();
  return t!.id;
}

async function _instrutor(nome = "Joana Ribeiro"): Promise<number> {
  const [a] = await db
    .insert(e.assinatura_instrutor)
    .values({ nome, externo: true, vigencia_inicio: "2000-01-01" })
    .returning();
  return a!.id;
}

async function _coord_id(): Promise<number> {
  const [u] = await db.select().from(e.usuario).where(eq(e.usuario.login, "coordenador_csso"));
  return u!.id;
}

/** Qualificação direto no banco (sem comprovante): para as regras de data. */
async function _qualificacao(
  instrutor_id: number,
  d: { treinamento_id?: number | null; norma?: string | null; data_emissao?: string; valida_ate?: string | null; ativo?: boolean },
): Promise<number> {
  const [linha] = await db
    .insert(e.instrutor_qualificacao)
    .values({
      instrutor_id,
      descricao: "Formação de instrutor",
      treinamento_id: d.treinamento_id ?? null,
      norma: d.norma ?? null,
      instituicao: "SENAI",
      data_emissao: d.data_emissao ?? "2025-01-10",
      valida_ate: d.valida_ate ?? null,
      ativo: d.ativo ?? true,
      inativado_em: d.ativo === false ? new Date() : null,
      criado_por: await _coord_id(),
    })
    .returning();
  return linha!.id;
}

async function _turma(treinamento_id: number, inicio = INICIO, fim = FIM): Promise<number> {
  const r = await cliente.post(
    "/turmas",
    { treinamento_id: String(treinamento_id), data_inicio: inicio, data_fim: fim, local: "Auditório", frequencia_minima_percentual: "75" },
    { seguir: false },
  );
  expect(r.status, r.text.slice(0, 400)).toBe(303);
  const [t] = await db.select().from(e.turma).where(eq(e.turma.treinamento_id, treinamento_id));
  return t!.id;
}

async function _avisos(turma_id: number, instrutores: number[]) {
  const turma = (await servico_turma.carregar_turma(db, turma_id))!;
  const lista = await db.select().from(e.assinatura_instrutor);
  return q.avisos_da_turma(
    db,
    turma,
    lista.filter((a) => instrutores.includes(a.id)),
  );
}

function _cadastro(instrutor_id: number, campos: Record<string, string | File> = {}) {
  return cliente.post(
    `/treinamentos/assinaturas/${instrutor_id}/qualificacoes`,
    {
      descricao: "Formação de instrutor NR-35",
      norma: "NR-35",
      instituicao: "SENAI",
      data_emissao: "2025-03-01",
      valida_ate: "2027-03-01",
      comprovante: _arquivo(PDF),
      ...campos,
    },
    { seguir: false, multipart: true },
  );
}

async function _pendencias_abertas() {
  return db
    .select()
    .from(e.pendencia)
    .where(and(eq(e.pendencia.tipo, q.TIPO_PENDENCIA), eq(e.pendencia.concluida, false)));
}

// =====================================================================
// Cadastro e comprovante
// =====================================================================
describe("cadastro com comprovante", () => {
  it("grava a qualificação, o comprovante restrito e a trilha; a ficha lista", async () => {
    await entrar(cliente, "coordenador_csso");
    const instrutor_id = await _instrutor();
    const r = await _cadastro(instrutor_id);
    expect(r.status, r.text.slice(0, 500)).toBe(303);
    const [linha] = await db.select().from(e.instrutor_qualificacao);
    expect(linha).toMatchObject({ instrutor_id, norma: "NR-35", instituicao: "SENAI", valida_ate: "2027-03-01", ativo: true });
    expect(linha!.comprovante_anexo_id).not.toBeNull();
    const [anexo] = await db.select().from(e.anexo).where(eq(e.anexo.id, linha!.comprovante_anexo_id!));
    expect(anexo).toMatchObject({
      entidade: "instrutor_qualificacao",
      entidade_id: linha!.id,
      categoria: "QUALIFICACAO_INSTRUTOR",
      nivel_acesso: "RESTRITO",
      mime_type: "application/pdf",
    });
    const eventos = await db
      .select()
      .from(e.historico_evento)
      .where(eq(e.historico_evento.tipo_evento, "INSTRUTOR_QUALIFICACAO_CADASTRADA"));
    expect(eventos).toHaveLength(1);
    const ficha = await cliente.get(`/treinamentos/assinaturas/${instrutor_id}/qualificacoes`);
    expect(ficha.status).toBe(200);
    expect(ficha.text).toContain("Formação de instrutor NR-35");
    expect(ficha.text).toContain(`/anexos/${anexo!.id}`);
    // a lista de instrutores leva à ficha
    expect((await cliente.get("/treinamentos/assinaturas")).text).toContain(`/treinamentos/assinaturas/${instrutor_id}/qualificacoes`);
  });

  it("o tipo vem dos bytes: texto com nome de .pdf é recusado, e nada é gravado", async () => {
    await entrar(cliente, "coordenador_csso");
    const instrutor_id = await _instrutor();
    const falso = _arquivo(new TextEncoder().encode("não sou PDF"), "diploma.pdf");
    const r = await _cadastro(instrutor_id, { comprovante: falso });
    expect(r.text).toContain("O comprovante precisa ser um PDF ou uma imagem PNG/JPEG.");
    // o que foi digitado volta no popup
    expect(r.text).toContain('value="Formação de instrutor NR-35"');
    expect(await db.select().from(e.instrutor_qualificacao)).toHaveLength(0);
    expect(await db.select().from(e.anexo).where(eq(e.anexo.categoria, "QUALIFICACAO_INSTRUTOR"))).toHaveLength(0);
  });

  it("recusa sem comprovante, sem treinamento nem norma e com validade antes da emissão", async () => {
    await entrar(cliente, "coordenador_csso");
    const instrutor_id = await _instrutor();
    const sem_arquivo = await cliente.post(
      `/treinamentos/assinaturas/${instrutor_id}/qualificacoes`,
      { descricao: "Formação", norma: "NR-35", instituicao: "SENAI", data_emissao: "2025-03-01" },
      { seguir: false, multipart: true },
    );
    expect(sem_arquivo.text).toContain("Envie o comprovante");
    expect((await _cadastro(instrutor_id, { norma: "" })).text).toContain("Informe o treinamento que ela habilita, a norma, ou os dois.");
    expect((await _cadastro(instrutor_id, { valida_ate: "2024-01-01" })).text).toContain(
      "A validade não pode ser anterior à data de emissão.",
    );
    expect(await db.select().from(e.instrutor_qualificacao)).toHaveLength(0);
  });

  it("sem validade é aceito", async () => {
    await entrar(cliente, "coordenador_csso");
    const instrutor_id = await _instrutor();
    expect((await _cadastro(instrutor_id, { valida_ate: "" })).status).toBe(303);
    const [linha] = await db.select().from(e.instrutor_qualificacao);
    expect(linha!.valida_ate).toBeNull();
    expect((await cliente.get(`/treinamentos/assinaturas/${instrutor_id}/qualificacoes`)).text).toContain("sem validade");
  });
});

describe("permissão", () => {
  it("quem não gerencia instrutores não cadastra, não inativa nem abre a ficha", async () => {
    const instrutor_id = await _instrutor();
    const qid = await _qualificacao(instrutor_id, { norma: "NR-35" });
    await entrar(cliente, "secretaria_csso");
    expect((await _cadastro(instrutor_id)).status).toBe(403);
    expect((await cliente.post(`/treinamentos/assinaturas/${instrutor_id}/qualificacoes/${qid}/inativar`, {})).status).toBe(403);
    expect((await cliente.get(`/treinamentos/assinaturas/${instrutor_id}/qualificacoes`)).status).toBe(403);
    expect(await db.select().from(e.instrutor_qualificacao)).toHaveLength(1);
  });

  it("sem sessão, a ficha não abre", async () => {
    const instrutor_id = await _instrutor();
    const r = await novoCliente().get(`/treinamentos/assinaturas/${instrutor_id}/qualificacoes`, { seguir: false });
    expect([302, 303, 401]).toContain(r.status);
  });

  it("o comprovante só baixa para quem gerencia instrutores, e o download fica na trilha", async () => {
    await entrar(cliente, "coordenador_csso");
    const instrutor_id = await _instrutor();
    await _cadastro(instrutor_id);
    const [linha] = await db.select().from(e.instrutor_qualificacao);
    const caminho = `/anexos/${linha!.comprovante_anexo_id}`;
    const baixado = await cliente.get(caminho);
    expect(baixado.status).toBe(200);
    expect(baixado.headers.get("content-type")).toBe("application/pdf");
    const trilha = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "ANEXO_BAIXADO"));
    expect(trilha).toHaveLength(1);
    // quem vê turmas e certificados, mas não gerencia instrutores, não baixa
    for (const perfil of ["secretaria_csso", "auditor_interno", "servidor_consulta"]) {
      const outro = await entrar(novoCliente(), perfil);
      expect((await outro.get(caminho)).status, perfil).toBe(404);
    }
  });
});

// =====================================================================
// Situação
// =====================================================================
describe("situação", () => {
  const sit = (valida_ate: string | null, ativo = true) => q.situacao({ ativo, valida_ate }, HOJE);

  it("válida, a vencer em N dias, vencida, sem validade e inativa", () => {
    expect(sit(somar_dias(HOJE, 120))).toMatchObject({ codigo: "VALIDA", rotulo: "válida" });
    expect(sit(somar_dias(HOJE, 12))).toMatchObject({ codigo: "A_VENCER", rotulo: "vence em 12 dias", dias: 12 });
    expect(sit(somar_dias(HOJE, 30))).toMatchObject({ codigo: "A_VENCER", dias: 30 });
    expect(sit(somar_dias(HOJE, 31)).codigo).toBe("VALIDA");
    expect(sit(HOJE)).toMatchObject({ codigo: "A_VENCER", rotulo: "vence hoje" });
    expect(sit(somar_dias(HOJE, -1))).toMatchObject({ codigo: "VENCIDA", rotulo: "vencida" });
    expect(sit(null)).toMatchObject({ codigo: "SEM_VALIDADE", rotulo: "sem validade" });
    expect(sit(somar_dias(HOJE, 120), false).codigo).toBe("INATIVA");
  });

  it("a ficha mostra a situação de cada uma", async () => {
    await entrar(cliente, "coordenador_csso");
    const instrutor_id = await _instrutor();
    await _qualificacao(instrutor_id, { norma: "NR-10", valida_ate: somar_dias(HOJE, 10) });
    await _qualificacao(instrutor_id, { norma: "NR-33", valida_ate: "2025-06-01" });
    const texto = (await cliente.get(`/treinamentos/assinaturas/${instrutor_id}/qualificacoes`)).text;
    expect(texto).toContain("vence em 10 dias");
    expect(texto).toContain("vencida");
  });

  it("a norma se compara sem caixa, espaço nem pontuação, e a referência pode listar várias", () => {
    expect(q.normalizar_norma("nr 35")).toBe("NR35");
    expect(q.habilita({ treinamento_id: null, norma: "nr 35" }, { id: 1, norma_referencia: "NR-35" })).toBe(true);
    expect(q.habilita({ treinamento_id: null, norma: "NR-35" }, { id: 1, norma_referencia: "NR-10 / NR-35" })).toBe(true);
    expect(q.habilita({ treinamento_id: null, norma: "NR-3" }, { id: 1, norma_referencia: "NR-35" })).toBe(false);
    expect(q.habilita({ treinamento_id: 1, norma: null }, { id: 1, norma_referencia: null })).toBe(true);
    expect(q.habilita({ treinamento_id: 2, norma: null }, { id: 1, norma_referencia: null })).toBe(false);
  });
});

// =====================================================================
// Aviso ao escalar
// =====================================================================
describe("aviso ao escalar", () => {
  it("sem qualificação: vincula (não bloqueia), avisa na mensagem e na ficha da turma", async () => {
    await entrar(cliente, "coordenador_csso");
    const treinamento_id = await _treinamento("NR-35", "NR-35");
    const turma_id = await _turma(treinamento_id);
    const instrutor_id = await _instrutor();
    // a lista de escolha já marca quem não tem
    expect((await cliente.get(`/turmas/${turma_id}`)).text).toContain("sem qualificação para este treinamento");
    const r = await cliente.post(`/turmas/${turma_id}/instrutores`, { assinatura_instrutor_id: String(instrutor_id) });
    expect(r.text).toContain("Joana Ribeiro vinculado à turma. Atenção:");
    expect(r.text).toContain("não tem qualificação cadastrada que o habilite");
    const turma = (await servico_turma.carregar_turma(db, turma_id))!;
    expect(turma.instrutores.map((v) => v.assinatura_instrutor_id)).toEqual([instrutor_id]);
    const ficha = (await cliente.get(`/turmas/${turma_id}`)).text;
    expect(ficha).toContain("aviso-qualificacao");
  });

  it("com qualificação pela norma, válida nas datas da turma: sem aviso", async () => {
    await entrar(cliente, "coordenador_csso");
    const treinamento_id = await _treinamento("NR-35", "NR-35");
    const turma_id = await _turma(treinamento_id);
    const instrutor_id = await _instrutor();
    await _qualificacao(instrutor_id, { norma: "nr 35", valida_ate: somar_dias(FIM, 1) });
    const r = await cliente.post(`/turmas/${turma_id}/instrutores`, { assinatura_instrutor_id: String(instrutor_id) });
    expect(r.text).toContain("Joana Ribeiro vinculado à turma.");
    expect(r.text).not.toContain("Atenção:");
    expect((await cliente.get(`/turmas/${turma_id}`)).text).not.toContain("aviso-qualificacao");
  });

  it("pelo treinamento: a qualificação vinculada habilita, e quem não tem é avisado", async () => {
    await entrar(cliente, "coordenador_csso");
    // treinamento sem norma, mas com qualificação vinculada: passa a ser conferido
    const treinamento_id = await _treinamento("ESPACO", null);
    const turma_id = await _turma(treinamento_id);
    const com = await _instrutor("Com Qualificação");
    const sem = await _instrutor("Sem Qualificação");
    await _qualificacao(com, { treinamento_id });
    const avisos = await _avisos(turma_id, [com, sem]);
    expect(Object.keys(avisos).map(Number)).toEqual([sem]);
    expect(avisos[sem]).toContain("Sem Qualificação não tem qualificação cadastrada");
  });

  it("a validade conta nas datas da turma: vence no meio, ou emitida depois do início, avisa", async () => {
    await entrar(cliente, "coordenador_csso");
    const treinamento_id = await _treinamento("NR-35", "NR-35");
    const turma_id = await _turma(treinamento_id);
    const vence_no_meio = await _instrutor("Vence no Meio");
    const emitida_depois = await _instrutor("Emitida Depois");
    const inativa = await _instrutor("Só Inativa");
    const cobre = await _instrutor("Cobre a Turma");
    await _qualificacao(vence_no_meio, { norma: "NR-35", valida_ate: somar_dias(INICIO, 1) });
    await _qualificacao(emitida_depois, { norma: "NR-35", data_emissao: somar_dias(INICIO, 1) });
    await _qualificacao(inativa, { norma: "NR-35", ativo: false });
    await _qualificacao(cobre, { norma: "NR-35", valida_ate: FIM });
    const avisos = await _avisos(turma_id, [vence_no_meio, emitida_depois, inativa, cobre]);
    expect(Object.keys(avisos).map(Number).sort()).toEqual([vence_no_meio, emitida_depois, inativa].sort());
    expect(avisos[vence_no_meio]).toContain("mas nenhuma ativa válida");
    expect(avisos[inativa]).toContain("não tem qualificação cadastrada");
  });

  it("treinamento sem norma e sem qualificação vinculada não avisa", async () => {
    await entrar(cliente, "coordenador_csso");
    const treinamento_id = await _treinamento("PALESTRA", null);
    const turma_id = await _turma(treinamento_id);
    const instrutor_id = await _instrutor();
    // a qualificação de outra norma não muda nada
    await _qualificacao(instrutor_id, { norma: "NR-10" });
    expect(await _avisos(turma_id, [instrutor_id])).toEqual({});
    const r = await cliente.post(`/turmas/${turma_id}/instrutores`, { assinatura_instrutor_id: String(instrutor_id) });
    expect(r.text).not.toContain("Atenção:");
  });
});

// =====================================================================
// Pendência de vencimento
// =====================================================================
describe("pendência de vencimento", () => {
  it("a rotina abre 30 dias antes, sem responsável, com prazo na validade; é idempotente", async () => {
    const instrutor_id = await _instrutor();
    const a_vencer = await _qualificacao(instrutor_id, { norma: "NR-35", valida_ate: somar_dias(HOJE, 20) });
    await _qualificacao(instrutor_id, { norma: "NR-10", valida_ate: somar_dias(HOJE, 60) }); // fora da janela
    await _qualificacao(instrutor_id, { norma: "NR-33", valida_ate: somar_dias(HOJE, -5) }); // já vencida
    await _qualificacao(instrutor_id, { norma: "NR-12" }); // sem validade
    const r = await naTransacao((tx) => rotinas.varrer_pendencias(tx));
    expect(r.qualificacoes.abertas).toBe(1);
    const abertas = await _pendencias_abertas();
    expect(abertas).toHaveLength(1);
    expect(abertas[0]).toMatchObject({
      entidade: "instrutor_qualificacao",
      entidade_id: a_vencer,
      prazo: somar_dias(HOJE, 20),
      responsavel_id: null,
      chave: q.chave_da_pendencia({ id: a_vencer }),
    });
    // a descrição não leva o nome do instrutor
    expect(abertas[0]!.descricao).not.toContain("Joana");
    // de novo: nada novo
    const outra = await naTransacao((tx) => rotinas.varrer_pendencias(tx));
    expect(outra.qualificacoes.abertas).toBe(0);
    expect(await db.select().from(e.pendencia).where(eq(e.pendencia.tipo, q.TIPO_PENDENCIA))).toHaveLength(1);
  });

  it("o link da pendência leva à linha da qualificação na ficha do instrutor", async () => {
    const instrutor_id = await _instrutor();
    const qid = await _qualificacao(instrutor_id, { norma: "NR-35", valida_ate: somar_dias(HOJE, 5) });
    await naTransacao((tx) => rotinas.varrer_pendencias(tx));
    const [p] = await _pendencias_abertas();
    const coord = await usuarioAtual(db, "coordenador_csso");
    const leitura = (await pendencias.leitura(db, coord, [p!])).get(p!.id)!;
    expect(leitura.onde.at(-1)!.href).toBe(`/treinamentos/qualificacoes/${qid}`);
    expect(pendencias.pode_concluir(coord, p!)).toBe(true);
    await entrar(cliente, "coordenador_csso");
    const r = await cliente.get(`/treinamentos/qualificacoes/${qid}`, { seguir: false });
    expect(r.location).toBe(`/treinamentos/assinaturas/${instrutor_id}/qualificacoes#qualificacao-${qid}`);
  });

  it("a renovação (nova qualificação para o mesmo fim, válida além) conclui a pendência", async () => {
    await entrar(cliente, "coordenador_csso");
    const instrutor_id = await _instrutor();
    await _qualificacao(instrutor_id, { norma: "NR-35", valida_ate: somar_dias(HOJE, 15) });
    await naTransacao((tx) => rotinas.varrer_pendencias(tx));
    expect(await _pendencias_abertas()).toHaveLength(1);
    // outra norma não renova
    expect((await _cadastro(instrutor_id, { norma: "NR-10", valida_ate: somar_dias(HOJE, 700) })).status).toBe(303);
    expect(await _pendencias_abertas()).toHaveLength(1);
    // a mesma norma, escrita de outro jeito, renova
    expect((await _cadastro(instrutor_id, { norma: "nr 35", valida_ate: somar_dias(HOJE, 730) })).status).toBe(303);
    expect(await _pendencias_abertas()).toHaveLength(0);
    const [fechada] = await db.select().from(e.pendencia).where(eq(e.pendencia.tipo, q.TIPO_PENDENCIA));
    expect(fechada!.concluida).toBe(true);
    // e a rotina não a reabre
    await naTransacao((tx) => rotinas.varrer_pendencias(tx));
    expect(await _pendencias_abertas()).toHaveLength(0);
  });

  it("a inativação conclui a pendência", async () => {
    await entrar(cliente, "coordenador_csso");
    const instrutor_id = await _instrutor();
    const qid = await _qualificacao(instrutor_id, { treinamento_id: await _treinamento("NR-35", "NR-35"), valida_ate: somar_dias(HOJE, 3) });
    await naTransacao((tx) => rotinas.varrer_pendencias(tx));
    expect(await _pendencias_abertas()).toHaveLength(1);
    const r = await cliente.post(`/treinamentos/assinaturas/${instrutor_id}/qualificacoes/${qid}/inativar`, {}, { seguir: false });
    expect(r.status).toBe(303);
    expect(await _pendencias_abertas()).toHaveLength(0);
    const [linha] = await db.select().from(e.instrutor_qualificacao).where(eq(e.instrutor_qualificacao.id, qid));
    expect(linha).toMatchObject({ ativo: false });
    expect(linha!.inativado_por).toBe(await _coord_id());
    const eventos = await db
      .select()
      .from(e.historico_evento)
      .where(eq(e.historico_evento.tipo_evento, "INSTRUTOR_QUALIFICACAO_INATIVADA"));
    expect(eventos).toHaveLength(1);
  });

  it("o cadastro já dentro da janela abre o aviso no mesmo gesto", async () => {
    await entrar(cliente, "coordenador_csso");
    const instrutor_id = await _instrutor();
    expect((await _cadastro(instrutor_id, { valida_ate: somar_dias(HOJE, 10) })).status).toBe(303);
    expect(await _pendencias_abertas()).toHaveLength(1);
  });
});

describe("exclusão", () => {
  it("instrutor e treinamento com qualificação não se excluem", async () => {
    await entrar(cliente, "coordenador_csso");
    const treinamento_id = await _treinamento("NR-35", "NR-35");
    const instrutor_id = await _instrutor();
    await _qualificacao(instrutor_id, { treinamento_id });
    const r = await cliente.post(`/treinamentos/assinaturas/${instrutor_id}/excluir`, {});
    expect(r.text).toContain("qualificação(ões) cadastrada(s)");
    expect(await db.select().from(e.assinatura_instrutor)).toHaveLength(1);
  });
});
