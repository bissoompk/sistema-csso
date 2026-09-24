/**
 * Fatia 3 de Certificados e Treinamentos: presença, nota e conclusão.
 * Porte de `testes/integracao/test_presenca.py`.
 *
 * Os cenários passam pela porta da frente (HTTP) sempre que possível. Onde a
 * granularidade da permissão não existe em nenhum perfil real, o teste monta o
 * `UsuarioAtual` à mão e chama o serviço, que é onde a recusa mora.
 *
 * Cada teste ganha um banco virgem (`bancoLimpo()` no `beforeEach`), como o
 * fixture `banco` do Python: os testes leem "o primeiro treinamento", "a
 * primeira turma" e o código `TUR-AAAA-0001`.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

process.env.CSSO_DIR_ARQUIVOS = mkdtempSync(path.join(tmpdir(), "csso-presenca-"));

import { bancoLimpo, contas, criarUsuario, entrar, type Cliente, type Resposta } from "./ajuda";
import type { Banco } from "../src/db/cliente";
import * as e from "../src/db/esquema/index";
import { somar_dias } from "../src/dominio/datas";
import { hoje } from "../src/servicos/datas_br";
import { PermissaoNegada, UsuarioAtual } from "../src/servicos/rbac";
import * as auditoria from "../src/servicos/auditoria";
import * as documento from "../src/servicos/documento";
import * as servico_lista from "../src/servicos/lista_presenca";
import * as servico_presenca from "../src/servicos/presenca";
import * as servico_turma from "../src/servicos/turma";
import { definirArmazenamento, obterArmazenamento } from "../src/servicos/armazenamento";

definirArmazenamento(null);

const INICIO = somar_dias(hoje(), -2);
const FIM = INICIO;
const ANO = Number(INICIO.slice(0, 4));
const PRIMEIRA = `TUR-${ANO}-0001`;
const dia = (n: number) => somar_dias(INICIO, n);

const NR35 = {
  codigo: "NR-35",
  nome: "Trabalho em Altura — NR-35",
  carga_horaria_horas: "8",
  validade_meses: "24",
  norma_referencia: "NR-35",
};

const TURMA = {
  data_inicio: INICIO,
  data_fim: FIM,
  local: "Auditório do Campus JK",
  frequencia_minima_percentual: "75",
};

// o primeiro banco é clonado; os seguintes restauram o mesmo (testes/ajuda.ts)
let { db, novoCliente } = await bancoLimpo();
let cliente: Cliente;

beforeEach(async () => {
  ({ db, novoCliente } = await bancoLimpo());
  await contas(db);
  cliente = novoCliente();
});

// =====================================================================
// Montagem
// =====================================================================
async function mensagem(c: Cliente, resposta: Resposta): Promise<string> {
  expect(resposta.status, resposta.text.slice(0, 500)).toBe(303);
  return (await c.get(resposta.location!)).text;
}

async function criarServidor(siape = "1110654", nome = "Marco Antônio"): Promise<number> {
  const [s] = await db.insert(e.servidor).values({ siape, nome }).returning();
  return s!.id;
}

async function usuarioCom(permissoes: string[], login = "operador"): Promise<UsuarioAtual> {
  const conta = await criarUsuario(db, { login, nome: "Operador de teste" });
  return new UsuarioAtual({ id: conta.id, login, nome: "Operador de teste", permissoes, perfis: ["coordenador_csso"] });
}

/** Catálogo + turma + a turma já em andamento, que é quando se lança. */
async function montar(c: Cliente, d: { turma?: Record<string, string>; treinamento?: Record<string, string> } = {}) {
  let r = await c.post("/treinamentos/catalogo", { ...NR35, ...(d.treinamento ?? {}) }, { seguir: false });
  expect(r.status, r.text.slice(0, 500)).toBe(303);
  const [t] = await db.select().from(e.treinamento).orderBy(asc(e.treinamento.id)).limit(1);
  r = await c.post("/turmas", { treinamento_id: String(t!.id), ...TURMA, ...(d.turma ?? {}) }, { seguir: false });
  expect(r.status, r.text.slice(0, 500)).toBe(303);
  const [turma] = await db.select().from(e.turma).orderBy(asc(e.turma.id)).limit(1);
  for (const destino of ["INSCRICOES_ABERTAS", "EM_ANDAMENTO"]) {
    expect((await c.post(`/turmas/${turma!.id}/situacao`, { destino }, { seguir: false })).status).toBe(303);
  }
  return turma!.id;
}

async function inscrever(c: Cliente, turma_id: number, siape: string, nome: string): Promise<number> {
  const r = await c.post(
    `/turmas/${turma_id}/inscricoes`,
    { servidor_id: String(await criarServidor(siape, nome)) },
    { seguir: false },
  );
  expect(r.status, r.text.slice(0, 500)).toBe(303);
  const [i] = await db.select().from(e.inscricao).orderBy(desc(e.inscricao.id)).limit(1);
  return i!.id;
}

/** Coordenador logado, turma de 8h de um dia, em andamento, com uma inscrita. */
async function turmaRodando() {
  await entrar(cliente, "coordenador_csso");
  const turma_id = await montar(cliente);
  const inscricao_id = await inscrever(cliente, turma_id, "1110654", "Marco Antônio");
  return { turma_id, inscricao_id };
}

function lancar(c: Cliente, turma_id: number, inscricao_id: number, campos: Record<string, string> = {}) {
  return c.post(
    `/turmas/${turma_id}/presencas`,
    { inscricao_id: String(inscricao_id), data: INICIO, presente: "1", ...campos },
    { seguir: false },
  );
}

function concluir(c: Cliente, turma_id: number) {
  return c.post(`/turmas/${turma_id}/situacao`, { destino: "CONCLUIDA" }, { seguir: false });
}

async function inscricao(id: number) {
  const [i] = await db.select().from(e.inscricao).where(eq(e.inscricao.id, id));
  return i!;
}

async function presencasDe(id: number) {
  return db.select().from(e.turma_presenca).where(eq(e.turma_presenca.inscricao_id, id)).orderBy(asc(e.turma_presenca.data));
}

async function algumaPresenca() {
  return (await db.select().from(e.turma_presenca).limit(1))[0] ?? null;
}

async function eventoReprovado() {
  const eventos = await db
    .select()
    .from(e.historico_evento)
    .where(and(eq(e.historico_evento.entidade, "inscricao"), eq(e.historico_evento.campo, "situacao")));
  const r = eventos.filter((ev) => ev.valor_novo === "REPROVADO");
  expect(r).toHaveLength(1);
  return r[0]!;
}

// =====================================================================
// Frequência — a conta e o denominador
// =====================================================================
describe("frequência", () => {
  it("lançar presença calcula a frequência", async () => {
    const { turma_id, inscricao_id } = await turmaRodando();
    expect((await lancar(cliente, turma_id, inscricao_id, { horas: "8" })).status).toBe(303);
    const i = await inscricao(inscricao_id);
    expect(i.frequencia_percentual).toBe("100.00");
    expect(i.situacao).toBe("PRESENTE");
    expect((await presencasDe(inscricao_id)).map((p) => [p.data, p.presente, p.horas])).toEqual([[INICIO, true, "8.0"]]);
  });

  it("o denominador é a carga da turma e não a do catálogo", async () => {
    await entrar(cliente, "coordenador_csso");
    const turma_id = await montar(cliente, { treinamento: { carga_horaria_horas: "40" }, turma: { carga_horaria_horas: "8" } });
    const inscricao_id = await inscrever(cliente, turma_id, "1110654", "Marco Antônio");
    await lancar(cliente, turma_id, inscricao_id, { horas: "6" });
    const carregada = (await servico_turma.carregar_inscricao(db, inscricao_id))!;
    // `Decimal("40.0") ==` do Python compara valor, não texto
    expect(Number(carregada.turma.treinamento.carga_horaria_horas)).toBe(40);
    expect(Number(carregada.turma.carga_horaria_horas)).toBe(8);
    expect(carregada.frequencia_percentual).toBe("75.00");
  });

  it("frequência na fronteira exata do mínimo aprova", async () => {
    await entrar(cliente, "coordenador_csso");
    const turma_id = await montar(cliente, { turma: { data_fim: dia(1) } });
    const inscricao_id = await inscrever(cliente, turma_id, "1110654", "Marco Antônio");
    await lancar(cliente, turma_id, inscricao_id, { horas: "6" });
    await concluir(cliente, turma_id);
    const i = await inscricao(inscricao_id);
    expect(i.frequencia_percentual).toBe("75.00");
    expect(i.situacao).toBe("APROVADO");
  });

  it("um centésimo abaixo do mínimo reprova", async () => {
    await entrar(cliente, "coordenador_csso");
    const turma_id = await montar(cliente, { turma: { data_fim: dia(1) } });
    const inscricao_id = await inscrever(cliente, turma_id, "1110654", "Marco Antônio");
    await lancar(cliente, turma_id, inscricao_id, { horas: "5,9" });
    await concluir(cliente, turma_id);
    const i = await inscricao(inscricao_id);
    expect(i.frequencia_percentual).toBe("73.75");
    expect(i.situacao).toBe("REPROVADO");
    expect((await eventoReprovado()).descricao).toContain("abaixo do mínimo de 75%");
  });

  it("total acima da carga da turma é recusado", async () => {
    await entrar(cliente, "coordenador_csso");
    const turma_id = await montar(cliente, { turma: { data_fim: dia(1) } });
    const inscricao_id = await inscrever(cliente, turma_id, "1110654", "Marco Antônio");
    await lancar(cliente, turma_id, inscricao_id, { horas: "6" });
    const texto = await mensagem(cliente, await lancar(cliente, turma_id, inscricao_id, { data: dia(1), horas: "4" }));
    expect(texto).toContain("acima da carga da turma");
    expect((await inscricao(inscricao_id)).frequencia_percentual).toBe("75.00");
  });

  it("relançar o mesmo dia corrige em vez de somar", async () => {
    const { turma_id, inscricao_id } = await turmaRodando();
    await lancar(cliente, turma_id, inscricao_id, { horas: "4" });
    await lancar(cliente, turma_id, inscricao_id, { horas: "8" });
    expect(await presencasDe(inscricao_id)).toHaveLength(1);
    expect((await inscricao(inscricao_id)).frequencia_percentual).toBe("100.00");
  });

  it("dia fora do período da turma é recusado", async () => {
    const { turma_id, inscricao_id } = await turmaRodando();
    const texto = await mensagem(cliente, await lancar(cliente, turma_id, inscricao_id, { data: dia(30), horas: "8" }));
    expect(texto).toContain("não é dia de");
    expect(await presencasDe(inscricao_id)).toEqual([]);
  });

  it("falta não acumula hora e a justificativa não abate", async () => {
    const { turma_id, inscricao_id } = await turmaRodando();
    await lancar(cliente, turma_id, inscricao_id, { presente: "", horas: "8", justificativa: "atestado médico" });
    const [p] = await presencasDe(inscricao_id);
    expect(p!.horas).toBe("0.0");
    expect(p!.justificativa).toBe("atestado médico");
    const i = await inscricao(inscricao_id);
    expect(i.frequencia_percentual).toBe("0.00");
    expect(i.situacao).toBe("AUSENTE");
  });

  it("turma de vários dias exige as horas do dia", async () => {
    await entrar(cliente, "coordenador_csso");
    const turma_id = await montar(cliente, { turma: { data_fim: dia(2) } });
    const inscricao_id = await inscrever(cliente, turma_id, "1110654", "Marco Antônio");
    const texto = await mensagem(cliente, await lancar(cliente, turma_id, inscricao_id));
    expect(texto).toContain("informe as horas deste dia");
    expect(await presencasDe(inscricao_id)).toEqual([]);
  });
});

// =====================================================================
// Marcar todos presentes
// =====================================================================
describe("marcar todos presentes", () => {
  it("no curso de um dia", async () => {
    const { turma_id } = await turmaRodando();
    await inscrever(cliente, turma_id, "2165804", "Fabrício Andrade");
    expect((await cliente.post(`/turmas/${turma_id}/presencas/todos`, {}, { seguir: false })).status).toBe(303);
    const inscricoes = await db.select().from(e.inscricao);
    expect(inscricoes).toHaveLength(2);
    for (const i of inscricoes) {
      expect(i.situacao).toBe("PRESENTE");
      expect(i.frequencia_percentual).toBe("100.00");
      expect((await presencasDe(i.id)).map((p) => p.horas)).toEqual(["8.0"]);
    }
  });

  it("é recusado em turma de vários dias", async () => {
    await entrar(cliente, "coordenador_csso");
    const turma_id = await montar(cliente, { turma: { data_fim: dia(2) } });
    await inscrever(cliente, turma_id, "1110654", "Marco Antônio");
    const texto = await mensagem(cliente, await cliente.post(`/turmas/${turma_id}/presencas/todos`, {}, { seguir: false }));
    expect(texto).toContain("marque dia a dia");
    expect(await algumaPresenca()).toBeNull();
    // e o botão nem aparece na tela, para não fazer a pessoa tentar
    expect((await cliente.get(`/turmas/${turma_id}?aba=presencas`)).text).not.toContain("Marcar todos presentes");
  });

  it("inscrição cancelada fica de fora do lote", async () => {
    const { turma_id, inscricao_id } = await turmaRodando();
    const outra = await inscrever(cliente, turma_id, "2165804", "Fabrício Andrade");
    await cliente.post(`/turmas/${turma_id}/inscricoes/${outra}`, { destino: "CANCELADA", motivo: "desistiu" }, { seguir: false });
    await cliente.post(`/turmas/${turma_id}/presencas/todos`, {}, { seguir: false });
    expect(await presencasDe(outra)).toEqual([]);
    expect((await inscricao(outra)).situacao).toBe("CANCELADA");
    expect((await inscricao(inscricao_id)).situacao).toBe("PRESENTE");
  });

  it("lançar para inscrição cancelada é recusado", async () => {
    const { turma_id, inscricao_id } = await turmaRodando();
    await cliente.post(`/turmas/${turma_id}/inscricoes/${inscricao_id}`, { destino: "CANCELADA", motivo: "desistiu" }, { seguir: false });
    const texto = await mensagem(cliente, await lancar(cliente, turma_id, inscricao_id, { horas: "8" }));
    expect(texto).toContain("não recebe lançamento");
  });

  it("lançar em turma planejada é recusado", async () => {
    await entrar(cliente, "coordenador_csso");
    expect((await cliente.post("/treinamentos/catalogo", NR35, { seguir: false })).status).toBe(303);
    const [t] = await db.select().from(e.treinamento).limit(1);
    await cliente.post("/turmas", { treinamento_id: String(t!.id), ...TURMA }, { seguir: false });
    const [turma] = await db.select().from(e.turma).limit(1);
    const inscricao_id = await inscrever(cliente, turma!.id, "1110654", "Marco Antônio");
    const texto = await mensagem(cliente, await lancar(cliente, turma!.id, inscricao_id, { horas: "8" }));
    expect(texto).toContain("passe a turma para em andamento");
    expect(await algumaPresenca()).toBeNull();
  });
});

// =====================================================================
// Nota
// =====================================================================
describe("nota", () => {
  it("lançar nota e apagar nota (campo em branco NÃO apaga)", async () => {
    const { turma_id, inscricao_id } = await turmaRodando();
    await cliente.post(`/turmas/${turma_id}/notas`, { inscricao_id: String(inscricao_id), nota: "9,5" }, { seguir: false });
    expect((await inscricao(inscricao_id)).nota_final).toBe("9.50");

    const texto = await mensagem(
      cliente,
      await cliente.post(`/turmas/${turma_id}/notas`, { inscricao_id: String(inscricao_id), nota: "" }, { seguir: false }),
    );
    expect(texto).toContain("não apaga o que já está lançado");
    expect((await inscricao(inscricao_id)).nota_final).toBe("9.50");

    await cliente.post(`/turmas/${turma_id}/notas`, { inscricao_id: String(inscricao_id), apagar: "1" }, { seguir: false });
    expect((await inscricao(inscricao_id)).nota_final).toBeNull();
  });

  it("nota fora da faixa é recusada", async () => {
    const { turma_id, inscricao_id } = await turmaRodando();
    const texto = await mensagem(
      cliente,
      await cliente.post(`/turmas/${turma_id}/notas`, { inscricao_id: String(inscricao_id), nota: "11" }, { seguir: false }),
    );
    expect(texto).toContain("entre 0 e 10");
    expect((await inscricao(inscricao_id)).nota_final).toBeNull();
  });

  it("turma sem nota mínima aprova só pela frequência", async () => {
    const { turma_id, inscricao_id } = await turmaRodando();
    await lancar(cliente, turma_id, inscricao_id, { horas: "8" });
    await concluir(cliente, turma_id);
    const [turma] = await db.select().from(e.turma).where(eq(e.turma.id, turma_id));
    expect(turma!.nota_minima_aprovacao).toBeNull();
    const i = await inscricao(inscricao_id);
    expect(i.nota_final).toBeNull();
    expect(i.situacao).toBe("APROVADO");
  });

  it("turma com nota mínima reprova quem não tem nota", async () => {
    await entrar(cliente, "coordenador_csso");
    const turma_id = await montar(cliente, { turma: { nota_minima_aprovacao: "7" } });
    const inscricao_id = await inscrever(cliente, turma_id, "1110654", "Marco Antônio");
    await lancar(cliente, turma_id, inscricao_id, { horas: "8" });
    await concluir(cliente, turma_id);
    const i = await inscricao(inscricao_id);
    expect(i.frequencia_percentual).toBe("100.00");
    expect(i.situacao).toBe("REPROVADO");
    expect((await eventoReprovado()).descricao).toContain("nota não lançada");
  });

  it("nota abaixo da mínima reprova com frequência cheia", async () => {
    await entrar(cliente, "coordenador_csso");
    const turma_id = await montar(cliente, { turma: { nota_minima_aprovacao: "7" } });
    const inscricao_id = await inscrever(cliente, turma_id, "1110654", "Marco Antônio");
    await lancar(cliente, turma_id, inscricao_id, { horas: "8" });
    await cliente.post(`/turmas/${turma_id}/notas`, { inscricao_id: String(inscricao_id), nota: "6,5" }, { seguir: false });
    await concluir(cliente, turma_id);
    expect((await inscricao(inscricao_id)).situacao).toBe("REPROVADO");
  });
});

// =====================================================================
// Conclusão da turma — o mesmo ato
// =====================================================================
describe("conclusão", () => {
  it("concluir apura todo mundo no mesmo ato", async () => {
    const { turma_id, inscricao_id: presente_id } = await turmaRodando();
    const faltoso_id = await inscrever(cliente, turma_id, "2165804", "Fabrício Andrade");
    await lancar(cliente, turma_id, presente_id, { horas: "8" });

    expect((await concluir(cliente, turma_id)).status).toBe(303);
    const [turma] = await db.select().from(e.turma).where(eq(e.turma.id, turma_id));
    expect(turma!.situacao).toBe("CONCLUIDA");
    expect(turma!.concluida_em).not.toBeNull();
    expect((await inscricao(presente_id)).situacao).toBe("APROVADO");
    const faltoso = await inscricao(faltoso_id);
    // §7: inscrição sem presença registrada vira AUSENTE e daí REPROVADO
    expect(faltoso.situacao).toBe("REPROVADO");
    expect(faltoso.frequencia_percentual).toBe("0.00");
    const estados = (
      await db
        .select()
        .from(e.historico_evento)
        .where(
          and(
            eq(e.historico_evento.entidade, "inscricao"),
            eq(e.historico_evento.entidade_id, faltoso_id),
            eq(e.historico_evento.campo, "situacao"),
          ),
        )
        .orderBy(asc(e.historico_evento.id))
    ).map((ev) => [ev.valor_anterior, ev.valor_novo]);
    expect(estados).toEqual([
      ["INSCRITA", "AUSENTE"],
      ["AUSENTE", "REPROVADO"],
    ]);
    const resumos = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "TURMA_APURADA"));
    expect(resumos).toHaveLength(1);
    expect(resumos[0]!.descricao).toContain("1 aprovado(s), 1 reprovado(s)");
  });

  it("concluir turma sem ninguém inscrito", async () => {
    await entrar(cliente, "coordenador_csso");
    const turma_id = await montar(cliente);
    expect((await concluir(cliente, turma_id)).status).toBe(303);
    const [turma] = await db.select().from(e.turma).where(eq(e.turma.id, turma_id));
    expect(turma!.situacao).toBe("CONCLUIDA");
    const resumos = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "TURMA_APURADA"));
    expect(resumos).toHaveLength(1);
    expect(resumos[0]!.descricao).toContain("nenhum inscrito a apurar");
  });

  it("conclusão não apura quem cancelou", async () => {
    const { turma_id, inscricao_id } = await turmaRodando();
    await cliente.post(`/turmas/${turma_id}/inscricoes/${inscricao_id}`, { destino: "CANCELADA", motivo: "mudou de setor" }, { seguir: false });
    await concluir(cliente, turma_id);
    const i = await inscricao(inscricao_id);
    expect(i.situacao).toBe("CANCELADA");
    expect(i.frequencia_percentual).toBeNull();
  });
});

// =====================================================================
// Retificação depois do fecho
// =====================================================================
describe("retificação", () => {
  it("retificar depois do fecho exige motivo e vira o resultado", async () => {
    const { turma_id, inscricao_id } = await turmaRodando();
    await concluir(cliente, turma_id);
    expect((await inscricao(inscricao_id)).situacao).toBe("REPROVADO");

    const sem_motivo = await mensagem(cliente, await lancar(cliente, turma_id, inscricao_id, { horas: "8" }));
    expect(sem_motivo).toContain("retificação exige o motivo");
    expect((await inscricao(inscricao_id)).situacao).toBe("REPROVADO");
    expect(await algumaPresenca()).toBeNull();

    expect(
      (await lancar(cliente, turma_id, inscricao_id, { horas: "8", motivo: "folha do dia 1 chegou depois do fecho" })).status,
    ).toBe(303);
    const i = await inscricao(inscricao_id);
    expect(i.situacao).toBe("APROVADO");
    expect(i.frequencia_percentual).toBe("100.00");
    const eventos = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "RESULTADO_RETIFICADO"));
    expect(eventos).toHaveLength(1);
    expect([eventos[0]!.valor_anterior, eventos[0]!.valor_novo]).toEqual(["REPROVADO", "APROVADO"]);
    expect(eventos[0]!.comentario).toBe("folha do dia 1 chegou depois do fecho");
  });

  it("retificar exige a permissão de concluir", async () => {
    const { turma_id, inscricao_id } = await turmaRodando();
    await concluir(cliente, turma_id);
    const avaliador = await usuarioCom(["turma.avaliar"]);
    const i = (await servico_turma.carregar_inscricao(db, inscricao_id))!;
    const erro = await db
      .transaction((tx) => servico_presenca.lancar_presenca(tx, avaliador, i, { data: INICIO, horas: "8", motivo: "qualquer" }))
      .catch((x) => x);
    expect(erro).toBeInstanceOf(PermissaoNegada);
    expect((erro as PermissaoNegada).codigo).toBe("turma.concluir");
  });

  it("retificar nota reavalia o resultado", async () => {
    await entrar(cliente, "coordenador_csso");
    const turma_id = await montar(cliente, { turma: { nota_minima_aprovacao: "7" } });
    const inscricao_id = await inscrever(cliente, turma_id, "1110654", "Marco Antônio");
    await lancar(cliente, turma_id, inscricao_id, { horas: "8" });
    await cliente.post(`/turmas/${turma_id}/notas`, { inscricao_id: String(inscricao_id), nota: "5" }, { seguir: false });
    await concluir(cliente, turma_id);
    expect((await inscricao(inscricao_id)).situacao).toBe("REPROVADO");
    await cliente.post(
      `/turmas/${turma_id}/notas`,
      { inscricao_id: String(inscricao_id), nota: "8", motivo: "erro de digitação conferido na prova" },
      { seguir: false },
    );
    const i = await inscricao(inscricao_id);
    expect([i.nota_final, i.situacao]).toEqual(["8.00", "APROVADO"]);
  });

  it("turma cancelada não recebe lançamento", async () => {
    const { turma_id, inscricao_id } = await turmaRodando();
    await cliente.post(`/turmas/${turma_id}/situacao`, { destino: "CANCELADA", motivo: "instrutor adoeceu" }, { seguir: false });
    const texto = await mensagem(cliente, await lancar(cliente, turma_id, inscricao_id, { horas: "8", motivo: "tentativa" }));
    expect(texto).toContain("passe a turma para em andamento");
  });
});

// =====================================================================
// Recusa deixa o banco limpo
// =====================================================================
describe("recusa não grava", () => {
  it.each([
    ["horas-acima-da-carga", { horas: "99" }, "passa da carga da turma"],
    ["dia-fora-do-periodo", { horas: "8", data: dia(90) }, "não é dia de"],
  ] as const)("presença: %s", async (_id, campos, trecho) => {
    const { turma_id, inscricao_id } = await turmaRodando();
    const texto = await mensagem(cliente, await lancar(cliente, turma_id, inscricao_id, { ...campos }));
    expect(texto).toContain(trecho);
    expect(await algumaPresenca()).toBeNull();
    const i = await inscricao(inscricao_id);
    expect(i.frequencia_percentual).toBeNull();
    expect(i.situacao).toBe("INSCRITA");
  });

  it("recusa de nota não deixa nada gravado", async () => {
    const { turma_id, inscricao_id } = await turmaRodando();
    await cliente.post(`/turmas/${turma_id}/notas`, { inscricao_id: String(inscricao_id), nota: "8" }, { seguir: false });
    const texto = await mensagem(
      cliente,
      await cliente.post(`/turmas/${turma_id}/notas`, { inscricao_id: String(inscricao_id), nota: "-1" }, { seguir: false }),
    );
    expect(texto).toContain("entre 0 e 10");
    expect((await inscricao(inscricao_id)).nota_final).toBe("8.00");
  });

  it("lançamento em inscrição de outra turma é recusado", async () => {
    const { turma_id, inscricao_id } = await turmaRodando();
    const [t] = await db.select().from(e.treinamento).limit(1);
    await cliente.post("/turmas", { treinamento_id: String(t!.id), ...TURMA }, { seguir: false });
    const [outra] = await db.select().from(e.turma).where(ne(e.turma.id, turma_id)).limit(1);
    const texto = await mensagem(cliente, await lancar(cliente, outra!.id, inscricao_id, { horas: "8" }));
    expect(texto).toContain("Inscrição não encontrada nesta turma");
    expect(await algumaPresenca()).toBeNull();
  });
});

// =====================================================================
// Permissão
// =====================================================================
describe("permissão", () => {
  it.each([
    ["/presencas", { inscricao_id: "1", data: INICIO, presente: "1" }],
    ["/presencas/todos", {}],
    ["/notas", { inscricao_id: "1", nota: "8" }],
  ] as const)("escrita negada para quem só consulta: %s", async (caminho, dados) => {
    const { turma_id } = await turmaRodando();
    await entrar(cliente, "auditor_interno");
    expect((await cliente.post(`/turmas/${turma_id}${caminho}`, { ...dados })).status).toBe(403);
  });

  it("lista de presença negada para quem só consulta", async () => {
    const { turma_id } = await turmaRodando();
    await entrar(cliente, "auditor_interno");
    expect((await cliente.get(`/turmas/${turma_id}/lista-presenca`)).status).toBe(403);
  });

  it("lançar sem permissão de avaliar é negado (a guarda é do serviço)", async () => {
    const { inscricao_id } = await turmaRodando();
    const sem_permissao = await usuarioCom(["turma.inscrever"], "so_inscreve");
    const i = (await servico_turma.carregar_inscricao(db, inscricao_id))!;
    const erro = await db
      .transaction((tx) => servico_presenca.lancar_presenca(tx, sem_permissao, i, { data: INICIO, horas: "8" }))
      .catch((x) => x);
    expect(erro).toBeInstanceOf(PermissaoNegada);
    expect((erro as PermissaoNegada).codigo).toBe("turma.avaliar");
  });

  it("a secretaria lança presença", async () => {
    await entrar(cliente, "coordenador_csso");
    const turma_id = await montar(cliente);
    const inscricao_id = await inscrever(cliente, turma_id, "1110654", "Marco Antônio");
    await entrar(cliente, "secretaria_csso");
    expect((await lancar(cliente, turma_id, inscricao_id, { horas: "8" })).status).toBe(303);
    expect((await inscricao(inscricao_id)).frequencia_percentual).toBe("100.00");
  });
});

// =====================================================================
// Aba 3 e lista de presença
// =====================================================================
describe("aba 3 e lista de presença", () => {
  it("a aba mostra a grade e destaca quem está abaixo", async () => {
    const { turma_id, inscricao_id } = await turmaRodando();
    await lancar(cliente, turma_id, inscricao_id, { horas: "4" });
    const corpo = (await cliente.get(`/turmas/${turma_id}?aba=presencas`)).text;
    expect(corpo).toContain("Presença e notas");
    expect(corpo).toContain("Marco Antônio");
    expect(corpo).toContain("50.00%");
    expect(corpo).toContain("abaixo do mínimo de 75%");
  });

  it("a aba abre em leitura para quem só consulta", async () => {
    const { turma_id, inscricao_id } = await turmaRodando();
    await lancar(cliente, turma_id, inscricao_id, { horas: "8" });
    await entrar(cliente, "auditor_interno");
    const corpo = (await cliente.get(`/turmas/${turma_id}?aba=presencas`)).text;
    expect(corpo).toContain("Marco Antônio");
    expect(corpo).toContain("100.00%");
    expect(corpo).not.toContain(`action="/turmas/${turma_id}/presencas"`);
    expect(corpo).not.toContain(`action="/turmas/${turma_id}/notas"`);
    expect(corpo).not.toContain("lista-presenca");
  });

  async function textoDaLista(turma_id: number): Promise<string> {
    const [turma] = await db.select().from(e.turma).where(eq(e.turma.id, turma_id));
    const bytes = await obterArmazenamento().ler(servico_lista.caminho_saida(turma!));
    return documento.extrair_texto(bytes);
  }

  it("a lista de presença sai em .docx", async () => {
    const { turma_id } = await turmaRodando();
    await inscrever(cliente, turma_id, "2165804", "Fabrício Andrade");
    const r = await cliente.get(`/turmas/${turma_id}/lista-presenca`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")!.startsWith("application/vnd.openxmlformats")).toBe(true);
    // o código da turma entra inteiro no nome
    expect(r.headers.get("content-disposition")).toContain(`Lista_Presenca_${PRIMEIRA}.docx`);
    const texto = await textoDaLista(turma_id);
    expect(texto).toContain("LISTA DE PRESENÇA");
    expect(texto).toContain(PRIMEIRA);
    expect(texto).toContain("Marco Antônio");
    expect(texto).toContain("Fabrício Andrade");
    expect(texto).toContain("8 horas");
    expect(texto).toContain("Assinatura");
  });

  it("a lista de presença não traz quem cancelou", async () => {
    const { turma_id } = await turmaRodando();
    const outra = await inscrever(cliente, turma_id, "2165804", "Fabrício Andrade");
    await cliente.post(`/turmas/${turma_id}/inscricoes/${outra}`, { destino: "CANCELADA", motivo: "desistiu" }, { seguir: false });
    expect((await cliente.get(`/turmas/${turma_id}/lista-presenca`)).status).toBe(200);
    const texto = await textoDaLista(turma_id);
    expect(texto).toContain("Marco Antônio");
    expect(texto).not.toContain("Fabrício Andrade");
  });

  it("gerar a lista entra na auditoria", async () => {
    const { turma_id } = await turmaRodando();
    await cliente.get(`/turmas/${turma_id}/lista-presenca`);
    const eventos = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "LISTA_PRESENCA_GERADA"));
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.descricao).toContain(PRIMEIRA);
    expect(eventos[0]!.descricao).toContain("1 participante(s)");
  });

  it("a trilha registra cada lançamento", async () => {
    const { turma_id, inscricao_id } = await turmaRodando();
    await lancar(cliente, turma_id, inscricao_id, { horas: "4" });
    await lancar(cliente, turma_id, inscricao_id, { horas: "8" });
    const eventos = await db
      .select()
      .from(e.historico_evento)
      .where(eq(e.historico_evento.tipo_evento, "PRESENCA_LANCADA"))
      .orderBy(asc(e.historico_evento.id));
    expect(eventos).toHaveLength(2);
    expect(eventos[0]!.descricao).toContain("frequência 50%");
    expect(eventos[1]!.descricao).toContain("frequência 100%");
    expect(eventos[1]!.descricao).toContain("antes: presente, 4h");
    expect([eventos[1]!.valor_anterior, eventos[1]!.valor_novo]).toEqual(["50.00", "100.00"]);
  });

  it("a cadeia de auditoria continua íntegra", async () => {
    const { turma_id, inscricao_id } = await turmaRodando();
    await lancar(cliente, turma_id, inscricao_id, { horas: "8" });
    await concluir(cliente, turma_id);
    const [ok, defeito] = await auditoria.cadeia_integra(db);
    expect(ok, String(defeito)).toBe(true);
  });
});

// =====================================================================
// A troca parcial da grade
// =====================================================================
describe("troca parcial (HTMX)", () => {
  it("lançar presença por htmx devolve a linha e não a página", async () => {
    const { turma_id, inscricao_id } = await turmaRodando();
    const r = await cliente.post(
      `/turmas/${turma_id}/presencas`,
      { inscricao_id: String(inscricao_id), data: INICIO, presente: "1", horas: "8" },
      { seguir: false, cabecalhos: { "HX-Request": "true" } },
    );
    expect(r.status, r.text.slice(0, 500)).toBe(200);
    const corpo = r.text;
    expect(corpo.trimStart().startsWith("<tr"), corpo.slice(0, 200)).toBe(true);
    expect(corpo).not.toContain("<html");
    expect(corpo).toContain("100.00%");
    // DESVIO: o Python mostrava "8h" (o Decimal('8') em memória); aqui
    // `Inscricao.horas_presentes` (dominio) escreve sempre uma casa: "8.0h"
    expect(corpo).toContain('<td class="mono">8.0h</td>');
    expect(corpo).toContain("Presente");
    expect(corpo.includes('method="post"') && corpo.includes('hx-post="/turmas/')).toBe(true);
    expect((await inscricao(inscricao_id)).frequencia_percentual).toBe("100.00");
  });

  it("sem htmx a mesma rota continua respondendo 303 com âncora", async () => {
    const { turma_id, inscricao_id } = await turmaRodando();
    const r = await lancar(cliente, turma_id, inscricao_id, { horas: "8" });
    expect(r.status).toBe(303);
    expect(r.location!.endsWith("#grade-presenca")).toBe(true);
  });

  it("a recusa de regra volta em 200 com o motivo na célula", async () => {
    await entrar(cliente, "coordenador_csso");
    const turma_id = await montar(cliente, { turma: { data_fim: dia(2) } });
    const inscricao_id = await inscrever(cliente, turma_id, "1110654", "Marco Antônio");
    const r = await cliente.post(
      `/turmas/${turma_id}/presencas`,
      { inscricao_id: String(inscricao_id), data: INICIO, presente: "1", horas: "" },
      { seguir: false, cabecalhos: { "HX-Request": "true" } },
    );
    expect(r.status).toBe(200);
    expect(r.text.toLowerCase()).toContain("informe as horas deste dia");
    expect(r.text).toContain("recusa-na-celula");
    expect(await algumaPresenca()).toBeNull();
  });

  it("lançar nota por htmx devolve a linha", async () => {
    const { turma_id, inscricao_id } = await turmaRodando();
    const r = await cliente.post(
      `/turmas/${turma_id}/notas`,
      { inscricao_id: String(inscricao_id), nota: "9,5" },
      { seguir: false, cabecalhos: { "HX-Request": "true" } },
    );
    expect(r.status).toBe(200);
    expect(r.text.trimStart().startsWith("<tr")).toBe(true);
    expect((await inscricao(inscricao_id)).nota_final).toBe("9.50");
  });
});

// =====================================================================
// O botão por coluna — a folha de um dia
// =====================================================================
describe("a folha de um dia", () => {
  it("marcar a coluna lança o dia para todos", async () => {
    await entrar(cliente, "coordenador_csso");
    const turma_id = await montar(cliente, { turma: { data_fim: dia(1) } });
    await inscrever(cliente, turma_id, "1110654", "Marco Antônio");
    await inscrever(cliente, turma_id, "1110655", "Joana Silva");
    const r = await cliente.post(`/turmas/${turma_id}/presencas/dia`, { data: INICIO, horas: "4" }, { seguir: false });
    expect(r.status).toBe(303);
    expect(r.location!.endsWith("#grade-presenca")).toBe(true);
    const marcas = await db.select().from(e.turma_presenca);
    expect(marcas).toHaveLength(2);
    expect(new Set(marcas.map((m) => `${m.data}|${m.presente}|${m.horas}`))).toEqual(new Set([`${INICIO}|true|4.0`]));
  });

  it("a coluna recusa dia que não é da turma", async () => {
    await entrar(cliente, "coordenador_csso");
    const turma_id = await montar(cliente, { turma: { data_fim: dia(1) } });
    await inscrever(cliente, turma_id, "1110654", "Marco Antônio");
    const texto = await mensagem(
      cliente,
      await cliente.post(`/turmas/${turma_id}/presencas/dia`, { data: dia(9), horas: "4" }, { seguir: false }),
    );
    expect(texto).toContain("não é dia de");
    expect(await algumaPresenca()).toBeNull();
  });
});
