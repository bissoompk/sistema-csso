/**
 * Leitura nominal e assinatura (D14, D15, D22 e D29 da verificação de
 * governança, 22/10/2026).
 *
 * - D14: a Consulta PROGEP lia parecer em rascunho, embora a base do perfil
 *   diga "lê apenas parecer assinado";
 * - D15: `epi.ficha` mostrava o nome de quem demanda (e de quem está numa
 *   turma) fora das telas de EPI;
 * - D22: marcar como assinado não conferia se quem marca é o signatário;
 * - D29: a secretaria lia o nome do inscrito e não inscrevia em lote pelo nome.
 *
 * Um banco para o arquivo; cada teste monta o PRÓPRIO parecer.
 */
import { and, eq } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as e from "../src/db/esquema/index.js";
import * as servico_parecer from "../src/servicos/parecer.js";
import * as identificacao from "../src/servicos/identificacao.js";
import * as inscricao_lote from "../src/servicos/inscricao_lote.js";
import {
  CONCESSAO_DO_TITULAR,
  MATRIZ_PERFIS,
  PERMISSOES_DO_TITULAR,
  UsuarioAtual,
  type Concessao,
} from "../src/servicos/rbac.js";
import { bancoLimpo, contas, criarUsuario, entrar, usuarioAtual, type Cliente } from "./ajuda";
import { cenario } from "./ajuda_processos.js";

const { db, novoCliente } = await bancoLimpo();
await contas(db);

const HTML = { cabecalhos: { accept: "text/html" } };
const dialeto = new PgDialect();

let seq = 0;
async function caso() {
  seq += 1;
  const n = String(seq).padStart(3, "0");
  return cenario(db, {
    nup: `23086.${String(870000 + seq)}/2024-11`,
    siape: String(3870000 + seq),
    laudo: `26255-000.${n}/2017`,
    numero_portaria: String(870 + seq),
  });
}

async function cliente(login: string): Promise<Cliente> {
  return entrar(novoCliente(), login);
}

async function situacao(parecer_id: number): Promise<string> {
  const [p] = await db.select().from(e.parecer_tecnico).where(eq(e.parecer_tecnico.id, parecer_id));
  return p!.situacao;
}

/** Emite pela tela, como o coordenador (signatário do cenário). */
async function emitido(): Promise<Awaited<ReturnType<typeof caso>>> {
  const c = await caso();
  const r = await (await cliente("coordenador_csso")).post(`/pareceres/${c.parecer_id}/emitir`, {}, { seguir: false });
  expect(r.status, r.text.slice(0, 300)).toBe(303);
  expect(await situacao(c.parecer_id)).toBe("EMITIDO");
  return c;
}

function conta(atribuicoes: [string, number | null][], servidor_id: number | null = null): UsuarioAtual {
  const concessoes: Concessao[] = atribuicoes.map(([perfil, campus_id]) => ({
    perfil,
    campus_id,
    permissoes: MATRIZ_PERFIS[perfil]!.permissoes,
  }));
  if (servidor_id !== null) {
    concessoes.push({ perfil: CONCESSAO_DO_TITULAR, campus_id: null, permissoes: PERMISSOES_DO_TITULAR });
  }
  return new UsuarioAtual({
    id: 1,
    login: "x",
    nome: "x",
    permissoes: concessoes.flatMap((c) => [...c.permissoes]),
    perfis: atribuicoes.map(([p]) => p),
    servidor_id,
    concessoes,
  });
}

// =====================================================================
// D14
// =====================================================================
describe("D14 — a Consulta PROGEP lê o parecer como documento", () => {
  it("o rascunho não existe para ela; o emitido abre", async () => {
    const c = await caso();
    const progep = await cliente("consulta_progep");
    const ficha = await progep.get(`/pareceres/${c.parecer_id}`, { ...HTML, seguir: false });
    expect(ficha.status).toBe(303);
    for (const sufixo of ["/docx", "/previa"]) {
      expect((await progep.get(`/pareceres/${c.parecer_id}${sufixo}`, { seguir: false })).status, sufixo).toBe(404);
    }
    await (await cliente("coordenador_csso")).post(`/pareceres/${c.parecer_id}/emitir`, {}, { seguir: false });
    expect((await progep.get(`/pareceres/${c.parecer_id}`, { ...HTML, seguir: false })).status).toBe(200);
  });

  it("o anulado depois de emitido continua legível; o rascunho anulado não", async () => {
    const emit = await emitido();
    await db.update(e.parecer_tecnico).set({ situacao: "ANULADO", motivo_anulacao: "erro material" }).where(eq(e.parecer_tecnico.id, emit.parecer_id));
    const rasc = await caso();
    await db.update(e.parecer_tecnico).set({ situacao: "ANULADO", motivo_anulacao: "erro material" }).where(eq(e.parecer_tecnico.id, rasc.parecer_id));
    const progep = await cliente("consulta_progep");
    expect((await progep.get(`/pareceres/${emit.parecer_id}`, { ...HTML, seguir: false })).status).toBe(200);
    expect((await progep.get(`/pareceres/${rasc.parecer_id}`, { ...HTML, seguir: false })).status).toBe(303);
  });

  it("a secretaria continua lendo o rascunho (o editor desligado, M79)", async () => {
    const c = await caso();
    const r = await (await cliente("secretaria_csso")).get(`/pareceres/${c.parecer_id}`, { ...HTML, seguir: false });
    expect(r.status).toBe(200);
  });

  it("a PROGEP que é a titular lê o próprio rascunho pela concessão do titular", async () => {
    const c = await caso();
    await db.update(e.usuario).set({ servidor_id: c.servidor_id }).where(eq(e.usuario.login, "consulta_progep"));
    try {
      const r = await (await cliente("consulta_progep")).get(`/pareceres/${c.parecer_id}`, { ...HTML, seguir: false });
      expect(r.status).toBe(200);
    } finally {
      await db.update(e.usuario).set({ servidor_id: null }).where(eq(e.usuario.login, "consulta_progep"));
    }
  });

  it("o recorte é da concessão: PROGEP + coordenador lê todo rascunho; os atos não passam por ele", () => {
    const so = servico_parecer.escopo_de_leitura(conta([["consulta_progep", null]]));
    expect(dialeto.sqlToQuery(so!).sql).toContain('"situacao" in');
    expect(servico_parecer.escopo_de_leitura(conta([["consulta_progep", null], ["coordenador_csso", null]]))).toBeUndefined();
    expect(servico_parecer.escopo_de_leitura(conta([["secretaria_csso", null]]))).toBeUndefined();
    // a do titular não alarga: o rascunho só o dele
    const titular = servico_parecer.escopo_de_leitura(conta([["consulta_progep", null]], 77));
    const q = dialeto.sqlToQuery(titular!);
    expect(q.sql).toContain('"servidor_id" =');
    expect(q.params).toContain(77);
  });
});

// =====================================================================
// D22
// =====================================================================
describe("D22 — quem marca como assinado é o signatário, ou declara a substituição", () => {
  async function engenheiro_habilitado(): Promise<void> {
    const [eng] = await db.select().from(e.usuario).where(eq(e.usuario.login, "engenheiro_seguranca"));
    const [ja] = await db
      .select()
      .from(e.profissional_habilitado)
      .where(eq(e.profissional_habilitado.usuario_id, eng!.id));
    if (ja) return;
    await db.insert(e.profissional_habilitado).values({
      usuario_id: eng!.id,
      nome: "Engenheiro de Teste",
      habilitacao: "ENG_SEG_TRABALHO",
      titulo_assinatura: "Engenheiro de Segurança do Trabalho",
      vigencia_inicio: "2020-01-01",
    });
  }

  async function eventos(tipo: string, parecer_id: number) {
    return db
      .select()
      .from(e.historico_evento)
      .where(
        and(
          eq(e.historico_evento.tipo_evento, tipo),
          eq(e.historico_evento.entidade, "parecer_tecnico"),
          eq(e.historico_evento.entidade_id, parecer_id),
        ),
      );
  }

  it("o signatário marca com um clique, sem evento de substituição", async () => {
    const c = await emitido();
    const coord = await cliente("coordenador_csso");
    const tela = (await coord.get(`/pareceres/${c.parecer_id}`, HTML)).text;
    expect(tela).toContain("Marcar como assinado</button>");
    expect(tela).not.toContain('id="assinar-substituto"');
    expect((await coord.post(`/pareceres/${c.parecer_id}/assinar`, {}, { seguir: false })).status).toBe(303);
    expect(await situacao(c.parecer_id)).toBe("ASSINADO");
    expect(await eventos(servico_parecer.ASSINATURA_REGISTRADA_POR_SUBSTITUTO, c.parecer_id)).toEqual([]);
  });

  it("outro habilitado não marca sem declarar; a tela oferece só a substituição", async () => {
    await engenheiro_habilitado();
    const c = await emitido();
    const eng = await cliente("engenheiro_seguranca");
    const tela = (await eng.get(`/pareceres/${c.parecer_id}`, HTML)).text;
    expect(tela).not.toContain("Marcar como assinado</button>");
    expect(tela).toContain('href="#assinar-substituto"');
    const r = await eng.post(`/pareceres/${c.parecer_id}/assinar`, {}, HTML);
    expect(r.text).toContain("só essa pessoa o marca como assinado");
    expect(await situacao(c.parecer_id)).toBe("EMITIDO");
  });

  it("substituição sem motivo reabre o popup com a recusa", async () => {
    await engenheiro_habilitado();
    const c = await emitido();
    const eng = await cliente("engenheiro_seguranca");
    const r = await eng.post(`/pareceres/${c.parecer_id}/assinar`, { substituicao: "1", motivo_substituicao: "  " }, HTML);
    expect(r.text).toMatch(/<dialog class="popup" id="assinar-substituto"[^>]* open>/);
    expect(r.text).toContain("informe o motivo da substituição");
    expect(await situacao(c.parecer_id)).toBe("EMITIDO");
  });

  it("substituição declarada marca e vai para a trilha com o motivo", async () => {
    await engenheiro_habilitado();
    const c = await emitido();
    const eng = await cliente("engenheiro_seguranca");
    const r = await eng.post(
      `/pareceres/${c.parecer_id}/assinar`,
      { substituicao: "1", motivo_substituicao: "titular em férias; assinou no SEI antes de sair" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    expect(await situacao(c.parecer_id)).toBe("ASSINADO");
    const [ev] = await eventos(servico_parecer.ASSINATURA_REGISTRADA_POR_SUBSTITUTO, c.parecer_id);
    expect(ev!.descricao).toContain("titular em férias");
    expect(ev!.descricao).toContain("Fabrício Raimundi Andrade");
    expect(await eventos("PARECER_ASSINADO", c.parecer_id)).toHaveLength(1);
  });

  it("a substituição não dispensa a habilitação (RN-01)", async () => {
    const c = await emitido();
    const r = await (await cliente("tecnico_seguranca")).post(
      `/pareceres/${c.parecer_id}/assinar`,
      { substituicao: "1", motivo_substituicao: "qualquer" },
      { ...HTML, seguir: false },
    );
    expect(r.status).toBe(403);
    expect(await situacao(c.parecer_id)).toBe("EMITIDO");
  });
});

// =====================================================================
// D15
// =====================================================================
describe("D15 — epi.ficha não é nominal fora das telas de EPI", () => {
  async function demanda_com_servidor(): Promise<{ id: number; nome: string }> {
    const c = await caso();
    const [srv] = await db.select().from(e.servidor).where(eq(e.servidor.id, c.servidor_id));
    const r = await (await cliente("coordenador_csso")).post(
      "/demandas",
      {
        assunto: "Pergunta sobre o adicional",
        canal: "EMAIL",
        solicitante_nome: "",
        solicitante_servidor_id: String(srv!.id),
        data_chegada: "2026-10-01",
      },
      { seguir: false },
    );
    expect(r.status, r.text.slice(0, 300)).toBe(303);
    return { id: Number(r.location!.split("/demandas/")[1]!.split("?")[0]), nome: srv!.nome };
  }

  it("o almoxarife vê o código opaco na fila e na ficha, e escolhe pelo SIAPE", async () => {
    const d = await demanda_com_servidor();
    const almox = await cliente("almoxarife_sesmt");
    const fila = (await almox.get("/demandas", HTML)).text;
    expect(fila).toContain("Pergunta sobre o adicional");
    expect(fila).not.toContain(d.nome);
    expect(fila).toContain('name="solicitante_siape"');
    const ficha = (await almox.get(`/demandas/${d.id}`, HTML)).text;
    expect(ficha).not.toContain(d.nome);
  });

  it("o coordenador continua vendo o nome", async () => {
    const d = await demanda_com_servidor();
    const fila = (await (await cliente("coordenador_csso")).get("/demandas", HTML)).text;
    expect(fila).toContain(d.nome);
  });

  it("identificar com a família de fora do EPI ignora epi.ficha", async () => {
    const almox = await usuarioAtual(db, "almoxarife_sesmt");
    const alvo = { id: 999999, nome: "Fulana de Tal", siape: "1234567" };
    expect(identificacao.identificar(alvo, almox, "s").nominal).toBe(true);
    expect(
      identificacao.identificar(alvo, almox, "s", { nominais: identificacao.NOMINAIS_FORA_DO_EPI }).nominal,
    ).toBe(false);
    expect(identificacao.texto_livre("Tarefa de Fulana", almox, { sobre: 999999, nominais: identificacao.NOMINAIS_FORA_DO_EPI })).toBe(
      identificacao.TEXTO_SUPRIMIDO,
    );
  });
});

// =====================================================================
// D29
// =====================================================================
describe("D29 — casar pelo nome no lote é a mesma regra de mostrar o nome na turma", () => {
  it("a secretaria (certificado.ver) casa; o almoxarife (epi.ficha) não", async () => {
    expect(inscricao_lote.casa_nome(await usuarioAtual(db, "secretaria_csso"))).toBe(true);
    expect(inscricao_lote.casa_nome(await usuarioAtual(db, "coordenador_csso"))).toBe(true);
    expect(inscricao_lote.casa_nome(await usuarioAtual(db, "almoxarife_sesmt"))).toBe(false);
    expect(inscricao_lote.casa_nome(await usuarioAtual(db, "servidor_consulta"))).toBe(false);
  });

  it("a conta com epi.ficha e sem certificado.ver nem exposicao.ver não casa", async () => {
    const conta_x = await criarUsuario(db, { login: `almox_lote_${Date.now()}`, perfis: ["almoxarife_sesmt"] });
    const u = await usuarioAtual(db, conta_x.login);
    expect(u.ve_dado_nominal).toBe(true); // o getter antigo dizia sim
    expect(inscricao_lote.casa_nome(u)).toBe(false);
  });
});
