/**
 * Visões salvas que filtram de verdade, agrupamento e ações em lote.
 * Porte de `testes/integracao/test_listas_e_lote.py`.
 *
 * Cada teste que CONTA precisa de banco próprio (o Python tinha um por teste);
 * aqui cada um chama `bancoLimpo()` — barato, é um clone do modelo.
 */
import { describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Executor } from "../src/db/cliente.js";
import { agora_utc } from "../src/db/esquema/base.js";
import * as repo from "../src/repositorios/processos.js";
import { CHAVES_AGRUPAMENTO, agrupar } from "../src/servicos/processo.js";
import { bancoLimpo, contas, entrar } from "./ajuda";
import { atores, cenario } from "./ajuda_processos";

await bancoLimpo();

async function processo(db: Executor, nup: string, campos: Partial<typeof e.processo.$inferInsert> = {}) {
  const [tipo] = await db.select().from(e.tipo_processo).orderBy(asc(e.tipo_processo.id)).limit(1);
  const [etapa] = await db.select().from(e.fluxo_etapa).where(eq(e.fluxo_etapa.codigo, "A_FAZER"));
  const [p] = await db
    .insert(e.processo)
    .values({ nup, tipo_processo_id: tipo!.id, etapa_id: etapa!.id, ...campos })
    .returning();
  return p!;
}

const dias = (n: number) => new Date(agora_utc().getTime() - n * 86_400_000);

describe("visões salvas", () => {
  it("parados há mais de 90 dias", async () => {
    const { db } = await bancoLimpo();
    const { COORDENADOR } = await atores(db);
    const antigo = await processo(db, "23086.000608/2026-84", { entrou_na_etapa_em: dias(120) });
    await processo(db, "23086.000540/2026-33", { entrou_na_etapa_em: dias(3) });
    const [itens, total] = await repo.listar(db, COORDENADOR, new repo.Filtro({ dias_parado: 90 }));
    expect(total).toBe(1);
    expect(itens[0]!.id).toBe(antigo.id);
  });

  it("sem número SEI", async () => {
    const { db } = await bancoLimpo();
    const { COORDENADOR } = await atores(db);
    await processo(db, "23086.000608/2026-84", { url_permanente: "https://sei/x" });
    const sem = await processo(db, "23086.000540/2026-33");
    const [itens, total] = await repo.listar(db, COORDENADOR, new repo.Filtro({ sem_numero_sei: true }));
    expect(total).toBe(1);
    expect(itens[0]!.id).toBe(sem.id);
  });

  it("sem percentual", async () => {
    const { db } = await bancoLimpo();
    const { COORDENADOR } = await atores(db);
    const c = await cenario(db);
    const sem_parecer = await processo(db, "23086.000608/2026-84");
    const [itens] = await repo.listar(db, COORDENADOR, new repo.Filtro({ sem_percentual: true }));
    const ids = itens.map((p) => p.id);
    expect(ids).toContain(sem_parecer.id);
    expect(ids).not.toContain(c.processo_id);
  });

  it("reavaliação pendente — químicos", async () => {
    const { db } = await bancoLimpo();
    const { COORDENADOR } = await atores(db);
    const c = await cenario(db);
    let [itens] = await repo.listar(db, COORDENADOR, new repo.Filtro({ reavaliacao_pendente: true }));
    expect(itens).toEqual([]); // o cenário é biológico
    const [quimico] = await db
      .select()
      .from(e.agente_nocivo)
      .where(eq(e.agente_nocivo.descricao, "Manipulação de produtos químicos"));
    await db
      .update(e.exposicao)
      .set({ agente_nocivo_id: quimico!.id, fundamentacao_id: quimico!.fundamentacao_id! })
      .where(eq(e.exposicao.parecer_id, c.parecer_id));
    let total: number;
    [itens, total] = await repo.listar(db, COORDENADOR, new repo.Filtro({ reavaliacao_pendente: true }));
    expect(total).toBe(1);
    expect(itens[0]!.id).toBe(c.processo_id);
  });

  it("sem parecer assinado anexado", async () => {
    const { db } = await bancoLimpo();
    const { COORDENADOR } = await atores(db);
    const c = await cenario(db);
    let [itens, total] = await repo.listar(db, COORDENADOR, new repo.Filtro({ sem_parecer_assinado: true }));
    expect(total).toBe(1);
    expect(itens[0]!.id).toBe(c.processo_id);
    await db.insert(e.anexo).values({
      entidade: "parecer_tecnico",
      entidade_id: c.parecer_id,
      nome_arquivo: "p.pdf",
      nome_original: "p.pdf",
      mime_type: "application/pdf",
      tamanho_bytes: 3,
      sha256: "a".repeat(64),
      storage_key: "aa/" + "a".repeat(64),
      categoria: "PARECER_ASSINADO",
    });
    [itens, total] = await repo.listar(db, COORDENADOR, new repo.Filtro({ sem_parecer_assinado: true }));
    expect(total).toBe(0);
  });

  it("pós-filtro pagina com o total correto", async () => {
    const { db } = await bancoLimpo();
    const { COORDENADOR } = await atores(db);
    for (let i = 0; i < 7; i++) await processo(db, `23086.00060${i}/2026-84`, { entrou_na_etapa_em: dias(200) });
    const filtro = new repo.Filtro({ dias_parado: 90, por_pagina: 3 });
    const [pagina1, total] = await repo.listar(db, COORDENADOR, filtro);
    expect(total).toBe(7);
    expect(pagina1.length).toBe(3);
    filtro.pagina = 3;
    const [pagina3] = await repo.listar(db, COORDENADOR, filtro);
    expect(pagina3.length).toBe(1);
  });

  it("query string carrega as visões", () => {
    const qs = new repo.Filtro({
      dias_parado: 90,
      sem_percentual: true,
      reavaliacao_pendente: true,
      agrupar: "unidade",
    }).como_query_string();
    for (const s of ["dias=90", "sem_percentual=1", "reavaliacao_pendente=1", "agrupar=unidade"]) expect(qs).toContain(s);
  });
});

describe("agrupamento", () => {
  it("agrupa pelo estado técnico (rótulo de tela) e pela unidade", async () => {
    const { db } = await bancoLimpo();
    const { COORDENADOR } = await atores(db);
    await cenario(db);
    await processo(db, "23086.000608/2026-84");
    const [itens] = await repo.listar(db, COORDENADOR, new repo.Filtro());
    const grupos = agrupar(itens, "estado");
    expect(new Set(grupos.keys())).toEqual(new Set(["Recebido", "Parecer em elaboração"]));
    const por_unidade = agrupar(itens, "unidade");
    expect(por_unidade.has("(sem unidade)")).toBe(true);
    expect(por_unidade.has("Faculdade de Medicina de Diamantina")).toBe(true);
    expect(new Set(Object.keys(CHAVES_AGRUPAMENTO))).toEqual(new Set(["estado", "unidade", "responsavel", "tipo"]));
  });
});

describe("ações em lote pela tela", () => {
  it("move o que pode e relata o que não", async () => {
    const { db, novoCliente } = await bancoLimpo();
    await contas(db);
    const pode = await processo(db, "23086.000608/2026-84", { estado_tecnico: "RECEBIDO" });
    const nao_pode = await processo(db, "23086.000540/2026-33", {
      estado_tecnico: "CONCLUIDO",
      situacao: "CONCLUIDO",
      data_conclusao: "2026-01-01",
    });
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const r = await cliente.post("/processos/lote", {
      processo_id: [pode.id, nao_pode.id],
      acao: "estado",
      destino: "EM_TRIAGEM",
    });
    expect(r.status).toBe(200);
    expect(r.text).toContain("1 processo(s) atualizado");
    expect(r.text).toContain("não passaram");
    const estado = async (id: number) =>
      (await db.select().from(e.processo).where(eq(e.processo.id, id)))[0]!.estado_tecnico;
    expect(await estado(pode.id)).toBe("EM_TRIAGEM");
    expect(await estado(nao_pode.id)).toBe("CONCLUIDO");
  });

  it("define prazo", async () => {
    const { db, novoCliente } = await bancoLimpo();
    await contas(db);
    const p = await processo(db, "23086.000608/2026-84");
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    await cliente.post("/processos/lote", { processo_id: String(p.id), acao: "prazo", prazo: "2026-12-31" }, { seguir: false });
    expect((await db.select().from(e.processo).where(eq(e.processo.id, p.id)))[0]!.prazo).toBe("2026-12-31");
  });

  it("sem permissão de atribuir: relata e não grava", async () => {
    const { db, novoCliente } = await bancoLimpo();
    await contas(db);
    const p = await processo(db, "23086.000608/2026-84");
    const cliente = await entrar(novoCliente(), "tecnico_seguranca"); // não tem processo.atribuir
    const r = await cliente.post("/processos/lote", { processo_id: String(p.id), acao: "responsavel", responsavel_id: "1" });
    expect(r.text).toContain("não passaram");
    expect((await db.select().from(e.processo).where(eq(e.processo.id, p.id)))[0]!.responsavel_id).toBeNull();
  });
});

describe("tela de /processos", () => {
  it("mostra as oito visões, agrupa e o cartão de filtros encolhe sem esconder", async () => {
    const { db, novoCliente } = await bancoLimpo();
    await contas(db);
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    let corpo = (await cliente.get("/processos")).text;
    for (const nome of [
      "Minha fila",
      "Atrasados",
      "Parados há mais de 90 dias",
      "Sem nº SEI",
      "Sem percentual",
      "Reavaliação pendente",
      "Campus Avançados",
      "Sem parecer assinado anexado",
    ]) {
      expect(corpo).toContain(nome);
    }
    expect((await cliente.get("/processos?agrupar=unidade")).status).toBe(200);
    expect((await cliente.get("/processos?agrupar=nao_existe")).status).toBe(200);

    // nasce fechado e diz quantos controles tem
    let gaveta = /<details class="cartao filtros"[^>]*>/.exec(corpo);
    expect(gaveta).not.toBeNull();
    expect(gaveta![0]).not.toContain(" open");
    expect(corpo).toContain("seis controles");

    // filtro aplicado abre a gaveta e sai escrito no resumo
    corpo = (await cliente.get("/processos?estado=RECEBIDO&q=23086")).text;
    gaveta = /<details class="cartao filtros"[^>]*>/.exec(corpo);
    expect(gaveta![0]).toContain(" open");
    const fim = gaveta!.index + gaveta![0].length;
    const resumo = corpo.slice(fim, corpo.indexOf("</summary>", fim));
    expect(resumo).toContain("2 aplicado(s)");
    expect(resumo).toContain("23086");

    // visão salva não abre a gaveta dos seis controles
    corpo = (await cliente.get("/processos?atrasados=1")).text;
    gaveta = /<details class="cartao filtros"[^>]*>/.exec(corpo);
    expect(gaveta![0]).not.toContain(" open");
  });
});
