/**
 * Correções do lote "pareceres, laudos, adicionais e pendências": um teste por
 * defeito de regra, permissão ou validação, com o número do item no nome.
 *
 * Um banco para o arquivo; cada teste monta o PRÓPRIO cenário (NUP, SIAPE e
 * laudo próprios) e lê só o dele.
 */
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { hoje_iso, somar_dias } from "../src/dominio/datas.js";
import * as direito from "../src/servicos/direito.js";
import * as pendencias from "../src/servicos/pendencias.js";
import { bancoLimpo, contas, entrar, liberarProcessos, usuarioAtual, type Cliente } from "./ajuda";
import { cenario, parecerDe } from "./ajuda_processos.js";

const { db, novoCliente } = await bancoLimpo();
await contas(db);
const coordenador = await usuarioAtual(db, "coordenador_csso");

const HTML = { cabecalhos: { accept: "text/html" } };
const HOJE = hoje_iso();

let seq = 0;
/** O caso do Parecer 1/2025 com NUP, SIAPE e laudo próprios. */
async function caso() {
  seq += 1;
  const n = String(seq).padStart(3, "0");
  return cenario(db, {
    nup: `23086.${String(810000 + seq)}/2024-11`,
    siape: String(3700000 + seq),
    laudo: `26255-000.${n}/2018`,
    numero_portaria: String(500 + seq),
  });
}

async function cliente(login: string): Promise<Cliente> {
  return entrar(novoCliente(), login);
}

async function id_de(login: string): Promise<number> {
  const [u] = await db.select().from(e.usuario).where(eq(e.usuario.login, login));
  return u!.id;
}

let chave = 0;
async function pendencia(d: Partial<pendencias.DadosAbertura> & { tipo: string }) {
  chave += 1;
  return pendencias.abrir(db, { chave: `correcoes:${chave}`, descricao: "Tarefa de Fulano de Tal", ...d });
}

// =====================================================================
// Pendências
// =====================================================================
describe("D65 — concluir pendência de outra pessoa pede escrita no módulo DELA", () => {
  it("todo tipo declarado tem a sua permissão de conclusão", () => {
    for (const tipo of Object.keys(pendencias.TIPOS)) {
      expect(pendencias.PERMISSAO_CONCLUIR_POR_TIPO, tipo).toHaveProperty(tipo);
    }
  });

  it("a secretaria fecha a do processo, e não a de EPI nem a de certificado", async () => {
    const outro = await id_de("engenheiro_seguranca");
    const sei = await pendencia({ tipo: "INCLUIR_NO_SEI", responsavel_id: outro });
    const epi = await pendencia({ tipo: "TROCA_EPI_DEVIDA", responsavel_id: outro });
    const cert = await pendencia({ tipo: "CERTIFICADO_A_VENCER", responsavel_id: outro });
    const sec = await cliente("secretaria_csso");

    const tela = (await sec.get("/pendencias", HTML)).text;
    expect(tela).toContain(`/pendencias/${sei.id}/concluir`);
    expect(tela).not.toContain(`/pendencias/${epi.id}/concluir`);
    expect(tela).not.toContain(`/pendencias/${cert.id}/concluir`);

    expect((await sec.post(`/pendencias/${epi.id}/concluir`, {}, { ...HTML, seguir: false })).status).toBe(403);
    expect((await sec.post(`/pendencias/${cert.id}/concluir`, {}, { ...HTML, seguir: false })).status).toBe(403);
    const ok = await sec.post(`/pendencias/${sei.id}/concluir`, {}, HTML);
    expect(ok.text).toContain("Pendência concluída.");
    const [linha] = await db.select().from(e.pendencia).where(eq(e.pendencia.id, epi.id));
    expect(linha!.concluida).toBe(false);
  });

  it("o almoxarife não fecha a tarefa de parecer de outra pessoa", async () => {
    const p = await pendencia({ tipo: "INCLUIR_NO_SEI", responsavel_id: await id_de("engenheiro_seguranca") });
    const almox = await cliente("almoxarife_sesmt");
    expect((await almox.post(`/pendencias/${p.id}/concluir`, {}, { ...HTML, seguir: false })).status).toBe(403);
  });

  it("o responsável fecha a própria, mesmo sem escrita no módulo", async () => {
    const p = await pendencia({ tipo: "TROCA_EPI_DEVIDA", responsavel_id: await id_de("secretaria_csso") });
    const r = await (await cliente("secretaria_csso")).post(`/pendencias/${p.id}/concluir`, {}, HTML);
    expect(r.text).toContain("Pendência concluída.");
  });

  it("fora do escopo de leitura a pendência não existe, nem para concluir", async () => {
    const p = await pendencia({ tipo: "INCLUIR_NO_SEI", responsavel_id: coordenador.id });
    const titular = await cliente("servidor_consulta");
    const r = await titular.post(`/pendencias/${p.id}/concluir`, {}, HTML);
    expect(r.text).toContain("Pendência não encontrada.");
    const [linha] = await db.select().from(e.pendencia).where(eq(e.pendencia.id, p.id));
    expect(linha!.concluida).toBe(false);
  });
});

describe("D76 — concluir duas vezes", () => {
  it("a segunda diz que já estava concluída e não grava de novo", async () => {
    const p = await pendencia({ tipo: "INCLUIR_NO_SEI", responsavel_id: coordenador.id });
    const coord = await cliente("coordenador_csso");
    expect((await coord.post(`/pendencias/${p.id}/concluir`, {}, HTML)).text).toContain("Pendência concluída.");
    const segunda = await coord.post(`/pendencias/${p.id}/concluir`, {}, HTML);
    expect(segunda.text).toContain("Esta pendência já estava concluída.");
    const eventos = await db
      .select()
      .from(e.historico_evento)
      .where(and(eq(e.historico_evento.entidade, "pendencia"), eq(e.historico_evento.entidade_id, p.id)));
    expect(eventos.filter((x) => x.tipo_evento === "PENDENCIA_CONCLUIDA")).toHaveLength(1);
  });

  it("concluir em 'Só as minhas' volta para 'Só as minhas'", async () => {
    const p = await pendencia({ tipo: "INCLUIR_NO_SEI", responsavel_id: coordenador.id });
    const r = await (await cliente("coordenador_csso")).post(`/pendencias/${p.id}/concluir?minhas=1`, {}, { seguir: false });
    expect(r.location).toMatch(/^\/pendencias\?minhas=1&mensagem=/);
  });
});

describe("D74 — concluídas recentemente", () => {
  it("as mais recentes primeiro, pela data de conclusão", async () => {
    const antiga = await pendencia({ tipo: "INCLUIR_NO_SEI", descricao: "ZZ-conclusao-antiga", responsavel_id: coordenador.id });
    const nova = await pendencia({ tipo: "INCLUIR_NO_SEI", descricao: "ZZ-conclusao-nova", responsavel_id: coordenador.id });
    // a de id MENOR é a concluída por último
    await db
      .update(e.pendencia)
      .set({ concluida: true, concluida_em: new Date(Date.now() + 60_000) })
      .where(eq(e.pendencia.id, antiga.id));
    await db
      .update(e.pendencia)
      .set({ concluida: true, concluida_em: new Date(Date.now() - 86_400_000) })
      .where(eq(e.pendencia.id, nova.id));
    const tela = (await (await cliente("coordenador_csso")).get("/pendencias", HTML)).text;
    expect(tela.indexOf("ZZ-conclusao-antiga")).toBeGreaterThan(-1);
    expect(tela.indexOf("ZZ-conclusao-antiga")).toBeLessThan(tela.indexOf("ZZ-conclusao-nova"));
  });
});

describe("M62/M63 — a linha legível para quem não lê nome", () => {
  it("demanda vira 'Demanda: <assunto>' e a âncora tem rótulo, sem o nome de ninguém", async () => {
    const [d] = await db
      .insert(e.demanda)
      .values({ data_chegada: HOJE, canal: "EMAIL", solicitante_nome: "Fulano de Tal", assunto: "ZZ troca de luvas do laboratório" })
      .returning();
    const p = await pendencia({
      tipo: "DEMANDA_COM_PRAZO",
      descricao: "Responder Fulano de Tal sobre as luvas",
      entidade: "demanda",
      entidade_id: d!.id,
      responsavel_id: coordenador.id,
    });
    const ficha = await pendencia({
      tipo: "COMPROVANTE_EPI_PENDENTE",
      descricao: "Comprovante da entrega a Fulano de Tal",
      entidade: "epi_ficha_registro",
      entidade_id: 7,
      responsavel_id: coordenador.id,
    });
    const tela = (await (await cliente("secretaria_csso")).get("/pendencias", HTML)).text;
    expect(tela).toContain("Demanda: ZZ troca de luvas do laboratório");
    expect(tela).toContain("Anexar o comprovante assinado de EPI — ficha de EPI — entrega nº 7");
    expect(tela).toContain(`<a class="quebra" href="/demandas/${d!.id}?de=pendencias">Demanda nº ${d!.id}</a>`);
    // a secretaria não tem `epi.ficha`: rótulo sem link
    expect(tela).toContain('<span class="discreto quebra">Ficha de EPI — entrega nº 7</span>');
    expect(tela).not.toContain("epi_ficha_registro #");
    expect(tela).not.toContain("Fulano de Tal");
    expect(tela).not.toContain("conteúdo suprimido");
    // quem lê nome lê a descrição gravada
    const coord = (await (await cliente("coordenador_csso")).get("/pendencias", HTML)).text;
    expect(coord).toContain("Responder Fulano de Tal sobre as luvas");
    expect(p.id && ficha.id).toBeTruthy();
  });

  it("o processo aparece pelo NUP, com link, para quem tem processo.ver", async () => {
    const c = await caso();
    const [proc] = await db.select().from(e.processo).where(eq(e.processo.id, c.processo_id));
    await pendencia({ tipo: "INCLUIR_NO_SEI", processo_id: c.processo_id, responsavel_id: coordenador.id });
    const tela = (await (await cliente("secretaria_csso")).get("/pendencias", HTML)).text;
    expect(tela).toContain(`<a class="quebra" href="/processos/${c.processo_id}?de=pendencias">Processo ${proc!.nup}</a>`);
    expect(tela).toContain(`Incluir o parecer assinado no SEI — processo ${proc!.nup}`);
  });

  it("a API lê o mesmo mapa", async () => {
    await pendencia({ tipo: "TROCA_EPI_DEVIDA", entidade: "epi_ficha_registro", entidade_id: 9, responsavel_id: coordenador.id });
    const sec = await cliente("secretaria_csso");
    const corpo = (await sec.get("/api/v1/pendencias")).json<{ itens: { descricao: string; onde: string | null; onde_rotulo: string | null; concluivel: boolean }[] }>();
    const linha = corpo.itens.find((i) => i.onde_rotulo === "Ficha de EPI — entrega nº 9");
    expect(linha).toBeTruthy();
    expect(linha!.onde).toBeNull();
    expect(linha!.descricao).not.toContain("Fulano");
    expect(linha!.concluivel).toBe(false);
  });
});

describe("M64 — o sino conta só as da própria pessoa", () => {
  it("o número do sino é o das pendências atribuídas à conta", async () => {
    const tec = await id_de("tecnico_seguranca");
    const [antes] = await pendencias.contar_abertas(db, await usuarioAtual(db, "tecnico_seguranca"), true);
    await pendencia({ tipo: "INCLUIR_NO_SEI", responsavel_id: tec });
    await pendencia({ tipo: "INCLUIR_NO_SEI", responsavel_id: coordenador.id });
    await pendencia({ tipo: "INCLUIR_NO_SEI", responsavel_id: coordenador.id });
    const tela = (await (await cliente("tecnico_seguranca")).get("/demandas", HTML)).text;
    expect(tela).toContain(`<span class="contador">${antes + 1}</span>`);
    expect(await pendencias.contar_abertas(db, await usuarioAtual(db, "tecnico_seguranca"), true)).toEqual([antes + 1, 0]);
  });
});

// =====================================================================
// Laudos
// =====================================================================
const FABRICIO = async () => {
  const [h] = await db.select().from(e.profissional_habilitado).where(eq(e.profissional_habilitado.nome, "Fabrício Raimundi Andrade"));
  return h!;
};
async function ids_de_cadastro() {
  const [tipo] = await db.select().from(e.tipo_adicional).where(eq(e.tipo_adicional.codigo, "INSALUBRIDADE"));
  const [unidade] = await db.select().from(e.unidade_uorg).where(eq(e.unidade_uorg.codigo_uorg, "250"));
  return { tipo_adicional_id: tipo!.id, unidade_uorg_id: unidade!.id, subscritor_id: (await FABRICIO()).id };
}

describe("D3/D10/M8 — cadastro do laudo", () => {
  it("número repetido volta à tela com o digitado, sem 500", async () => {
    const eng = await cliente("engenheiro_seguranca");
    const campos = { numero_siape: "26255-000.901/2026", data_emissao: "2026-01-10", ...(await ids_de_cadastro()) };
    const primeiro = await eng.post("/laudos", campos, { ...HTML, seguir: false });
    expect(primeiro.status).toBe(303);
    const segundo = await eng.post("/laudos", campos, HTML);
    expect(segundo.status).toBe(200);
    expect(segundo.text).toContain("Já existe laudo com este número.");
    expect(segundo.text).toContain('value="26255-000.901/2026"');
    const iguais = await db.select().from(e.laudo_tecnico).where(eq(e.laudo_tecnico.numero_siape, "26255-000.901/2026"));
    expect(iguais).toHaveLength(1);
  });

  it("emissão futura e ano futuro são recusados", async () => {
    const eng = await cliente("engenheiro_seguranca");
    const base = await ids_de_cadastro();
    const futura = await eng.post("/laudos", { numero_siape: "26255-000.902/2026", data_emissao: somar_dias(HOJE, 30), ...base }, HTML);
    expect(futura.status).toBe(200);
    expect(futura.text).toContain("Data de emissão");
    const ano = await eng.post("/laudos", { numero_siape: "26255-000.902/2031", data_emissao: "", ...base }, HTML);
    expect(ano.text).toContain("ainda não chegou");
    const criados = await db.select().from(e.laudo_tecnico).where(eq(e.laudo_tecnico.numero_siape, "26255-000.902/2031"));
    expect(criados).toHaveLength(0);
  });

  it("o subscritor é obrigatório e tem de estar habilitado", async () => {
    const eng = await cliente("engenheiro_seguranca");
    const { tipo_adicional_id, unidade_uorg_id } = await ids_de_cadastro();
    const r = await eng.post("/laudos", { numero_siape: "26255-000.903/2026", tipo_adicional_id, unidade_uorg_id, subscritor_id: "" }, HTML);
    expect(r.text).toContain("Escolha o subscritor do laudo");
    const [vencido] = await db
      .insert(e.profissional_habilitado)
      .values({ nome: "ZZ Habilitação Vencida", siape: "9999901", habilitacao: "ENG_SEG_TRABALHO", titulo_assinatura: "Eng.", vigencia_inicio: "2010-01-01", vigencia_fim: "2011-01-01" })
      .returning();
    const r2 = await eng.post("/laudos", { numero_siape: "26255-000.903/2026", tipo_adicional_id, unidade_uorg_id, subscritor_id: vencido!.id }, HTML);
    expect(r2.text).toContain("Escolha o subscritor do laudo");
    expect((await eng.get("/laudos", HTML)).text).not.toContain("ZZ Habilitação Vencida");
  });
});

describe("D10 — ações em laudo inexistente", () => {
  it("conferência e posto de laudo inexistente dão 404 e não gravam", async () => {
    const eng = await cliente("engenheiro_seguranca");
    const [posto] = await db.select().from(e.posto_trabalho).limit(1);
    expect((await eng.post("/laudos/999999/conferencia", { motivo: "x" }, { ...HTML, seguir: false })).status).toBe(404);
    expect((await eng.post("/laudos/999999/postos", { posto_trabalho_id: posto!.id }, { ...HTML, seguir: false })).status).toBe(404);
    expect((await eng.post("/laudos/999999/editar", {}, { ...HTML, seguir: false })).status).toBe(404);
  });

  it("superar pede laudo.criar na primeira linha", async () => {
    const c = await caso();
    const sec = await cliente("secretaria_csso");
    expect((await sec.post(`/laudos/${c.laudo_id}/superar`, {}, { ...HTML, seguir: false })).status).toBe(403);
  });
});

describe("M8 — editar os dados do laudo e desvincular posto", () => {
  it("grava data, avaliação e nº SEI, e a trilha guarda cada campo", async () => {
    const c = await caso();
    const eng = await cliente("engenheiro_seguranca");
    const r = await eng.post(
      `/laudos/${c.laudo_id}/editar`,
      { data_emissao: "2019-06-01", data_avaliacao: "2019-05-20", subscritor_id: (await FABRICIO()).id, numero_documento_sei: "0123456" },
      HTML,
    );
    expect(r.text).toContain("Laudo: alteração gravada.");
    const [laudo] = await db.select().from(e.laudo_tecnico).where(eq(e.laudo_tecnico.id, c.laudo_id));
    expect([laudo!.data_avaliacao, laudo!.numero_documento_sei]).toEqual(["2019-05-20", "0123456"]);
    const trilha = await db
      .select()
      .from(e.historico_evento)
      .where(and(eq(e.historico_evento.entidade, "laudo_tecnico"), eq(e.historico_evento.entidade_id, c.laudo_id)));
    expect(trilha.map((t) => t.campo)).toEqual(expect.arrayContaining(["data_avaliacao", "numero_documento_sei"]));
  });

  it("avaliação depois da emissão e data futura são recusadas", async () => {
    const c = await caso();
    const eng = await cliente("engenheiro_seguranca");
    const sub = (await FABRICIO()).id;
    const r = await eng.post(`/laudos/${c.laudo_id}/editar`, { data_emissao: "2019-06-01", data_avaliacao: "2019-07-01", subscritor_id: sub }, HTML);
    expect(r.text).toContain("A avaliação do ambiente vem antes da emissão");
    const r2 = await eng.post(`/laudos/${c.laudo_id}/editar`, { data_emissao: somar_dias(HOJE, 3), subscritor_id: sub }, HTML);
    expect(r2.text).toContain("Data de emissão");
    const [laudo] = await db.select().from(e.laudo_tecnico).where(eq(e.laudo_tecnico.id, c.laudo_id));
    expect(laudo!.data_emissao).toBe("2019-06-01");
  });

  it("a secretaria não edita", async () => {
    const c = await caso();
    expect((await (await cliente("secretaria_csso")).post(`/laudos/${c.laudo_id}/editar`, {}, { ...HTML, seguir: false })).status).toBe(403);
  });

  it("vincular e desvincular posto, com a trilha", async () => {
    const c = await caso();
    const eng = await cliente("engenheiro_seguranca");
    const [posto] = await db.select().from(e.posto_trabalho).limit(1);
    expect((await eng.post(`/laudos/${c.laudo_id}/postos`, { posto_trabalho_id: posto!.id }, HTML)).text).toContain("Posto vinculado.");
    const ficha = (await eng.get(`/laudos/${c.laudo_id}`, HTML)).text;
    expect(ficha).toContain(`href="#desvincular-posto-${posto!.id}"`);
    expect(ficha).toContain(`/laudos/${c.laudo_id}/postos/${posto!.id}/desvincular`);
    const r = await eng.post(`/laudos/${c.laudo_id}/postos/${posto!.id}/desvincular`, {}, HTML);
    expect(r.text).toContain("Posto desvinculado.");
    expect(await db.select().from(e.laudo_posto).where(eq(e.laudo_posto.laudo_id, c.laudo_id))).toHaveLength(0);
    const tipos = (
      await db
        .select()
        .from(e.historico_evento)
        .where(and(eq(e.historico_evento.entidade, "laudo_tecnico"), eq(e.historico_evento.entidade_id, c.laudo_id)))
    ).map((t) => t.tipo_evento);
    expect(tipos).toEqual(expect.arrayContaining(["LAUDO_POSTO_VINCULADO", "LAUDO_POSTO_DESVINCULADO"]));
  });
});

describe("M9 — as ações no cartão e a confirmação de superar", () => {
  it("superar com parecer derivado pede a caixa de ciência", async () => {
    const c = await caso();
    const ficha = (await (await cliente("engenheiro_seguranca")).get(`/laudos/${c.laudo_id}`, HTML)).text;
    expect(ficha).toContain('href="#superar-laudo"');
    expect(ficha).toContain('name="ciente" value="1" required');
    expect(ficha).toContain("Entendo que 1 parecer(es) vão para reavaliação.");
  });

  it("revisão: sem a caixa de ciência o POST não supera, e com ela supera", async () => {
    const c = await caso();
    const eng = await cliente("engenheiro_seguranca");
    const sem = await eng.post(`/laudos/${c.laudo_id}/superar`, { motivo: "obra no bloco" }, { ...HTML, seguir: false });
    expect(sem.status).toBe(303);
    expect(decodeURIComponent(sem.location!)).toContain("Marque a caixa de ciência");
    const [ainda] = await db.select().from(e.laudo_tecnico).where(eq(e.laudo_tecnico.id, c.laudo_id));
    expect(ainda!.status).toBe("VIGENTE");
    const com = await eng.post(`/laudos/${c.laudo_id}/superar`, { motivo: "obra no bloco", ciente: "1" }, { ...HTML, seguir: false });
    expect(decodeURIComponent(com.location!)).toContain("1 parecer(es) em reavaliação");
    const [depois] = await db.select().from(e.laudo_tecnico).where(eq(e.laudo_tecnico.id, c.laudo_id));
    expect(depois!.status).toBe("SUPERADO");
  });
});

// =====================================================================
// Adicionais
// =====================================================================
async function vigencia_vigente() {
  const c = await caso();
  await db.update(e.parecer_tecnico).set({ situacao: "EMITIDO", numero: 900 + seq }).where(eq(e.parecer_tecnico.id, c.parecer_id));
  const v = await direito.propor(db, await parecerDe(db, c.parecer_id), coordenador);
  await db
    .update(e.adicional_vigencia)
    .set({ estado: "VIGENTE", data_inicio: "2024-09-17", portaria_concessao: "PORTARIA/PROGEP Nº 1" })
    .where(eq(e.adicional_vigencia.id, v.id));
  return { c, v };
}

describe("M10/M11/M61 — adicionais", () => {
  it("M11: propor de novo diz que já há direito", async () => {
    const c = await caso();
    await db.update(e.parecer_tecnico).set({ situacao: "EMITIDO", numero: 950 + seq }).where(eq(e.parecer_tecnico.id, c.parecer_id));
    const coord = await cliente("coordenador_csso");
    expect((await coord.post(`/adicionais/propor/${c.parecer_id}`, {}, HTML)).text).toContain("Direito proposto");
    expect((await coord.post(`/adicionais/propor/${c.parecer_id}`, {}, HTML)).text).toContain("Este parecer já tem direito registrado.");
  });

  it("M61: sem parecer.emitir é 403, e não 422 sobre o formulário", async () => {
    const { v } = await vigencia_vigente();
    const sec = await cliente("secretaria_csso");
    for (const acao of ["conceder", "suspender", "cessar", "retomar", "alterar"]) {
      expect((await sec.post(`/adicionais/${v.id}/${acao}`, {}, { ...HTML, seguir: false })).status, acao).toBe(403);
    }
    expect((await sec.post(`/adicionais/propor/1`, {}, { ...HTML, seguir: false })).status).toBe(403);
  });

  it("M10: o percentual novo é do mesmo adicional, e não o atual", async () => {
    const { v } = await vigencia_vigente();
    const coord = await cliente("coordenador_csso");
    const [outro_tipo] = await db
      .select()
      .from(e.percentual_aplicavel)
      .innerJoin(e.tipo_adicional, eq(e.percentual_aplicavel.tipo_adicional_id, e.tipo_adicional.id))
      .where(eq(e.tipo_adicional.codigo, "PERICULOSIDADE"));
    const r = await coord.post(`/adicionais/${v.id}/alterar`, { percentual_id: outro_tipo!.percentual_aplicavel.id, motivo: "x" }, HTML);
    expect(r.text).toContain("mesmo tipo de adicional");
    const r2 = await coord.post(`/adicionais/${v.id}/alterar`, { percentual_id: v.percentual_id, motivo: "x" }, HTML);
    expect(r2.text).toContain("já é o percentual atual");
    const [linha] = await db.select().from(e.adicional_vigencia).where(eq(e.adicional_vigencia.id, v.id));
    expect(linha!.estado).toBe("VIGENTE");
    // a camada mostra o atual e só os do mesmo tipo
    const tela = (await coord.get("/adicionais", HTML)).text;
    const inicio = tela.indexOf(`id="perc-${v.id}"`);
    const trecho = tela.slice(inicio, tela.indexOf("</select>", inicio));
    expect(trecho).not.toContain(`value="${outro_tipo!.percentual_aplicavel.id}"`);
    expect(trecho).not.toContain(`value="${v.percentual_id}"`);
    expect(tela).toContain("Percentual atual:");
    expect(tela).toContain("Confirmo a cessação deste adicional.");
  });
});

describe("M58 — o titular lê o próprio adicional num cartão", () => {
  it("a frase no lugar da tabela, sem filtros nem coluna de ações", async () => {
    const { c } = await vigencia_vigente();
    await db.update(e.usuario).set({ servidor_id: c.servidor_id }).where(eq(e.usuario.login, "servidor_consulta"));
    // os próprios processos e o adicional só com a exceção da pessoa (25/10/2026)
    await liberarProcessos(db, "servidor_consulta");
    try {
      const tela = (await (await cliente("servidor_consulta")).get("/adicionais", HTML)).text;
      expect(tela).toContain("cartao-resumo");
      expect(tela).toContain("Você recebe");
      expect(tela).toContain("desde 17/09/2024");
      expect(tela).not.toContain('<th scope="col">Ações</th>');
      expect(tela).not.toContain("?estado=PROPOSTO");
    } finally {
      await db.update(e.usuario).set({ servidor_id: null }).where(eq(e.usuario.login, "servidor_consulta"));
      await liberarProcessos(db, "servidor_consulta", false);
    }
  });
});

// =====================================================================
// Editor do parecer
// =====================================================================
describe("D4/M79 — o editor de quem não edita", () => {
  it("a secretaria vê o rascunho desligado, sem botão que grava", async () => {
    const c = await caso();
    const tela = (await (await cliente("secretaria_csso")).get(`/pareceres/${c.parecer_id}`, HTML)).text;
    expect(tela).toContain('<fieldset class="campos" disabled>');
    expect(tela).toContain("Somente leitura.");
    expect(tela).not.toContain("Salvar rascunho</button>");
    expect(tela).not.toContain('href="#nova-exposicao"');
    expect(tela).not.toContain('href="#remover-exposicao-');
    expect(tela).not.toContain('id="nova-exposicao"');
  });

  it("o titular lê a prévia, sem o editor nem a validação", async () => {
    const c = await caso();
    await db.update(e.usuario).set({ servidor_id: c.servidor_id }).where(eq(e.usuario.login, "servidor_consulta"));
    // os próprios processos e o adicional só com a exceção da pessoa (25/10/2026)
    await liberarProcessos(db, "servidor_consulta");
    try {
      const tela = (await (await cliente("servidor_consulta")).get(`/pareceres/${c.parecer_id}`, HTML)).text;
      expect(tela).toContain("Ainda não emitido.");
      expect(tela).not.toContain("<h2>Validação</h2>");
      expect(tela).not.toContain("pronto para emitir");
      expect(tela).not.toContain('<fieldset class="campos"');
    } finally {
      await db.update(e.usuario).set({ servidor_id: null }).where(eq(e.usuario.login, "servidor_consulta"));
      await liberarProcessos(db, "servidor_consulta", false);
    }
  });

  it("quem não lê o nome é avisado de que o documento o traz", async () => {
    const c = await caso();
    await db.update(e.parecer_tecnico).set({ numero: 980 + seq }).where(eq(e.parecer_tecnico.id, c.parecer_id));
    const tela = (await (await cliente("secretaria_csso")).get(`/pareceres/${c.parecer_id}`, HTML)).text;
    expect(tela).toContain("O documento traz o nome do servidor; o download fica registrado.");
    const coord = (await (await cliente("coordenador_csso")).get(`/pareceres/${c.parecer_id}`, HTML)).text;
    expect(coord).not.toContain("O documento traz o nome do servidor");
  });

  it("D4: o POST de quem não edita continua 403", async () => {
    const c = await caso();
    const r = await (await cliente("secretaria_csso")).post(`/pareceres/${c.parecer_id}`, { ano: "2025" }, { ...HTML, seguir: false });
    expect(r.status).toBe(403);
  });
});

describe("M61 — assinar: 403 a quem nem lê, ASSINATURA_NEGADA a quem lê e não assina", () => {
  it("revisão: sem parecer.ver é 403 sem trilha; secretaria é 403 com a recusa registrada", async () => {
    const c = await caso();
    await db.update(e.parecer_tecnico).set({ situacao: "EMITIDO", numero: 960 + seq }).where(eq(e.parecer_tecnico.id, c.parecer_id));
    const negadas = async () =>
      (
        await db
          .select()
          .from(e.historico_evento)
          .where(and(eq(e.historico_evento.tipo_evento, "ASSINATURA_NEGADA"), eq(e.historico_evento.entidade_id, c.parecer_id)))
      ).length;
    const sem = await (await cliente("almoxarife_sesmt")).post(`/pareceres/${c.parecer_id}/assinar`, {}, { ...HTML, seguir: false });
    expect(sem.status).toBe(403);
    expect(await negadas()).toBe(0);
    const sec = await (await cliente("secretaria_csso")).post(`/pareceres/${c.parecer_id}/assinar`, {}, { ...HTML, seguir: false });
    expect(sec.status).toBe(403);
    expect(await negadas()).toBe(1);
  });
});

describe("D6 — o modelo de recomendação sem exposição principal", () => {
  it("salva o resto e diz o que falta, em vez de ignorar", async () => {
    const c = await caso();
    await db.delete(e.exposicao).where(eq(e.exposicao.parecer_id, c.parecer_id));
    await db.update(e.parecer_tecnico).set({ texto_recomendacao: null }).where(eq(e.parecer_tecnico.id, c.parecer_id));
    const parecer = await parecerDe(db, c.parecer_id);
    const [modelo] = await db.select().from(e.texto_padrao).where(eq(e.texto_padrao.categoria, "RECOMENDACAO")).limit(1);
    const coord = await cliente("coordenador_csso");
    const r = await coord.post(
      `/pareceres/${c.parecer_id}`,
      {
        versao_lida: parecer.versao,
        ano: parecer.ano,
        tipo_adicional_id: parecer.tipo_adicional_id!,
        tipo_marco_id: parecer.tipo_marco_id!,
        portaria_id: parecer.portaria_id!,
        data_marco_inicial: "2024-09-17",
        recomendacao_modelo: modelo!.codigo,
        texto_alteracao: "ZZ alteração gravada",
      },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    expect(decodeURIComponent(r.location!)).toContain("Adicione a exposição principal antes de aplicar o modelo de recomendação.");
    const [gravado] = await db.select().from(e.parecer_tecnico).where(eq(e.parecer_tecnico.id, c.parecer_id));
    expect(gravado!.texto_alteracao).toBe("ZZ alteração gravada");
    expect(gravado!.texto_recomendacao).toBeNull();
  });
});

describe("M6 — o seletor de laudo", () => {
  it("superados à parte, e o vigente da unidade sugerido", async () => {
    const c = await caso();
    const outro = await caso();
    await db.update(e.laudo_tecnico).set({ status: "SUPERADO" }).where(eq(e.laudo_tecnico.id, outro.laudo_id));
    await db.update(e.parecer_tecnico).set({ laudo_id: null }).where(eq(e.parecer_tecnico.id, c.parecer_id));
    const tela = (await (await cliente("coordenador_csso")).get(`/pareceres/${c.parecer_id}`, HTML)).text;
    expect(tela).toContain('<optgroup label="Superados">');
    expect(tela).toContain('<optgroup label="Sugerido — unidade do processo">');
    const sup = tela.indexOf('<optgroup label="Superados">');
    const [laudo_outro] = await db.select().from(e.laudo_tecnico).where(eq(e.laudo_tecnico.id, outro.laudo_id));
    expect(tela.indexOf(laudo_outro!.numero_siape, sup)).toBeGreaterThan(sup);
    // a ordem das seções é a do trabalho
    expect(tela.indexOf("<h2>Objeto</h2>")).toBeLessThan(tela.indexOf("<h2>Exposições</h2>"));
    expect(tela.indexOf("<h2>Exposições</h2>")).toBeLessThan(tela.indexOf("<h2>Marco inicial</h2>"));
    expect(tela.indexOf("<h2>Marco inicial</h2>")).toBeLessThan(tela.indexOf("<h2>Textos</h2>"));
  });
});

// =====================================================================
// Relatórios
// =====================================================================
describe("D5/M12/M13 — relatórios", () => {
  it("D5: vigentes por laudo passa pela supressão para quem não lê nome", async () => {
    const { c } = await vigencia_vigente();
    const [laudo] = await db.select().from(e.laudo_tecnico).where(eq(e.laudo_tecnico.id, c.laudo_id));
    const sec = (await (await cliente("secretaria_csso")).get("/relatorios", HTML)).text;
    const inicio = sec.indexOf("Adicionais vigentes por laudo");
    const trecho = sec.slice(inicio, sec.indexOf("</table>", inicio));
    expect(trecho).toContain(laudo!.numero_siape);
    expect(trecho).toMatch(new RegExp(`${laudo!.numero_siape.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}</td>\\s*<td class="numerico"><span title="menos de 5`));
  });

  it("M12: o cartão renomeado, sem o texto anedótico, e o anulado fora", async () => {
    const tela = (await (await cliente("coordenador_csso")).get("/relatorios?exercicio=2025", HTML)).text;
    expect(tela).toContain("Laudos nunca conferidos ou há mais de 24 meses");
    expect(tela).not.toContain("foi exatamente");
    const antes = /Pareceres por tipo de risco[\s\S]*?<\/section>/.exec(tela)![0];
    const c = await caso();
    await db.update(e.parecer_tecnico).set({ situacao: "ANULADO", motivo_anulacao: "teste" }).where(eq(e.parecer_tecnico.id, c.parecer_id));
    const depois = /Pareceres por tipo de risco[\s\S]*?<\/section>/.exec(
      (await (await cliente("coordenador_csso")).get("/relatorios?exercicio=2025", HTML)).text,
    )![0];
    expect(depois).toBe(antes);
  });

  it("M13: o CSV sai com o rótulo do estado e a data em dd/mm/aaaa", async () => {
    const c = await caso();
    await db.update(e.processo).set({ estado_tecnico: "AGUARDANDO_QUANTIFICACAO" }).where(eq(e.processo.id, c.processo_id));
    const csv = (await (await cliente("coordenador_csso")).get("/relatorios/exportar-processos")).text;
    expect(csv).toContain("Aguardando quantificação");
    expect(csv).not.toContain("AGUARDANDO_QUANTIFICACAO");
    expect(csv).toContain("01/10/2024");
    expect(csv).not.toContain("2024-10-01");
  });
});
