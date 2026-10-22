/**
 * Fatia E da paridade de EPI com o IntegraSST: `exige_treinamento` passa a
 * valer, ligado ao catálogo de treinamentos de Certificados.
 *
 * O que protegem: o vínculo item × treinamento só com `epi.catalogo`, com
 * trilha; a situação "em vigor / sem treinamento" pela validade do certificado;
 * a etiqueta na análise e na entrega; a Decisão 2 (avisa, não bloqueia — sem a
 * confirmação marcada a entrega volta, com ela grava evento e congelado); e que
 * a equipe de EPI nunca vê o certificado (número, chave, data, turma).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import { somar_dias } from "../src/dominio/datas.js";
import * as datas_br from "../src/servicos/datas_br.js";
import * as servico_certificado from "../src/servicos/certificado.js";
import * as servico_participante from "../src/servicos/participante.js";
import * as req from "../src/servicos/epi_requisicao.js";
import * as treino from "../src/servicos/epi_treinamento.js";
import { bancoLimpo, contas, entrar, type Cliente } from "./ajuda";
import { bancoPorTeste, cenario as montar, entregar, recado, registros, HOJE, type Cenario } from "./ajuda_epi_ficha";
import * as ajuda_req from "./ajuda_epi_requisicao";

let db: Banco;
let novoCliente: () => Cliente;

await bancoLimpo();

beforeEach(async () => {
  const amb = await bancoPorTeste();
  db = amb.db;
  novoCliente = () => amb.novoCliente();
  await contas(db);
});

async function como(perfil: string): Promise<Cliente> {
  return entrar(novoCliente(), perfil);
}

// =====================================================================
// Montagem: treinamento, certificado (direto no banco) e vínculo
// =====================================================================
let sequencia = 0;

async function treinamento(codigo = "NR-35", validade_meses = 24) {
  const [t] = await db
    .insert(e.treinamento)
    .values({ codigo, nome: `Treinamento ${codigo}`, carga_horaria_horas: "8", validade_meses })
    .returning();
  return t!;
}

/** Um certificado emitido em `emissao`; o vencimento sai da validade do treinamento. */
async function certificado(
  servidor_id: number,
  t: typeof e.treinamento.$inferSelect,
  emissao: string,
  o: { situacao?: "EMITIDO" | "ANULADO"; numero?: number } = {},
) {
  sequencia += 1;
  const ano = Number(emissao.slice(0, 4));
  const [sv] = await db.select().from(e.servidor).where(eq(e.servidor.id, servidor_id));
  const pessoa = await servico_participante.de_servidor(db, sv!);
  const [turma] = await db
    .insert(e.turma)
    .values({
      treinamento_id: t.id,
      numero: sequencia,
      ano,
      codigo: `TUR-${ano}-77${String(sequencia).padStart(2, "0")}`,
      data_inicio: emissao,
      data_fim: emissao,
    })
    .returning();
  const [inscricao] = await db.insert(e.inscricao).values({ turma_id: turma!.id, participante_id: pessoa.id }).returning();
  const vencimento = t.validade_meses ? datas_br.somar_meses(emissao, t.validade_meses) : null;
  const [c] = await db
    .insert(e.certificado)
    .values({
      inscricao_id: inscricao!.id,
      numero: o.numero ?? 8800 + sequencia,
      ano,
      chave_validacao: servico_certificado.gerar_chave(ano),
      situacao: o.situacao ?? "EMITIDO",
      motivo_anulacao: o.situacao === "ANULADO" ? "teste" : null,
      data_emissao: emissao,
      data_base_vencimento: emissao,
      data_vencimento: vencimento,
      validade_meses_congelada: t.validade_meses,
      contexto_congelado: { turma_codigo: turma!.codigo, nota: "9,7" },
      modelo_arquivo: "certificado_padrao_v1.docx",
      servidor_id,
      treinamento_id: t.id,
      participante_id: pessoa.id,
    })
    .returning();
  return { certificado: c!, turma: turma! };
}

async function vincular(item_id: number, treinamento_id: number) {
  await db.insert(e.epi_item_treinamento).values({ epi_item_id: item_id, treinamento_id });
  await db.update(e.epi_item).set({ exige_treinamento: true }).where(eq(e.epi_item.id, item_id));
}

async function eventos(tipo: string) {
  return db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, tipo)).orderBy(asc(e.historico_evento.id));
}

async function item(id: number) {
  const [i] = await db.select().from(e.epi_item).where(eq(e.epi_item.id, id));
  return i!;
}

// =====================================================================
// 1. A situação de quem recebe
// =====================================================================
describe("situação de treinamento", () => {
  it("item sem exigência não pede nada", async () => {
    const c = await montar(db);
    const s = await treino.situacao_de_treinamento(db, c.servidor, c.item, HOJE);
    expect(s.codigo).toBe("SEM_EXIGENCIA");
    expect(s.pede_confirmacao).toBe(false);
  });

  it("exige sem treinamento vinculado: SEM_VINCULO, sem pedir confirmação", async () => {
    const c = await montar(db);
    await db.update(e.epi_item).set({ exige_treinamento: true }).where(eq(e.epi_item.id, c.item));
    const s = await treino.situacao_de_treinamento(db, c.servidor, c.item, HOJE);
    expect(s.codigo).toBe("SEM_VINCULO");
    expect(s.pede_confirmacao).toBe(false);
  });

  it("certificado válido = em vigor; vencido pela validade_meses ou inexistente = sem", async () => {
    const c = await montar(db);
    const t = await treinamento("NR-35", 24);
    await vincular(c.item, t.id);
    // inexistente
    expect((await treino.situacao_de_treinamento(db, c.servidor, c.item, HOJE)).codigo).toBe("SEM_TREINAMENTO");
    // vencido: emitido há 30 meses, validade 24
    await certificado(c.servidor, t, somar_dias(HOJE, -900));
    const vencido = await treino.situacao_de_treinamento(db, c.servidor, c.item, HOJE);
    expect(vencido.codigo).toBe("SEM_TREINAMENTO");
    expect(vencido.pede_confirmacao).toBe(true);
    expect(vencido.faltam.map((x) => x.id)).toEqual([t.id]);
    // na data em que ainda valia, valia
    expect((await treino.situacao_de_treinamento(db, c.servidor, c.item, somar_dias(HOJE, -800))).codigo).toBe("EM_VIGOR");
    // a reciclagem: emitido há 10 dias
    await certificado(c.servidor, t, somar_dias(HOJE, -10));
    expect((await treino.situacao_de_treinamento(db, c.servidor, c.item, HOJE)).codigo).toBe("EM_VIGOR");
  });

  it("o vencimento no próprio dia ainda vale; o anulado nunca valeu", async () => {
    const c = await montar(db);
    const t = await treinamento("NR-10", 12);
    await vincular(c.item, t.id);
    const { certificado: cert } = await certificado(c.servidor, t, somar_dias(HOJE, -100));
    expect((await treino.situacao_de_treinamento(db, c.servidor, c.item, cert.data_vencimento!)).codigo).toBe("EM_VIGOR");
    expect((await treino.situacao_de_treinamento(db, c.servidor, c.item, somar_dias(cert.data_vencimento!, 1))).codigo).toBe(
      "SEM_TREINAMENTO",
    );
    const [sv] = await db.insert(e.servidor).values({ siape: "7650001", nome: "Pessoa Anulada" }).returning();
    await certificado(sv!.id, t, somar_dias(HOJE, -10), { situacao: "ANULADO" });
    expect((await treino.situacao_de_treinamento(db, sv!.id, c.item, HOJE)).codigo).toBe("SEM_TREINAMENTO");
  });

  it("treinamento que não expira vale para sempre", async () => {
    const c = await montar(db);
    const t = await treinamento("BRIG", 0);
    await vincular(c.item, t.id);
    await certificado(c.servidor, t, "2015-05-05");
    expect((await treino.situacao_de_treinamento(db, c.servidor, c.item, HOJE)).codigo).toBe("EM_VIGOR");
  });

  it("dois treinamentos vinculados: todos são exigidos, e diz qual falta", async () => {
    const c = await montar(db);
    const a = await treinamento("NR-35", 24);
    const b = await treinamento("NR-33", 12);
    await vincular(c.item, a.id);
    await vincular(c.item, b.id);
    await certificado(c.servidor, a, somar_dias(HOJE, -30));
    const s = await treino.situacao_de_treinamento(db, c.servidor, c.item, HOJE);
    expect(s.codigo).toBe("SEM_TREINAMENTO");
    expect(s.faltam.map((x) => x.nome)).toEqual(["Treinamento NR-33"]);
  });

  it("a lista sai com uma consulta por lote, e sem consulta quando nada exige", async () => {
    const c = await montar(db);
    const i = await item(c.item);
    const mapa = await treino.situacoes_de_treinamento(
      db,
      Array.from({ length: 30 }, (_x, n) => ({ servidor_id: c.servidor + n, item: i })),
      HOJE,
    );
    expect(mapa.size).toBe(30);
    expect([...mapa.values()].every((s) => s.codigo === "SEM_EXIGENCIA")).toBe(true);
  });
});

// =====================================================================
// 2. O catálogo: vincular e desvincular
// =====================================================================
describe("catálogo", () => {
  it("vincula e desvincula com epi.catalogo, com trilha, e marca exige_treinamento", async () => {
    const c = await montar(db);
    const t = await treinamento("NR-35", 24);
    const cli = await como("tecnico_seguranca");
    const r = await cli.post(`/epis/catalogo/${c.item}/treinamentos`, { acao: "vincular", treinamento_id: t.id }, { seguir: false });
    expect(r.status).toBe(303);
    expect(recado(r)).toContain("passa a exigir");
    expect(r.location).toContain(`treinamentos=${c.item}`);
    expect((await item(c.item)).exige_treinamento).toBe(true);
    const vinculos = await db.select().from(e.epi_item_treinamento);
    expect(vinculos).toHaveLength(1);
    expect(vinculos[0]!.vinculado_por).not.toBeNull();
    const [ev] = await eventos(treino.EPI_ITEM_TREINAMENTO_VINCULADO);
    expect(ev).toMatchObject({ entidade: "epi_item", entidade_id: c.item });
    expect(ev!.descricao).toContain("NR-35");

    // a tela reabre o popup dos treinamentos com o vinculado e o desvincular
    const tela = await cli.get(r.location!);
    expect(tela.text).toContain(`id="trein-epi-${c.item}"`);
    expect(tela.text).toContain("Treinamento NR-35");
    expect(tela.text).toContain("Desvincular");

    const d = await cli.post(`/epis/catalogo/${c.item}/treinamentos`, { acao: "desvincular", treinamento_id: t.id }, { seguir: false });
    expect(d.status).toBe(303);
    expect(await db.select().from(e.epi_item_treinamento)).toHaveLength(0);
    expect(await eventos(treino.EPI_ITEM_TREINAMENTO_DESVINCULADO)).toHaveLength(1);
    // o último a sair não desmarca a exigência: o catálogo avisa
    expect((await item(c.item)).exige_treinamento).toBe(true);
    const lista = await cli.get("/epis/catalogo");
    expect(lista.text.replace(/\s+/g, " ")).toContain("nenhum está vinculado — não dá para conferir");
    expect(lista.text).toContain("nenhum treinamento vinculado");
  });

  it("vincular o mesmo duas vezes é recusado sem evento novo", async () => {
    const c = await montar(db);
    const t = await treinamento();
    const cli = await como("coordenador_csso");
    await cli.post(`/epis/catalogo/${c.item}/treinamentos`, { acao: "vincular", treinamento_id: t.id }, { seguir: false });
    const r = await cli.post(`/epis/catalogo/${c.item}/treinamentos`, { acao: "vincular", treinamento_id: t.id }, { seguir: false });
    expect(recado(r)).toContain("já está vinculado");
    expect(await eventos(treino.EPI_ITEM_TREINAMENTO_VINCULADO)).toHaveLength(1);
  });

  it("sem epi.catalogo: 403 e nada gravado; a lista não oferece o botão", async () => {
    const c = await montar(db);
    const t = await treinamento();
    const cli = await como("medico_trabalho");
    const r = await cli.post(`/epis/catalogo/${c.item}/treinamentos`, { acao: "vincular", treinamento_id: t.id }, { seguir: false });
    expect(r.status).toBe(403);
    expect(await db.select().from(e.epi_item_treinamento)).toHaveLength(0);
    expect((await item(c.item)).exige_treinamento).toBe(false);
    await vincular(c.item, t.id);
    const d = await cli.post(`/epis/catalogo/${c.item}/treinamentos`, { acao: "desvincular", treinamento_id: t.id }, { seguir: false });
    expect(d.status).toBe(403);
    expect(await db.select().from(e.epi_item_treinamento)).toHaveLength(1);
    const lista = await cli.get("/epis/catalogo");
    expect(lista.status).toBe(200);
    expect(lista.text).not.toContain(`id="trein-epi-${c.item}"`);
    // quem lê vê qual treinamento o item exige
    expect(lista.text).toContain("Treinamento NR-35");
  });
});

// =====================================================================
// 3. A entrega de balcão
// =====================================================================
describe("entrega de balcão", () => {
  async function com_exigencia(c: Cenario) {
    const t = await treinamento("NR-35", 24);
    await vincular(c.item, t.id);
    return t;
  }

  it("item sem exigência não pede nada: entrega direto, sem a caixa", async () => {
    const c = await montar(db);
    const cli = await como("tecnico_seguranca");
    const frag = await cli.get(`/epis/entregas/opcoes?item_id=${c.item}&servidor_id=${c.servidor}`);
    expect(frag.text).not.toContain("Entrego mesmo sem treinamento em vigor");
    expect(frag.text).not.toContain("sem treinamento em vigor");
    const r = await entregar(cli, c);
    expect(r.status).toBe(303);
    const [linha] = await registros(db);
    expect((linha!.contexto_congelado as Record<string, unknown>)[treino.CHAVE_CONGELADO]).toBeUndefined();
    expect(await eventos(treino.EPI_SEM_TREINAMENTO_CONFIRMADO)).toHaveLength(0);
  });

  it("a etiqueta aparece no bloco do item, com a caixa de confirmação", async () => {
    const c = await montar(db);
    await com_exigencia(c);
    const cli = await como("tecnico_seguranca");
    const frag = await cli.get(`/epis/entregas/opcoes?item_id=${c.item}&servidor_id=${c.servidor}`);
    expect(frag.text).toContain("sem treinamento em vigor");
    expect(frag.text).toContain('name="confirmar_sem_treinamento"');
    expect(frag.text).toContain("Entrego mesmo sem treinamento em vigor");
    // sem o servidor, só o aviso de que a conferência vem no envio
    const sem = await cli.get(`/epis/entregas/opcoes?item_id=${c.item}`);
    expect(sem.text).toContain("Este item exige treinamento.");
    expect(sem.text).not.toContain('name="confirmar_sem_treinamento"');
  });

  it("sem a confirmação a entrega volta com o aviso e nada é gravado", async () => {
    const c = await montar(db);
    await com_exigencia(c);
    const cli = await como("tecnico_seguranca");
    const r = await entregar(cli, c);
    expect(r.status).toBe(200);
    expect(r.text).toContain("não tem certificado em vigor");
    expect(r.text).toContain("Entrego mesmo sem treinamento em vigor");
    expect(r.text).toContain('name="confirmar_sem_treinamento"');
    expect(await registros(db)).toHaveLength(0);
    expect(await eventos(treino.EPI_SEM_TREINAMENTO_CONFIRMADO)).toHaveLength(0);
  });

  it("com a confirmação grava o evento (servidor por #id) e o contexto congelado", async () => {
    const c = await montar(db);
    const t = await com_exigencia(c);
    const cli = await como("tecnico_seguranca");
    const r = await entregar(cli, c, { confirmar_sem_treinamento: "1" });
    expect(r.status).toBe(303);
    const [linha] = await registros(db);
    const congelado = (linha!.contexto_congelado as Record<string, unknown>)[treino.CHAVE_CONGELADO] as Record<string, unknown>;
    expect(congelado).toMatchObject({ treinamento_ids: [t.id], treinamentos: ["Treinamento NR-35"] });
    expect(congelado.confirmado_por).toEqual(expect.any(Number));
    const [ev] = await eventos(treino.EPI_SEM_TREINAMENTO_CONFIRMADO);
    expect(ev).toMatchObject({ entidade: "epi_ficha_registro", entidade_id: linha!.id });
    expect(ev!.descricao).toContain(`servidor #${c.servidor}`);
    expect(ev!.descricao).not.toContain("Joana");
    expect(ev!.descricao).not.toContain("7654321");
    // a devolução não herda a confirmação: ela é do ato da entrega
    const dev = await cli.post(
      `/epis/fichas/registros/${linha!.id}/devolucao`,
      { quantidade: "1", motivo: "troca de tamanho", motivo_codigo: "OUTRO", data_evento: HOJE },
      { seguir: false },
    );
    expect(dev.status).toBe(303);
    const devolucao = (await registros(db)).find((x) => x.tipo === "DEVOLUCAO");
    expect(devolucao, recado(dev)).toBeTruthy();
    expect((devolucao!.contexto_congelado as Record<string, unknown>)[treino.CHAVE_CONGELADO]).toBeUndefined();
  });

  it("com certificado em vigor entrega sem pedir nada — e a tela não mostra o certificado", async () => {
    const c = await montar(db);
    const t = await com_exigencia(c);
    const { certificado: cert, turma } = await certificado(c.servidor, t, somar_dias(HOJE, -45), { numero: 4321 });
    const cli = await como("tecnico_seguranca");
    const frag = await cli.get(`/epis/entregas/opcoes?item_id=${c.item}&servidor_id=${c.servidor}`);
    expect(frag.text).toContain("treinamento em vigor");
    expect(frag.text).not.toContain('name="confirmar_sem_treinamento"');
    for (const dado of [cert.chave_validacao, "4321", turma.codigo, datas_br.numerica(cert.data_emissao), datas_br.numerica(cert.data_vencimento!), "9,7"]) {
      expect(frag.text, dado).not.toContain(dado);
    }
    const r = await entregar(cli, c);
    expect(r.status).toBe(303);
    expect(await eventos(treino.EPI_SEM_TREINAMENTO_CONFIRMADO)).toHaveLength(0);
  });

  it("exige sem vínculo: avisa e entrega sem a caixa", async () => {
    const c = await montar(db);
    await db.update(e.epi_item).set({ exige_treinamento: true }).where(eq(e.epi_item.id, c.item));
    const cli = await como("tecnico_seguranca");
    const frag = await cli.get(`/epis/entregas/opcoes?item_id=${c.item}&servidor_id=${c.servidor}`);
    expect(frag.text).toContain("o catálogo não diz qual");
    expect(frag.text).not.toContain('name="confirmar_sem_treinamento"');
    expect((await entregar(cli, c)).status).toBe(303);
  });
});

// =====================================================================
// 4. O pedido: análise e entrega
// =====================================================================
describe("pedido", () => {
  async function pedido_analisado(exigir = true) {
    const cen = await ajuda_req.cenario(db);
    const t = await treinamento("NR-35", 24);
    if (exigir) await vincular(cen.item.id, t.id);
    const item_atual = await item(cen.item.id);
    const u = await ajuda_req.usuario(db, { login: "analista_e" });
    const requisicao = await ajuda_req.pedido_pronto(db, { ...cen, item: item_atual }, u);
    await req.enviar(db, u, requisicao, { termo_aceito: true });
    return { cen, t, u, requisicao };
  }

  it("a análise mostra a etiqueta “sem treinamento em vigor”, sem dado de certificado", async () => {
    const { requisicao, cen, t } = await pedido_analisado();
    const cli = await como("coordenador_csso");
    const tela = await cli.get(`/epis/requisicoes/${requisicao.id}`);
    expect(tela.status).toBe(200);
    expect(tela.text).toContain("sem treinamento em vigor");
    expect(tela.text).toContain("falta: Treinamento NR-35");
    // com o certificado, a etiqueta muda — e o certificado não aparece
    const { certificado: cert, turma } = await certificado(cen.servidor.id, t, somar_dias(HOJE, -20), { numero: 5432 });
    const depois = await cli.get(`/epis/requisicoes/${requisicao.id}`);
    expect(depois.text).toContain("treinamento em vigor");
    expect(depois.text).not.toContain("sem treinamento em vigor");
    for (const dado of [cert.chave_validacao, turma.codigo, datas_br.numerica(cert.data_emissao), datas_br.numerica(cert.data_vencimento!), "9,7"]) {
      expect(depois.text, dado).not.toContain(dado);
    }
  });

  it("o requerente não vê a etiqueta", async () => {
    const { requisicao, cen } = await pedido_analisado();
    // a conta de consulta vira a titular do pedido
    await db.update(e.usuario).set({ servidor_id: cen.servidor.id }).where(eq(e.usuario.login, "servidor_consulta"));
    const cli = await como("servidor_consulta");
    const tela = await cli.get(`/epis/requisicoes/${requisicao.id}`);
    expect(tela.status).toBe(200);
    expect(tela.text).not.toContain("sem treinamento em vigor");
  });

  it("entrega pelo pedido: sem a confirmação volta; com ela grava evento e congelado", async () => {
    const { requisicao, u } = await pedido_analisado();
    const coord = await ajuda_req.usuario(db, { login: "analista_f" });
    const recarregada = (await ajuda_req.reler(db, requisicao))!;
    await req.iniciar_analise(db, coord, recarregada);
    const [linha] = await ajuda_req.itens(db, requisicao);
    await req.aprovar_item(db, coord, linha!);
    await req.concluir_analise(db, coord, (await ajuda_req.reler(db, requisicao))!);
    expect(u).toBeTruthy();

    const cli = await como("coordenador_csso");
    const tela = await cli.get(`/epis/requisicoes/${requisicao.id}`);
    expect(tela.text).toContain(`id="sem-trein-${linha!.id}"`);
    const url = `/epis/requisicoes/${requisicao.id}/itens/${linha!.id}/entregar`;
    const r = await cli.post(url, { quantidade: "2", observacao: "" }, { seguir: false });
    expect(r.status).toBe(303);
    expect(recado(r)).toContain("Entrego mesmo sem treinamento em vigor");
    expect(await registros(db)).toHaveLength(0);
    expect((await ajuda_req.reler_linha(db, linha!))!.estado).toBe("APROVADO");

    const ok = await cli.post(url, { quantidade: "2", observacao: "", confirmar_sem_treinamento: "1" }, { seguir: false });
    expect(ok.status).toBe(303);
    expect(recado(ok)).toContain("Entrega registrada");
    const [registro] = await registros(db);
    expect(registro!.requisicao_item_id).toBe(linha!.id);
    expect((registro!.contexto_congelado as Record<string, unknown>)[treino.CHAVE_CONGELADO]).toBeTruthy();
    const evs = await db
      .select()
      .from(e.historico_evento)
      .where(and(eq(e.historico_evento.tipo_evento, treino.EPI_SEM_TREINAMENTO_CONFIRMADO), eq(e.historico_evento.entidade_id, registro!.id)));
    expect(evs).toHaveLength(1);
  });

  it("a recusa pelo motivo SEM_TREINAMENTO continua disponível", async () => {
    const m = await ajuda_req.motivo(db, treino.MOTIVO_RECUSA_SEM_TREINAMENTO);
    expect(m).toBeTruthy();
    expect(m.ativo).toBe(true);
  });
});

// =====================================================================
// 5. A miniatura do catálogo na tela de pedido (pedida pela fatia C)
// =====================================================================
describe("miniatura no pedido", () => {
  it("o bloco do item no pedido mostra a foto e o PDF do catálogo", async () => {
    const c = await montar(db);
    const tec = await como("tecnico_seguranca");
    const png = new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode("imagem")])],
      "foto.png",
      { type: "image/png" },
    );
    const pdf = new File([new TextEncoder().encode("%PDF-1.4 orientacao")], "o.pdf", { type: "application/pdf" });
    // um arquivo por envio (fatia C: nenhum corpo passa dos 6 MB do Netlify)
    const env = await tec.post(`/epis/catalogo/${c.item}/imagem`, { imagem: png }, { seguir: false, multipart: true });
    expect(env.status).toBe(303);
    const env2 = await tec.post(`/epis/catalogo/${c.item}/orientacao`, { orientacao: pdf }, { seguir: false, multipart: true });
    expect(env2.status).toBe(303);
    const i = await item(c.item);
    expect(i.imagem_anexo_id).not.toBeNull();
    const cli = await como("coordenador_csso");
    const frag = await cli.get(`/epis/requisicoes/item-opcoes?item_id=${c.item}`);
    expect(frag.status).toBe(200);
    expect(frag.text).toContain('class="epi-miniatura grande"');
    expect(frag.text).toContain(`/epis/catalogo/${c.item}/imagem?v=${i.imagem_anexo_id}`);
    expect(frag.text).toContain(`/epis/catalogo/${c.item}/orientacao?v=${i.orientacao_anexo_id}`);
  });
});
