/**
 * NUVEM: a REGRA DE DONO de treinamento e turma (`servicos/dono_turma.ts`,
 * 23/10/2026).
 *
 * Só o dono (a conta que criou) altera; acima dele, o superintendente (tudo) e
 * a coordenação do PRÓPRIO setor promotor (quando o dono é de perfil abaixo).
 * Entre coordenadores, só o dono. Os outros só consultam — a não ser que o
 * dono os designe ajudantes, e aí só nos papéis dados. A turma antiga sem dono
 * só a hierarquia superior altera. As permissões continuam necessárias: a
 * regra é uma camada a mais.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { and, count, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import { somar_dias } from "../src/dominio/datas.js";
import * as auditoria from "../src/servicos/auditoria.js";
import * as datas_br from "../src/servicos/datas_br.js";
import * as dono_turma from "../src/servicos/dono_turma.js";
import * as servico_emissao from "../src/servicos/emissao_certificado.js";
import * as inscricao_publica from "../src/servicos/inscricao_publica.js";
import * as servico_participante from "../src/servicos/participante.js";
import * as servico_presenca from "../src/servicos/presenca.js";
import {
  NIVEL_ADMINISTRACAO_SISTEMA,
  NIVEL_COORDENACAO,
  NIVEL_DEMAIS,
  NIVEL_SUPERINTENDENCIA,
  ORDEM_HIERARQUICA,
  nivel_hierarquico,
  type UsuarioAtual } from "../src/servicos/rbac.js";
import * as servico_turma from "../src/servicos/turma.js";
import { bancoLimpo, contas, criarUsuario, entrar, usuarioAtual, type Cliente } from "./ajuda";
import { INICIO, _modelo_com_tags } from "./ajuda_certificado";

let db: Banco;
let novoCliente: () => Cliente;

let csso_id: number;
let cpel_id: number;
let treinamento: typeof e.treinamento.$inferSelect;
let instrutor: typeof e.assinatura_instrutor.$inferSelect;
let servidor_a: typeof e.servidor.$inferSelect;
let servidor_b: typeof e.servidor.$inferSelect;

/** A turma do coordenador A, concluída, com um aprovado e o certificado emitido. */
let tA: { turma: servico_turma.TurmaCarregada; inscricao_id: number; certificado_id: number };
/** A turma aberta por um técnico da CSSO, em andamento, com um inscrito. */
let tT: { turma: servico_turma.TurmaCarregada; inscricao_id: number };

const HOJE = datas_br.hoje();
const AVISO_A = "Esta turma é de Coordenador de Teste; só ele ou a coordenação acima pode alterar.";

async function _cliente(login: string): Promise<Cliente> {
  return entrar(novoCliente(), login);
}

async function _turma(
  quem: UsuarioAtual,
  d: { unidade_promotora_id?: number | null; data_inicio?: string; data_fim?: string } = {},
): Promise<servico_turma.TurmaCarregada> {
  const turma = await servico_turma.criar_turma(db, quem, {
    treinamento,
    data_inicio: d.data_inicio ?? INICIO,
    data_fim: d.data_fim ?? INICIO,
    local: "Auditório",
    unidade_promotora_id: d.unidade_promotora_id === undefined ? csso_id : d.unidade_promotora_id,
  });
  await servico_turma.vincular_instrutor(db, quem, turma, { ...instrutor, servidor: null });
  return (await servico_turma.carregar_turma(db, turma.id))!;
}

/** Quanto foi gravado: a trilha e as tabelas que os atos da turma tocam. */
async function _fotografia(turma_id: number) {
  const [[hist], [insc], [pres], [cert], [ajud], [t]] = await Promise.all([
    db.select({ n: count() }).from(e.historico_evento),
    db.select({ n: count() }).from(e.inscricao).where(eq(e.inscricao.turma_id, turma_id)),
    db.select({ n: count() }).from(e.turma_presenca),
    db.select({ n: count() }).from(e.certificado),
    db.select({ n: count() }).from(e.turma_ajudante),
    db.select().from(e.turma).where(eq(e.turma.id, turma_id)),
  ]);
  return {
    hist: Number(hist!.n),
    insc: Number(insc!.n),
    pres: Number(pres!.n),
    cert: Number(cert!.n),
    ajud: Number(ajud!.n),
    turma: { local: t!.local, situacao: t!.situacao, inscricao_publica: t!.inscricao_publica },
  };
}

async function _id_conta(login: string): Promise<number> {
  const [u] = await db.select({ id: e.usuario.id }).from(e.usuario).where(eq(e.usuario.login, login));
  return u!.id;
}

const EDICAO = { data_inicio: INICIO, data_fim: INICIO, local: "Sala nova", frequencia_minima_percentual: "75" };

beforeAll(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  novoCliente = amb.novoCliente;
  await contas(db);
  csso_id = (await db.select({ id: e.unidade_uorg.id }).from(e.unidade_uorg).where(eq(e.unidade_uorg.sigla, "CSSO")))[0]!.id;
  cpel_id = (await db.select({ id: e.unidade_uorg.id }).from(e.unidade_uorg).where(eq(e.unidade_uorg.sigla, "CPEL")))[0]!.id;

  // "coordenador A" é a conta `coordenador_csso` de `contas()`; B é outro da CSSO
  await criarUsuario(db, { login: "coord_b", nome: "Coordenadora B", perfis: ["coordenador_csso"] });
  await criarUsuario(db, { login: "coord_cpel", nome: "Coordenador da CPEL", perfis: ["coordenador_csso"], setores: ["CPEL"] });
  await criarUsuario(db, { login: "tec_b", nome: "Técnico B", perfis: ["tecnico_seguranca"] });

  [servidor_a] = await db.insert(e.servidor).values({ siape: "3000001", nome: "Ana Dono" }).returning();
  [servidor_b] = await db.insert(e.servidor).values({ siape: "3000002", nome: "Bia Dono" }).returning();
  const [t] = await db
    .insert(e.treinamento)
    .values({
      codigo: "NR-35",
      nome: "Trabalho em Altura — NR-35",
      carga_horaria_horas: "8",
      validade_meses: 24,
      criado_por: await _id_conta("coordenador_csso"),
    })
    .returning();
  const modelo = await _modelo_com_tags(db, t!);
  await db.update(e.treinamento).set({ modelo_vigente_id: modelo.id }).where(eq(e.treinamento.id, t!.id));
  treinamento = (await db.select().from(e.treinamento).where(eq(e.treinamento.id, t!.id)))[0]!;
  [instrutor] = await db
    .insert(e.assinatura_instrutor)
    .values({
      nome: "Instrutor de Teste",
      titulo: "Engenheiro de Segurança do Trabalho",
      conselho: "CREA",
      registro_conselho: "MG-1",
      externo: true,
      vigencia_inicio: "2020-01-01",
    })
    .returning();

  const coord = await usuarioAtual(db, "coordenador_csso");
  {
    const turma = await _turma(coord);
    const pessoa = await servico_participante.de_servidor(db, servidor_a!, coord);
    const inscricao = await servico_turma.inscrever(db, coord, turma, pessoa);
    await servico_turma.mudar_situacao(db, coord, turma, "EM_ANDAMENTO");
    await servico_presenca.lancar_presenca(db, coord, inscricao, { data: INICIO, presente: true, horas: "8" });
    await servico_turma.mudar_situacao(db, coord, turma, "CONCLUIDA");
    const fresca = (await servico_turma.carregar_turma(db, turma.id))!;
    const relida = (await servico_turma.carregar_inscricao(db, inscricao.id, fresca))!;
    const emitido = await servico_emissao.emitir(db, coord, relida, { gerar_pdf: false });
    tA = { turma: fresca, inscricao_id: inscricao.id, certificado_id: emitido.certificado.id };
  }
  const tec = await usuarioAtual(db, "tecnico_seguranca");
  {
    const turma = await _turma(tec, { data_inicio: HOJE, data_fim: HOJE });
    const pessoa = await servico_participante.de_servidor(db, servidor_b!, tec);
    const inscricao = await servico_turma.inscrever(db, tec, turma, pessoa);
    await servico_turma.mudar_situacao(db, tec, turma, "EM_ANDAMENTO");
    tT = { turma: (await servico_turma.carregar_turma(db, turma.id))!, inscricao_id: inscricao.id };
  }
});

// =====================================================================
// A hierarquia, num lugar só
// =====================================================================
describe("a hierarquia", () => {
  it("superintendente > coordenação > demais, pelo perfil mais alto da conta", () => {
    expect(nivel_hierarquico(["superintendente"])).toBe(NIVEL_SUPERINTENDENCIA);
    expect(nivel_hierarquico(["coordenador_csso"])).toBe(NIVEL_COORDENACAO);
    expect(nivel_hierarquico(["tecnico_seguranca", "coordenador_csso"])).toBe(NIVEL_COORDENACAO);
    for (const p of ["engenheiro_seguranca", "medico_trabalho", "tecnico_seguranca", "secretaria_csso", "almoxarife_sesmt"]) {
      expect(nivel_hierarquico([p]), p).toBe(NIVEL_DEMAIS);
    }
    expect(NIVEL_SUPERINTENDENCIA).toBeGreaterThan(NIVEL_COORDENACAO);
    // o administrador do sistema no TOPO, acima do superintendente
    expect(ORDEM_HIERARQUICA[0]).toContain("administrador_sistema");
    expect(nivel_hierarquico(["administrador_sistema"])).toBe(NIVEL_ADMINISTRACAO_SISTEMA);
    expect(nivel_hierarquico(["superintendente", "administrador_sistema"])).toBe(NIVEL_ADMINISTRACAO_SISTEMA);
    expect(NIVEL_ADMINISTRACAO_SISTEMA).toBeGreaterThan(NIVEL_SUPERINTENDENCIA);
    expect(NIVEL_COORDENACAO).toBeGreaterThan(NIVEL_DEMAIS);
  });

  it("a turma nova e o treinamento novo gravam o dono (a conta que criou)", async () => {
    expect(tA.turma.criado_por).toBe(await _id_conta("coordenador_csso"));
    expect(tT.turma.criado_por).toBe(await _id_conta("tecnico_seguranca"));
    const c = await _cliente("coordenador_csso");
    const r = await c.post(
      "/treinamentos/catalogo",
      { nome: "Primeiros Socorros", codigo: "PSOC", carga_horaria_horas: "4", validade_meses: "0" },
      { seguir: false },
    );
    expect(r.status, r.text.slice(0, 300)).toBe(303);
    const [novo] = await db.select().from(e.treinamento).where(eq(e.treinamento.codigo, "PSOC"));
    expect(novo!.criado_por).toBe(await _id_conta("coordenador_csso"));
  });

  it("o dono não se troca depois de gravado (trava csso_dono_imutavel)", async () => {
    await expect(
      db.update(e.turma).set({ criado_por: await _id_conta("coord_b") }).where(eq(e.turma.id, tA.turma.id)),
    ).rejects.toThrow();
    await expect(
      db.update(e.treinamento).set({ criado_por: await _id_conta("coord_b") }).where(eq(e.treinamento.id, treinamento.id)),
    ).rejects.toThrow();
  });
});

// =====================================================================
// Coordenador A × coordenador B
// =====================================================================
describe("coordenador B não altera a turma do coordenador A", () => {
  it("cada ato (POST) é recusado com 403 e o aviso, e nada é gravado", async () => {
    const c = await _cliente("coord_b");
    const t = tA.turma.id;
    const i = tA.inscricao_id;
    const tec_b = await _id_conta("tec_b");
    const atos: [string, Record<string, string>][] = [
      [`/turmas/${t}`, EDICAO],
      [`/turmas/${t}/situacao`, { destino: "CANCELADA", motivo: "teste" }],
      [`/turmas/${t}/retificar`, { ...EDICAO, motivo: "teste de retificação" }],
      [`/turmas/${t}/certificados/retificar`, { motivo: "teste de reemissão" }],
      [`/turmas/${t}/excluir`, { motivo: "teste" }],
      [`/turmas/${t}/realizada`, {}],
      [`/turmas/${t}/instrutores`, { assinatura_instrutor_id: String(instrutor.id), remover: "1" }],
      [`/turmas/${t}/inscricoes`, { servidor_id: String(servidor_b!.id) }],
      [`/turmas/${t}/inscricoes/lote`, { linhas: "3000002" }],
      [`/turmas/${t}/link-publico`, {}],
      [`/turmas/${t}/link-publico/desligar`, {}],
      [`/turmas/${t}/inscricoes/${i}`, { destino: "CANCELADA", motivo: "teste" }],
      [`/turmas/${t}/inscricoes/${i}/cpf`, { cpf: "52998224725" }],
      [`/turmas/${t}/inscricoes/${i}/participante`, { nome: "Outro nome" }],
      [`/turmas/${t}/presencas`, { inscricao_id: String(i), data: INICIO, presente: "1", horas: "8" }],
      [`/turmas/${t}/presencas/todos`, { data: INICIO }],
      [`/turmas/${t}/presencas/folha`, {}],
      [`/turmas/${t}/presencas/dia`, { data: INICIO }],
      [`/turmas/${t}/notas`, { inscricao_id: String(i), nota: "9" }],
      [`/turmas/${t}/certificados/email`, {}],
      [`/turmas/${t}/certificados`, { inscricao_id: String(i) }],
      [`/turmas/${t}/campos-certificado`, {}],
      [`/turmas/${t}/campos-participante`, {}],
      [`/turmas/${t}/ajudantes`, { usuario_id: String(tec_b), papel: "PRESENCA" }],
      [`/turmas/${t}/ajudantes/${tec_b}/retirar`, {}],
      [`/certificados/${tA.certificado_id}/anular`, { motivo: "teste" }],
      [`/certificados/${tA.certificado_id}/corrigir`, { motivo: "teste", nome: "Outro" }],
      [`/certificados/${tA.certificado_id}/email`, {}],
    ];
    const antes = await _fotografia(t);
    for (const [caminho, corpo] of atos) {
      const r = await c.post(caminho, corpo, { seguir: false });
      expect(r.status, `${caminho}: ${r.text.slice(0, 200)}`).toBe(403);
      expect(r.text, caminho).toContain(AVISO_A);
    }
    expect(await _fotografia(t)).toEqual(antes);
  });

  it("os botões de alteração somem da ficha, e a tela diz de quem é", async () => {
    const c = await _cliente("coord_b");
    const turma = (await c.get(`/turmas/${tA.turma.id}`)).text;
    expect(turma).toContain("Só consulta.");
    expect(turma).toContain(AVISO_A);
    expect(turma).toContain("Responsável (dono)");
    expect(turma).not.toContain('action="/turmas/' + tA.turma.id + '/situacao"');
    expect(turma).not.toContain('id="designar-ajudante"');
    const emissao = (await c.get(`/turmas/${tA.turma.id}?aba=emissao`)).text;
    expect(emissao).not.toContain('action="/turmas/' + tA.turma.id + '/certificados"');
    expect(emissao).not.toContain('id="reemitir-turma"');
    const inscricoes = (await c.get(`/turmas/${tA.turma.id}?aba=inscricoes`)).text;
    expect(inscricoes).not.toContain('action="/turmas/' + tA.turma.id + '/inscricoes"');
    // a leitura não muda: ela vê a turma e o inscrito
    expect(inscricoes).toContain("Ana Dono");
    // e a ficha do certificado dela também só consulta
    const cert = (await c.get(`/certificados/${tA.certificado_id}`)).text;
    expect(cert).toContain(AVISO_A);
    expect(cert).not.toContain('id="anular-certificado"');
  });

  it("o próprio coordenador A vê os botões e altera", async () => {
    const c = await _cliente("coordenador_csso");
    const ficha = (await c.get(`/turmas/${tT.turma.id}`)).text;
    expect(ficha).toContain("Editar dados da turma");
    const tA_ficha = (await c.get(`/turmas/${tA.turma.id}?aba=emissao`)).text;
    expect(tA_ficha).not.toContain("Só consulta.");
    expect(tA_ficha).toContain('id="reemitir-turma"');
  });

  it("o catálogo: o treinamento do coordenador A só se consulta para B (botão e POST)", async () => {
    const c = await _cliente("coord_b");
    const tela = (await c.get("/treinamentos/catalogo")).text;
    expect(tela).not.toContain(`id="editar-trein-${treinamento.id}"`);
    expect(tela).toContain("só consulta");
    const r = await c.post(
      `/treinamentos/catalogo/${treinamento.id}`,
      { nome: "Outro nome", carga_horaria_horas: "8", validade_meses: "24", ativo: "1" },
      { seguir: false },
    );
    expect(r.status).toBe(403);
    expect(r.text).toContain("Este treinamento é de Coordenador de Teste");
    const excluir = await c.post(`/treinamentos/catalogo/${treinamento.id}/excluir`, {}, { seguir: false });
    expect(excluir.status).toBe(403);
    const [relido] = await db.select().from(e.treinamento).where(eq(e.treinamento.id, treinamento.id));
    expect(relido!.nome).toBe("Trabalho em Altura — NR-35");
  });
});

// =====================================================================
// Superintendente e coordenação do setor
// =====================================================================
describe("acima do dono", () => {
  it("o superintendente altera a turma do coordenador", async () => {
    // a turma do coordenador A, aberta no futuro, para poder editar
    const coord = await usuarioAtual(db, "coordenador_csso");
    const turma = await _turma(coord, { data_inicio: somar_dias(HOJE, 5), data_fim: somar_dias(HOJE, 5) });
    const c = await _cliente("superintendente");
    const r = await c.post(
      `/turmas/${turma.id}`,
      { ...EDICAO, data_inicio: turma.data_inicio, data_fim: turma.data_fim, local: "Pela superintendência" },
      { seguir: false },
    );
    expect(r.status, r.text.slice(0, 300)).toBe(303);
    expect((await servico_turma.carregar_turma(db, turma.id))!.local).toBe("Pela superintendência");
    // e o treinamento do coordenador também
    const cat = await c.post(
      `/treinamentos/catalogo/${treinamento.id}`,
      {
        nome: treinamento.nome,
        codigo_curto: treinamento.codigo_curto,
        carga_horaria_horas: "8",
        validade_meses: "24",
        norma_referencia: "NR-35",
        ativo: "1",
      },
      { seguir: false },
    );
    expect(cat.status).toBe(303);
  });

  it("o coordenador altera a turma criada por técnico do MESMO setor", async () => {
    const c = await _cliente("coord_b");
    const r = await c.post(
      `/turmas/${tT.turma.id}`,
      { ...EDICAO, data_inicio: tT.turma.data_inicio, data_fim: tT.turma.data_fim, local: "Pela coordenação" },
      { seguir: false },
    );
    expect(r.status, r.text.slice(0, 300)).toBe(303);
    expect((await servico_turma.carregar_turma(db, tT.turma.id))!.local).toBe("Pela coordenação");
  });

  it("e não a do técnico de OUTRO setor (ver todos os setores não é ser do setor)", async () => {
    const c = await _cliente("coord_cpel");
    // ele vê (turma.todos_os_setores) ...
    expect((await c.get(`/turmas/${tT.turma.id}`)).status).toBe(200);
    // ... e não altera
    const r = await c.post(`/turmas/${tT.turma.id}`, { ...EDICAO, local: "Pela CPEL" }, { seguir: false });
    expect(r.status).toBe(403);
    expect(r.text).toContain("Esta turma é de Técnica de Teste");
    // a da CPEL criada pelo técnico de lá, sim
    await criarUsuario(db, { login: "tec_cpel", nome: "Técnico CPEL", perfis: ["tecnico_seguranca"], setores: ["CPEL"] });
    const da_cpel = await _turma(await usuarioAtual(db, "tec_cpel"), {
      unidade_promotora_id: cpel_id,
      data_inicio: somar_dias(HOJE, 3),
      data_fim: somar_dias(HOJE, 3),
    });
    const ok = await c.post(
      `/turmas/${da_cpel.id}`,
      { ...EDICAO, data_inicio: da_cpel.data_inicio, data_fim: da_cpel.data_fim, local: "Pela CPEL" },
      { seguir: false },
    );
    expect(ok.status, ok.text.slice(0, 300)).toBe(303);
  });
});

// =====================================================================
// Técnico não designado e ajudante
// =====================================================================
describe("ajudantes", () => {
  it("o técnico não designado só consulta a turma do outro técnico", async () => {
    const c = await _cliente("tec_b");
    const ficha = (await c.get(`/turmas/${tT.turma.id}?aba=presencas`)).text;
    expect(ficha).toContain("Só consulta.");
    expect(ficha).not.toContain('id="f-folha"');
    const r = await c.post(`/turmas/${tT.turma.id}/presencas/dia`, { data: HOJE }, { seguir: false });
    expect(r.status).toBe(403);
    expect(r.text).toContain("Esta turma é de Técnica de Teste; só ele ou a coordenação acima pode alterar.");
  });

  it("o dono designa (auditado), o ajudante opera só nos papéis dados e não designa", async () => {
    const dono = await _cliente("tecnico_seguranca");
    const tec_b = await _id_conta("tec_b");
    // a ficha do dono oferece o popup
    const ficha = (await dono.get(`/turmas/${tT.turma.id}`)).text;
    expect(ficha).toContain('id="designar-ajudante"');
    const r = await dono.post(`/turmas/${tT.turma.id}/ajudantes`, { usuario_id: String(tec_b), papel: "PRESENCA" }, { seguir: false });
    expect(r.status, r.text.slice(0, 300)).toBe(303);
    const [evento] = await db
      .select()
      .from(e.historico_evento)
      .where(and(eq(e.historico_evento.entidade_id, tT.turma.id), eq(e.historico_evento.tipo_evento, dono_turma.TURMA_AJUDANTE_DESIGNADO)));
    expect(evento!.descricao).toContain("Técnico B");
    expect(evento!.descricao).toContain("presença e notas");
    expect(evento!.usuario_nome).toBe("Técnica de Teste");
    expect(auditoria.ROTULO_EVENTO[dono_turma.TURMA_AJUDANTE_DESIGNADO]).toBeTruthy();
    expect(auditoria.ROTULO_EVENTO[dono_turma.TURMA_AJUDANTE_RETIRADO]).toBeTruthy();

    const ajudante = await _cliente("tec_b");
    // presença: pode
    const p = await ajudante.post(`/turmas/${tT.turma.id}/presencas/dia`, { data: HOJE }, { seguir: false });
    expect(p.status, p.text.slice(0, 300)).toBe(303);
    const [presenca] = await db.select().from(e.turma_presenca).where(eq(e.turma_presenca.inscricao_id, tT.inscricao_id));
    expect(presenca).toBeTruthy();
    // inscrição: não
    const i = await ajudante.post(`/turmas/${tT.turma.id}/inscricoes`, { servidor_id: String(servidor_a!.id) }, { seguir: false });
    expect(i.status).toBe(403);
    expect(i.text).toContain("Você ajuda nesta turma só em: Presença e notas.");
    // editar a turma: não
    expect((await ajudante.post(`/turmas/${tT.turma.id}`, EDICAO, { seguir: false })).status).toBe(403);
    // designar outro: não
    const outro = await _id_conta("secretaria_csso");
    const d = await ajudante.post(`/turmas/${tT.turma.id}/ajudantes`, { usuario_id: String(outro), papel: "PRESENCA" }, { seguir: false });
    expect(d.status).toBe(403);
    // a ficha do ajudante: a grade de presença aparece, o "Editar" e o popup de designar não
    const tela = (await ajudante.get(`/turmas/${tT.turma.id}?aba=presencas`)).text;
    expect(tela).toContain("Você ajuda nesta turma");
    expect(tela).toContain('id="f-folha"');
    const turma_tela = (await ajudante.get(`/turmas/${tT.turma.id}`)).text;
    expect(turma_tela).not.toContain('id="editar-turma"');
    expect(turma_tela).not.toContain('id="designar-ajudante"');
  });

  it("retirar o ajudante (auditado) devolve a conta à consulta", async () => {
    const dono = await _cliente("tecnico_seguranca");
    const tec_b = await _id_conta("tec_b");
    const r = await dono.post(`/turmas/${tT.turma.id}/ajudantes/${tec_b}/retirar`, {}, { seguir: false });
    expect(r.status).toBe(303);
    const [evento] = await db
      .select()
      .from(e.historico_evento)
      .where(and(eq(e.historico_evento.entidade_id, tT.turma.id), eq(e.historico_evento.tipo_evento, dono_turma.TURMA_AJUDANTE_RETIRADO)));
    expect(evento!.descricao).toContain("Técnico B");
    const p = await (await _cliente("tec_b")).post(`/turmas/${tT.turma.id}/presencas/dia`, { data: HOJE }, { seguir: false });
    expect(p.status).toBe(403);
  });

  it("designar pede papel e conta da equipe do setor", async () => {
    const dono = await _cliente("tecnico_seguranca");
    const tec_b = await _id_conta("tec_b");
    const sem_papel = await dono.post(`/turmas/${tT.turma.id}/ajudantes`, { usuario_id: String(tec_b) }, { seguir: false });
    expect(sem_papel.status).toBe(303);
    expect(await db.select().from(e.turma_ajudante).where(eq(e.turma_ajudante.turma_id, tT.turma.id))).toHaveLength(0);
    // a conta da CPEL não é do setor da turma (CSSO)
    const cpel = await _id_conta("coord_cpel");
    await dono.post(`/turmas/${tT.turma.id}/ajudantes`, { usuario_id: String(cpel), papel: "INSCRICOES" }, { seguir: false });
    expect(await db.select().from(e.turma_ajudante).where(eq(e.turma_ajudante.turma_id, tT.turma.id))).toHaveLength(0);
  });

  it("a permissão continua necessária: ajudante sem a permissão do ato não opera", async () => {
    // o almoxarife não tem `turma.avaliar`: designado para presença, segue recusado pelo RBAC
    const secretaria = await usuarioAtual(db, "almoxarife_sesmt");
    expect(secretaria.pode("turma.avaliar")).toBe(false);
    await db.insert(e.turma_ajudante).values({
      turma_id: tT.turma.id,
      usuario_id: secretaria.id,
      presenca: true,
      designado_por: tT.turma.criado_por!,
    });
    const r = await (await _cliente("almoxarife_sesmt")).post(`/turmas/${tT.turma.id}/presencas/dia`, { data: HOJE }, { seguir: false });
    expect(r.status).toBe(403);
    expect(r.text).not.toContain("Você ajuda nesta turma");
    await db.delete(e.turma_ajudante).where(eq(e.turma_ajudante.usuario_id, secretaria.id));
  });
});

// =====================================================================
// Pedido pelo link público
// =====================================================================
describe("a aprovação do pedido feito pelo link público", () => {
  it("só o dono (ou acima) aceita; o outro coordenador vê o pedido e não decide", async () => {
    inscricao_publica.limpar_limites();
    const coord = await usuarioAtual(db, "coordenador_csso");
    let turma = await _turma(coord, { data_inicio: somar_dias(HOJE, 10), data_fim: somar_dias(HOJE, 10) });
    await db.update(e.turma).set({ inscricao_aberta_ate: somar_dias(HOJE, 8) }).where(eq(e.turma.id, turma.id));
    turma = (await servico_turma.carregar_turma(db, turma.id))!;
    turma = await servico_turma.mudar_situacao(db, coord, turma, "INSCRICOES_ABERTAS");
    const token = await inscricao_publica.gerar_link(db, coord, turma);
    const p = await novoCliente().post(`/inscricao/${token}`, {
      nome: "Joana Prestes da Silva",
      vinculo: "TERCEIRIZADO",
      siape: "",
      email: "joana@empresa.com.br",
      organizacao: "Limpeza & Cia",
      consentimento: "sim",
    });
    expect(p.status, p.text.slice(0, 300)).toBe(200);
    const [pedido] = await db.select().from(e.inscricao).where(eq(e.inscricao.turma_id, turma.id));
    expect(pedido!.situacao).toBe("AGUARDANDO_EMAIL");

    // a coordenadora B: a tela de pedidos mostra, sem caixa de marcar, com o aviso
    const b = await _cliente("coord_b");
    const tela = (await b.get("/turmas/pedidos")).text;
    expect(tela).toContain(turma.codigo);
    expect(tela).not.toContain(`name="inscricao_id" value="${pedido!.id}"`);
    expect(tela).toContain(AVISO_A);
    // e o POST não decide
    const r = await b.post("/turmas/pedidos", { inscricao_id: String(pedido!.id), acao: "aceitar" });
    expect(r.text).toContain(AVISO_A);
    expect((await db.select().from(e.inscricao).where(eq(e.inscricao.id, pedido!.id)))[0]!.situacao).toBe("AGUARDANDO_EMAIL");
    // nem pela linha da aba Inscrições
    const linha = await b.post(`/turmas/${turma.id}/inscricoes/${pedido!.id}`, { destino: "INSCRITA" }, { seguir: false });
    expect(linha.status).toBe(403);

    // o dono aceita
    const a = await _cliente("coordenador_csso");
    expect((await a.get("/turmas/pedidos")).text).toContain(`name="inscricao_id" value="${pedido!.id}"`);
    await a.post("/turmas/pedidos", { inscricao_id: String(pedido!.id), acao: "aceitar" });
    // aceitar já confirma a vaga (25/10/2026)
    expect((await db.select().from(e.inscricao).where(eq(e.inscricao.id, pedido!.id)))[0]!.situacao).toBe("CONFIRMADA");
  });
});

// =====================================================================
// A turma antiga, sem dono
// =====================================================================
describe("a turma sem dono (de antes da regra)", () => {
  let antiga_id: number;

  beforeAll(async () => {
    const dia = somar_dias(HOJE, 20);
    const [linha] = await db
      .insert(e.turma)
      .values({
        treinamento_id: treinamento.id,
        numero: 9001,
        ano: Number(dia.slice(0, 4)),
        codigo: `TUR-${dia.slice(0, 4)}-9001`,
        data_inicio: dia,
        data_fim: dia,
        situacao: "PLANEJADA",
        criado_por: null,
      })
      .returning();
    antiga_id = linha!.id;
  });

  it("o técnico só consulta; a coordenação da CSSO e o superintendente alteram; a CPEL não", async () => {
    const dia = somar_dias(HOJE, 20);
    const edicao = { ...EDICAO, data_inicio: dia, data_fim: dia };
    const tec = await _cliente("tecnico_seguranca");
    const ficha = (await tec.get(`/turmas/${antiga_id}`)).text;
    expect(ficha).toContain("sem dono registrado");
    const r = await tec.post(`/turmas/${antiga_id}`, edicao, { seguir: false });
    expect(r.status).toBe(403);
    expect(r.text).toContain("Esta turma não tem dono registrado");
    expect((await (await _cliente("coord_cpel")).post(`/turmas/${antiga_id}`, edicao, { seguir: false })).status).toBe(403);
    expect((await (await _cliente("coord_b")).post(`/turmas/${antiga_id}`, { ...edicao, local: "B" }, { seguir: false })).status).toBe(303);
    expect((await (await _cliente("superintendente")).post(`/turmas/${antiga_id}`, { ...edicao, local: "S" }, { seguir: false })).status).toBe(
      303,
    );
  });

  it("a migração 0017 preenche o dono pelo evento de criação da trilha; sem evento, fica sem dono", async () => {
    const dia = somar_dias(HOJE, 21);
    const [com_evento] = await db
      .insert(e.turma)
      .values({
        treinamento_id: treinamento.id,
        numero: 9002,
        ano: Number(dia.slice(0, 4)),
        codigo: `TUR-${dia.slice(0, 4)}-9002`,
        data_inicio: dia,
        data_fim: dia,
        situacao: "PLANEJADA",
        criado_por: null,
      })
      .returning();
    const tec = await usuarioAtual(db, "tecnico_seguranca");
    await auditoria.registrar(db, {
      entidade: "turma",
      entidade_id: com_evento!.id,
      tipo_evento: "TURMA_CRIADA",
      descricao: "importada",
      usuario: tec,
    });
    // os UPDATE do fim da migração, como estão no arquivo
    const arquivo = readFileSync(path.resolve("src/db/migracoes/0017_dono_treinamento.sql"), "utf8");
    const preenchimentos = arquivo
      .split("--> statement-breakpoint")
      .map((x) => x.trim())
      .filter((x) => /^(--[^\n]*\n)*UPDATE /.test(x));
    expect(preenchimentos).toHaveLength(2);
    for (const comando of preenchimentos) await db.execute(sql.raw(comando));
    const [preenchida] = await db.select().from(e.turma).where(eq(e.turma.id, com_evento!.id));
    expect(preenchida!.criado_por).toBe(tec.id);
    const [sem] = await db.select().from(e.turma).where(eq(e.turma.id, antiga_id));
    expect(sem!.criado_por).toBeNull();
  });
});

// =====================================================================
// A decisão, sem HTTP
// =====================================================================
describe("pode_alterar_turma", () => {
  it("responde por papel, e o UsuarioAtual montado à mão não é recortado", async () => {
    const coord_b = await usuarioAtual(db, "coord_b");
    const turma = { id: tA.turma.id, criado_por: tA.turma.criado_por, unidade_promotora_id: tA.turma.unidade_promotora_id };
    expect(await dono_turma.pode_alterar_turma(db, coord_b, turma, dono_turma.INSCRICOES)).toBe(false);
    const coord_a = await usuarioAtual(db, "coordenador_csso");
    for (const papel of [dono_turma.GERAL, dono_turma.INSCRICOES, dono_turma.PRESENCA, dono_turma.EMISSAO] as const) {
      expect(await dono_turma.pode_alterar_turma(db, coord_a, turma, papel)).toBe(true);
    }
    const { UsuarioAtual } = await import("../src/servicos/rbac.js");
    const a_mao = new UsuarioAtual({ id: coord_b.id, login: "x", nome: "x", permissoes: [], perfis: ["tecnico_seguranca"] });
    expect(await dono_turma.pode_alterar_turma(db, a_mao, turma, dono_turma.GERAL)).toBe(true);
  });
});
