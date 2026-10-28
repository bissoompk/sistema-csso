/**
 * A vitrine pública de cursos (/cursos): só a turma publicada aparece, cada aba
 * recebe as turmas certas, o pedido de vaga grava pelo mesmo caminho do link por
 * token, e a página pública não leva dado pessoal nem estilo ou script no HTML.
 * Dados fictícios.
 */
import { readFileSync } from "node:fs";
import { count, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import { hoje_iso, somar_dias } from "../src/dominio/datas.js";
import * as inscricao_publica from "../src/servicos/inscricao_publica.js";
import { bancoLimpo, contas, entrar, type Cliente } from "./ajuda";

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
  inscricao_publica.tempo_de_resposta.piso_ms = 0;
  inscricao_publica.tempo_de_resposta.variacao_ms = 0;
});

const INICIO = () => somar_dias(hoje_iso(), 30);
const DESCRICAO = "Capacitação para o trabalho em altura, com teoria, prática e avaliação ao final do curso.";

/** Uma turma com inscrições abertas e tudo o que a publicação pede, ainda não publicada. */
async function _turma(extra: Partial<typeof e.turma.$inferInsert> = {}, vagas = 10): Promise<number> {
  await entrar(cliente, "coordenador_csso");
  const rt = await cliente.post(
    "/treinamentos/catalogo",
    { codigo: "NR-35", nome: "Trabalho em Altura — NR-35", carga_horaria_horas: "8", validade_meses: "24", norma_referencia: "NR-35" },
    { seguir: false },
  );
  expect(rt.status, rt.text.slice(0, 200)).toBe(303);
  const [t] = await db.select().from(e.treinamento).where(eq(e.treinamento.codigo, "NR-35"));
  const r = await cliente.post(
    "/turmas",
    { treinamento_id: String(t!.id), data_inicio: INICIO(), data_fim: somar_dias(INICIO(), 1), local: "Auditório do Campus JK", vagas: String(vagas) },
    { seguir: false },
  );
  expect(r.status, r.text.slice(0, 200)).toBe(303);
  const [turma] = await db.select().from(e.turma);
  const [unidade] = await db.select().from(e.unidade_uorg).limit(1);
  await db
    .update(e.turma)
    .set({
      situacao: "INSCRICOES_ABERTAS",
      inscricao_aberta_ate: somar_dias(hoje_iso(), 10),
      unidade_promotora_id: unidade!.id,
      descricao: DESCRICAO,
      publico_alvo: ["SERVIDOR"],
      ...extra,
    })
    .where(eq(e.turma.id, turma!.id));
  return turma!.id;
}

async function _codigo(id: number): Promise<string> {
  const [t] = await db.select().from(e.turma).where(eq(e.turma.id, id));
  return t!.codigo;
}

async function _publicar(id: number, extra: Record<string, string | string[]> = {}) {
  return cliente.post(
    `/turmas/${id}/vitrine`,
    { divulgar: "sim", modalidade: "PRESENCIAL", publico: ["SERVIDOR"], ...extra },
    { seguir: false },
  );
}

describe("a vitrine pública", () => {
  it("turma não publicada não aparece na lista nem tem ficha", async () => {
    const id = await _turma();
    const codigo = await _codigo(id);
    const visitante = novoCliente();
    const lista = await visitante.get("/cursos");
    expect(lista.status).toBe(200);
    expect(lista.text).not.toContain(codigo);
    expect((await visitante.get(`/cursos/${codigo}`)).status).toBe(404);
  });

  it("publicar pede o que falta, e depois aparece em Inscrições abertas com ficha", async () => {
    const id = await _turma({ descricao: null, publico_alvo: [] });
    const codigo = await _codigo(id);
    const recusa = await cliente.post(`/turmas/${id}/vitrine`, { divulgar: "sim", modalidade: "PRESENCIAL" }, { seguir: false });
    expect(recusa.status).toBe(303);
    const [antes] = await db.select().from(e.turma).where(eq(e.turma.id, id));
    expect(antes!.divulgar_na_vitrine).toBe(false);

    await db.update(e.turma).set({ descricao: DESCRICAO }).where(eq(e.turma.id, id));
    const ok = await _publicar(id);
    expect(ok.status).toBe(303);
    const [depois] = await db.select().from(e.turma).where(eq(e.turma.id, id));
    expect(depois!.divulgar_na_vitrine).toBe(true);
    expect(depois!.divulgada_em).not.toBeNull();

    const visitante = novoCliente();
    const lista = await visitante.get("/cursos");
    expect(lista.text).toContain("Trabalho em Altura");
    expect(lista.text).toContain("Inscrições abertas (1)");
    expect(lista.text).toContain("Certificado incluso");
    const ficha = await visitante.get(`/cursos/${codigo}`);
    expect(ficha.status).toBe(200);
    expect(ficha.text).toContain("Pedir a vaga");
    expect(ficha.text).toContain("Auditório do Campus JK");
  });

  it("turma cancelada some; encerrada há mais de 90 dias responde 410", async () => {
    const id = await _turma();
    const codigo = await _codigo(id);
    await _publicar(id);
    const visitante = novoCliente();
    expect((await visitante.get(`/cursos/${codigo}`)).status).toBe(200);
    await db.update(e.turma).set({ situacao: "CANCELADA", motivo_cancelamento: "teste" }).where(eq(e.turma.id, id));
    expect((await visitante.get(`/cursos/${codigo}`)).status).toBe(404);
    const antigo = somar_dias(hoje_iso(), -120);
    await db
      .update(e.turma)
      .set({ situacao: "CONCLUIDA", motivo_cancelamento: null, data_inicio: somar_dias(antigo, -1), data_fim: antigo, inscricao_aberta_ate: null })
      .where(eq(e.turma.id, id));
    expect((await visitante.get(`/cursos/${codigo}`)).status).toBe(410);
  });

  it("cada aba recebe as turmas certas", async () => {
    const id = await _turma();
    await _publicar(id);
    const visitante = novoCliente();
    const hoje = hoje_iso();
    // planejada e futura: Em breve
    await db.update(e.turma).set({ situacao: "PLANEJADA", inscricao_aberta_ate: null }).where(eq(e.turma.id, id));
    expect((await visitante.get("/cursos?aba=breve")).text).toContain("Trabalho em Altura");
    expect((await visitante.get("/cursos?aba=abertas")).text).not.toContain("curso-cartao");
    // prazo terminou ontem: sai de Abertas
    await db.update(e.turma).set({ situacao: "INSCRICOES_ABERTAS", inscricao_aberta_ate: somar_dias(hoje, -1) }).where(eq(e.turma.id, id));
    expect((await visitante.get("/cursos?aba=abertas")).text).not.toContain("curso-cartao");
    // prazo termina hoje: ainda aberta, com o selo
    await db.update(e.turma).set({ inscricao_aberta_ate: hoje }).where(eq(e.turma.id, id));
    const hoje_aba = await visitante.get("/cursos?aba=abertas");
    expect(hoje_aba.text).toContain("Encerra hoje");
    // concluída há 10 dias: Realizados
    const fim = somar_dias(hoje, -10);
    await db
      .update(e.turma)
      .set({ situacao: "CONCLUIDA", data_inicio: somar_dias(fim, -1), data_fim: fim, inscricao_aberta_ate: null })
      .where(eq(e.turma.id, id));
    expect((await visitante.get("/cursos?aba=realizados")).text).toContain("Trabalho em Altura");
  });

  it("turma lotada fica em Abertas com o selo e sem formulário", async () => {
    const id = await _turma({}, 1);
    const codigo = await _codigo(id);
    await _publicar(id);
    const [turma] = await db.select().from(e.turma).where(eq(e.turma.id, id));
    const [part] = await db.insert(e.participante).values({ nome: "Fulano de Teste", vinculo: "VISITANTE", identificador_publico: "PTC-23456789" } as never).returning();
    await db.insert(e.inscricao).values({ turma_id: turma!.id, participante_id: part!.id, situacao: "CONFIRMADA", origem: "INTERNA" } as never);
    const visitante = novoCliente();
    expect((await visitante.get("/cursos")).text).toContain("Turma cheia");
    const ficha = await visitante.get(`/cursos/${codigo}`);
    expect(ficha.text).toContain("As vagas desta turma se esgotaram");
    expect(ficha.text).not.toContain("Pedir a vaga");
  });

  it("o pedido de vaga grava a inscrição; turma fechada não grava", async () => {
    const id = await _turma();
    const codigo = await _codigo(id);
    await _publicar(id);
    const visitante = novoCliente();
    const pedido = { nome: "Maria de Teste", vinculo: "DISCENTE", siape: "", email: "maria@exemplo.com", organizacao: "", consentimento: "sim", site: "" };
    const r = await visitante.post(`/cursos/${codigo}/inscricao`, pedido, { seguir: false });
    expect(r.status).toBe(303);
    const [n] = await db.select({ n: count() }).from(e.inscricao).where(eq(e.inscricao.turma_id, id));
    expect(Number(n!.n)).toBe(1);

    await db.update(e.turma).set({ situacao: "PLANEJADA" }).where(eq(e.turma.id, id));
    await visitante.post(`/cursos/${codigo}/inscricao`, { ...pedido, nome: "Outra Pessoa", email: "outra@exemplo.com" }, { seguir: false });
    const [m] = await db.select({ n: count() }).from(e.inscricao).where(eq(e.inscricao.turma_id, id));
    expect(Number(m!.n)).toBe(1);
  });

  it("o HTML público não leva nome, e-mail nem SIAPE de inscrito, nem estilo ou script inline", async () => {
    const id = await _turma();
    const codigo = await _codigo(id);
    await _publicar(id);
    const visitante = novoCliente();
    await visitante.post(
      `/cursos/${codigo}/inscricao`,
      { nome: "Maria de Teste", vinculo: "DISCENTE", siape: "", email: "maria@exemplo.com", organizacao: "", consentimento: "sim", site: "" },
      { seguir: false },
    );
    const outro = novoCliente();
    for (const caminho of ["/cursos", `/cursos/${codigo}`]) {
      const html = (await outro.get(caminho)).text;
      expect(html, caminho).not.toContain("Maria de Teste");
      expect(html, caminho).not.toContain("maria@exemplo.com");
      expect(html, caminho).not.toMatch(/\sstyle="/);
    }
  });

  it("os templates da vitrine não escrevem estilo nem script no HTML", () => {
    for (const t of ["paginas/vitrine.html", "paginas/vitrine_curso.html", "partes/vitrine_cartao.html", "partes/inscricao_formulario.html"]) {
      const fonte = readFileSync(new URL(`../templates/${t}`, import.meta.url), "utf8");
      expect(fonte, t).not.toMatch(/\sstyle=|<script|<style/);
    }
  });

  it("quem não tem turma.criar não publica", async () => {
    const id = await _turma();
    const servidor = await entrar(novoCliente(), "servidor_consulta");
    const r = await servidor.post(`/turmas/${id}/vitrine`, { divulgar: "sim", modalidade: "PRESENCIAL", publico: ["SERVIDOR"] }, { seguir: false });
    expect(r.status).toBe(403);
    const [t] = await db.select().from(e.turma).where(eq(e.turma.id, id));
    expect(t!.divulgar_na_vitrine).toBe(false);
  });
});
