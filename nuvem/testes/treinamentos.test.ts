/**
 * Fatia 1 de Certificados e Treinamentos: catálogo, modelos e assinaturas.
 * Porte de `testes/integracao/test_treinamentos.py`.
 *
 * O Python tinha banco novo por teste (fixture `banco`); aqui cada teste pede
 * um banco limpo no `beforeEach` (clone do modelo — é barato).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { AssinaturaInstrutor, CertificadoModelo, Treinamento } from "../src/dominio/treinamento.js";
import * as modulos from "../src/modulos.js";
import type { Banco } from "../src/db/cliente.js";
import postgres from "postgres";
import { bancoLimpo, contas, entrar, type Cliente, type Resposta } from "./ajuda";
import { urlServidor } from "./modelo.js";

let amb = await bancoLimpo();
let db: Banco = amb.db;
let cliente: Cliente = amb.cliente;

beforeEach(async () => {
  const anterior = amb.nome;
  amb = await bancoLimpo();
  // o banco do teste anterior sai já: deixar ~60 para o afterAll estourava o
  // tempo do gancho
  const admin = postgres(urlServidor(), { max: 1, prepare: false, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${anterior} WITH (FORCE)`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  db = amb.db;
  cliente = amb.cliente;
  await contas(db);
});

const NR35: Record<string, string> = {
  codigo: "NR-35",
  nome: "Trabalho em Altura — NR-35",
  carga_horaria_horas: "8",
  validade_meses: "24",
  norma_referencia: "NR-35",
  conteudo_programatico: "Análise de risco\nEquipamentos\nResgate",
};

function _criar(dados: Record<string, string> = {}) {
  return cliente.post("/treinamentos/catalogo", { ...NR35, ...dados }, { seguir: false });
}

async function _id_do_treinamento(codigo = "NR-35"): Promise<number> {
  const [t] = await db.select().from(e.treinamento).where(eq(e.treinamento.codigo, codigo));
  return t!.id;
}

async function _treinamento(id: number) {
  const [t] = await db.select().from(e.treinamento).where(eq(e.treinamento.id, id));
  return t!;
}

/** Salva a linha do catálogo como a tela salva: todos os campos de uma vez. */
function _editar_treinamento(alvo: number, dados: Record<string, string> = {}) {
  const campos = { nome: "Trabalho em Altura — NR-35", carga_horaria_horas: "8", validade_meses: "24", ativo: "1" };
  return cliente.post(`/treinamentos/catalogo/${alvo}`, { ...campos, ...dados }, { seguir: false });
}

async function _modelo(id: number) {
  const m = await db.query.certificado_modelo.findFirst({
    where: eq(e.certificado_modelo.id, id),
    with: { tags: { orderBy: (t, { asc: a }) => [a(t.ordem), a(t.id)] } },
  });
  return m!;
}

const coord = () => entrar(cliente, "coordenador_csso");

// =====================================================================
// Catálogo
// =====================================================================
describe("catálogo", () => {
  it("cadastrar treinamento", async () => {
    await coord();
    expect((await _criar()).status).toBe(303);
    const [t] = await db.select().from(e.treinamento).where(eq(e.treinamento.codigo, "NR-35"));
    expect(t!.nome).toBe("Trabalho em Altura — NR-35");
    expect(t!.validade_meses).toBe(24);
    expect(Treinamento.topicos(t!)).toEqual(["Análise de risco", "Equipamentos", "Resgate"]);
    // o cadastro entra na trilha, como qualquer catálogo
    const eventos = await db
      .select()
      .from(e.historico_evento)
      .where(and(eq(e.historico_evento.entidade, "treinamento"), eq(e.historico_evento.tipo_evento, "TREINAMENTO_CRIADO")));
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.descricao).toContain("NR-35");
  });

  it("editar treinamento registra diff campo a campo", async () => {
    await coord();
    await _criar();
    const alvo = await _id_do_treinamento();
    const resposta = await cliente.post(
      `/treinamentos/catalogo/${alvo}`,
      {
        nome: "Trabalho em Altura (NR-35)",
        carga_horaria_horas: "16",
        validade_meses: "24",
        norma_referencia: "NR-35",
        conteudo_programatico: NR35.conteudo_programatico!,
        ativo: "1",
      },
      { seguir: false },
    );
    expect(resposta.status).toBe(303);
    const t = await _treinamento(alvo);
    expect(t.nome).toBe("Trabalho em Altura (NR-35)");
    expect(Number(t.carga_horaria_horas)).toBe(16);
    const diffs = Object.fromEntries(
      (
        await db
          .select()
          .from(e.historico_evento)
          .where(and(eq(e.historico_evento.entidade, "treinamento"), eq(e.historico_evento.tipo_evento, "CAMPO_ALTERADO")))
      ).map((ev) => [ev.campo, [ev.valor_anterior, ev.valor_novo]]),
    );
    expect(diffs.nome).toEqual(["Trabalho em Altura — NR-35", "Trabalho em Altura (NR-35)"]);
    expect("carga_horaria_horas" in diffs).toBe(true);
    // campo que não mudou não vira evento
    expect("norma_referencia" in diffs).toBe(false);
  });

  it("código não é editável", async () => {
    await coord();
    await _criar();
    const alvo = await _id_do_treinamento();
    await cliente.post(
      `/treinamentos/catalogo/${alvo}`,
      { codigo: "OUTRO", nome: "Trabalho em Altura — NR-35", carga_horaria_horas: "8", validade_meses: "24", ativo: "1" },
      { seguir: false },
    );
    expect((await _treinamento(alvo)).codigo).toBe("NR-35");
  });

  it("treinamento repetido é recusado", async () => {
    await coord();
    await _criar();
    const repetido = await cliente.post("/treinamentos/catalogo", NR35);
    expect(repetido.text).toContain("Já existe treinamento");
  });

  it("código inválido é recusado (a recusa devolve a tela, não redireciona)", async () => {
    await coord();
    const resposta = await _criar({ codigo: "nr 35!" });
    expect(resposta.status).toBe(200);
    expect(resposta.text).toContain("Código inválido");
  });
});

// ---------------------------------------------------------------------
// A validade da reciclagem
// ---------------------------------------------------------------------
describe("validade da reciclagem", () => {
  it("validade zero significa não expira", async () => {
    await coord();
    await _criar({ codigo: "INTEGRACAO", nome: "Integração de novos servidores", validade_meses: "0", norma_referencia: "" });
    const t = await _treinamento(await _id_do_treinamento("INTEGRACAO"));
    expect(t.validade_meses).toBe(0);
    expect(Treinamento.expira(t)).toBe(false);
    expect(Treinamento.validade_rotulo(t)).toBe("não expira");
    const corpo = (await cliente.get("/treinamentos/catalogo")).text;
    expect(corpo.includes("0 = não expira") || corpo.includes("não expira")).toBe(true);
  });

  it.each([
    [0, "não expira"],
    [12, "1 ano"],
    [24, "2 anos"],
    [18, "18 meses"],
  ])("rótulo da validade %i -> %s", (meses, esperado) => {
    expect(Treinamento.validade_rotulo({ validade_meses: meses })).toBe(esperado);
  });

  it.each(["-1", "doze", "2,5"])("validade inválida %s é recusada", async (valor) => {
    await coord();
    const resposta = await _criar({ codigo: "CURSO", nome: `Curso ${valor}`, validade_meses: valor });
    expect(resposta.text).toContain("Validade inválida");
  });

  it("validade em branco é recusada no cadastro", async () => {
    await coord();
    const resposta = await _criar({ codigo: "SEMPRAZO", nome: "Curso sem prazo", validade_meses: "" });
    expect(resposta.text).toContain("Validade inválida");
    // e o que foi digitado voltou: a recusa renderiza, não redireciona
    expect(resposta.text).toContain('value="SEMPRAZO"');
    expect(await db.select().from(e.treinamento).where(eq(e.treinamento.codigo, "SEMPRAZO"))).toEqual([]);
  });

  it("validade apagada na edição não vira não expira", async () => {
    await coord();
    await _criar();
    const alvo = await _id_do_treinamento();
    const resposta = await _editar_treinamento(alvo, { carga_horaria_horas: "16", validade_meses: "" });
    expect(resposta.status).toBe(303);
    expect((await cliente.get(resposta.location!)).text).toContain("Validade inválida");
    const t = await _treinamento(alvo);
    expect(t.validade_meses).toBe(24);
    // recusa é recusa: nada da edição entrou
    expect(Number(t.carga_horaria_horas)).toBe(8);
  });

  it("validade zero explícito continua valendo na edição", async () => {
    await coord();
    await _criar();
    const alvo = await _id_do_treinamento();
    expect((await _editar_treinamento(alvo, { validade_meses: "0" })).status).toBe(303);
    const t = await _treinamento(alvo);
    expect(t.validade_meses === 0 && !Treinamento.expira(t)).toBe(true);
  });

  it("carga horária aceita vírgula e recusa zero", async () => {
    await coord();
    await _criar({ codigo: "CIPA", nome: "CIPA", carga_horaria_horas: "4,5" });
    expect(Number((await _treinamento(await _id_do_treinamento("CIPA"))).carga_horaria_horas)).toBe(4.5);
    const zerada = await _criar({ codigo: "ZERO", nome: "Curso sem carga", carga_horaria_horas: "0" });
    expect(zerada.text).toContain("Carga horária inválida");
  });
});

// =====================================================================
// Modelo de certificado e o dicionário de tags
// =====================================================================
function _criar_modelo(nome = "Certificado padrão CSSO", extra: Record<string, string> = {}) {
  return cliente.post(
    "/treinamentos/modelos",
    { nome, arquivo: "certificado_padrao.docx", orientacao: "PAISAGEM", ...extra },
    { seguir: false },
  );
}

function _id_do_modelo(resposta: Resposta): number {
  return Number(resposta.location!.split("/")[3]!.split("?")[0]);
}

describe("modelo e dicionário de tags", () => {
  it("dicionário de tags pertence ao modelo", async () => {
    await coord();
    const modelo_id = _id_do_modelo(await _criar_modelo());
    for (const [marcador, campo] of [
      ["nome_do_aluno", "participante_nome"],
      ["curso", "treinamento_nome"],
    ]) {
      const resposta = await cliente.post(
        `/treinamentos/modelos/${modelo_id}/tags`,
        { marcador: marcador!, campo: campo!, ordem: "1", obrigatorio: "1" },
        { seguir: false },
      );
      expect(resposta.status).toBe(303);
    }
    const modelo = await _modelo(modelo_id);
    expect(CertificadoModelo.mapa_de_tags(modelo)).toEqual({
      nome_do_aluno: "participante_nome",
      curso: "treinamento_nome",
    });
    expect(modelo.tags.every((t) => t.modelo_id === modelo_id)).toBe(true);
    expect(
      await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "MODELO_TAG_MAPEADA")),
    ).not.toEqual([]);
    const ficha = (await cliente.get(`/treinamentos/modelos/${modelo_id}`)).text;
    expect(ficha).toContain("nome_do_aluno");
    // o arquivo .docx não existe: a tela diz isso em vez de fingir que conferiu
    expect(ficha).toContain("arquivo ausente");
  });

  it("campo desconhecido é recusado", async () => {
    await coord();
    const modelo_id = _id_do_modelo(await _criar_modelo());
    const resposta = await cliente.post(`/treinamentos/modelos/${modelo_id}/tags`, { marcador: "qualquer", campo: "cpf_do_aluno" });
    expect(resposta.text).toContain("Campo desconhecido");
    expect(await db.select().from(e.certificado_modelo_tag)).toEqual([]);
  });

  it("marcador inválido é recusado", async () => {
    await coord();
    const modelo_id = _id_do_modelo(await _criar_modelo());
    const resposta = await cliente.post(`/treinamentos/modelos/${modelo_id}/tags`, {
      marcador: "nome do aluno",
      campo: "participante_nome",
    });
    expect(resposta.text).toContain("Marcador inválido");
  });

  it("marcador repetido no mesmo modelo é recusado", async () => {
    await coord();
    const modelo_id = _id_do_modelo(await _criar_modelo());
    const dados = { marcador: "curso", campo: "treinamento_nome" };
    await cliente.post(`/treinamentos/modelos/${modelo_id}/tags`, dados);
    const repetido = await cliente.post(`/treinamentos/modelos/${modelo_id}/tags`, dados);
    expect(repetido.text).toContain("já está mapeado");
  });

  it("nova versão leva o mapa junto e aposenta a anterior", async () => {
    await coord();
    const modelo_id = _id_do_modelo(await _criar_modelo());
    await cliente.post(`/treinamentos/modelos/${modelo_id}/tags`, { marcador: "curso", campo: "treinamento_nome", obrigatorio: "1" });
    const resposta = await cliente.post(`/treinamentos/modelos/${modelo_id}/versao`, {}, { seguir: false });
    expect(resposta.status).toBe(303);
    const antiga = await _modelo(modelo_id);
    expect(antiga.vigente).toBe(false);
    const [nova_linha] = await db.select().from(e.certificado_modelo).where(eq(e.certificado_modelo.versao, 2));
    const nova = await _modelo(nova_linha!.id);
    expect(CertificadoModelo.mapa_de_tags(nova)).toEqual({ curso: "treinamento_nome" });
    expect(nova.id).not.toBe(antiga.id);
    // versão superada é o layout de certificados já emitidos: não se edita
    const recusa = await cliente.post(`/treinamentos/modelos/${modelo_id}/tags`, { marcador: "outro", campo: "cidade" });
    expect(recusa.text).toContain("não se edita");
  });

  it("modelo repetido manda versionar", async () => {
    await coord();
    await _criar_modelo();
    const repetido = await cliente.post("/treinamentos/modelos", { nome: "Certificado padrão CSSO", arquivo: "outro.docx" });
    expect(repetido.text).toContain("publique uma nova versão");
  });

  it("versão superada não publica outra versão", async () => {
    await coord();
    const v1 = _id_do_modelo(await _criar_modelo());
    await cliente.post(`/treinamentos/modelos/${v1}/tags`, { marcador: "aluno", campo: "participante_nome" });
    const v2 = _id_do_modelo(await cliente.post(`/treinamentos/modelos/${v1}/versao`, {}, { seguir: false }));
    await cliente.post(`/treinamentos/modelos/${v2}/tags`, { marcador: "instrutor", campo: "assinante_nome" });
    const recusa = await cliente.post(`/treinamentos/modelos/${v1}/versao`);
    expect(recusa.text).toContain("não se edita");
    const versoes = await db.select().from(e.certificado_modelo).orderBy(asc(e.certificado_modelo.versao));
    expect(versoes.map((m) => m.versao)).toEqual([1, 2]);
    const vigentes = versoes.filter((m) => m.vigente);
    expect(vigentes).toHaveLength(1);
    expect(vigentes[0]!.id).toBe(v2);
    expect(CertificadoModelo.mapa_de_tags(await _modelo(v2))).toEqual({
      aluno: "participante_nome",
      instrutor: "assinante_nome",
    });
  });

  it("renomear modelo para nome já usado é recusado", async () => {
    await coord();
    await _criar();
    const curso = await _id_do_treinamento();
    await _criar_modelo("Alfa", { treinamento_id: String(curso) });
    const beta = _id_do_modelo(await _criar_modelo("Beta", { treinamento_id: String(curso) }));
    const recusa = await cliente.post(`/treinamentos/modelos/${beta}`, {
      nome: "Alfa",
      arquivo: "certificado_padrao.docx",
      treinamento_id: String(curso),
      orientacao: "PAISAGEM",
    });
    expect(recusa.status).toBe(200);
    expect(recusa.text.toLowerCase()).toContain("já existe");
    expect((await _modelo(beta)).nome).toBe("Beta");
  });

  it("renomear modelo genérico para nome já usado é recusado", async () => {
    await coord();
    await _criar_modelo("Alfa");
    const beta = _id_do_modelo(await _criar_modelo("Beta"));
    const recusa = await cliente.post(`/treinamentos/modelos/${beta}`, {
      nome: "Alfa",
      arquivo: "certificado_padrao.docx",
      orientacao: "PAISAGEM",
    });
    expect(recusa.text.toLowerCase()).toContain("já existe");
    const nomes = (await db.select().from(e.certificado_modelo)).map((m) => m.nome).sort();
    expect(nomes).toEqual(["Alfa", "Beta"]);
  });

  it("editar modelo também exige .docx", async () => {
    await coord();
    const modelo_id = _id_do_modelo(await _criar_modelo());
    const recusa = await cliente.post(`/treinamentos/modelos/${modelo_id}`, {
      nome: "Certificado padrão CSSO",
      arquivo: "../../../dados/csso.db",
      orientacao: "PAISAGEM",
    });
    expect(recusa.text).toContain(".docx");
    expect((await _modelo(modelo_id)).arquivo).toBe("certificado_padrao.docx");
  });

  it("modelo guarda só o nome do arquivo", async () => {
    await coord();
    const modelo_id = _id_do_modelo(await _criar_modelo("Com caminho", { arquivo: "modelos/antigo/padrao.docx" }));
    expect((await _modelo(modelo_id)).arquivo).toBe("padrao.docx");
  });

  it("ordem apagada na linha da tag mantém a ordem de hoje", async () => {
    await coord();
    const modelo_id = _id_do_modelo(await _criar_modelo());
    for (const [marcador, campo, ordem] of [
      ["aluno", "participante_nome", "1"],
      ["curso", "treinamento_nome", "2"],
    ]) {
      await cliente.post(`/treinamentos/modelos/${modelo_id}/tags`, { marcador: marcador!, campo: campo!, ordem: ordem! });
    }
    const [segunda] = await db.select().from(e.certificado_modelo_tag).where(eq(e.certificado_modelo_tag.marcador, "curso"));
    await cliente.post(`/treinamentos/modelos/${modelo_id}/tags/${segunda!.id}`, {
      campo: "treinamento_nome",
      ordem: "",
      obrigatorio: "1",
    });
    const [depois] = await db.select().from(e.certificado_modelo_tag).where(eq(e.certificado_modelo_tag.id, segunda!.id));
    expect(depois!.ordem).toBe(2);
  });
});

// =====================================================================
// O modelo vigente e o instrutor padrão da linha do catálogo
// =====================================================================
function _opcoes(html: string, form_id: string, campo: string): string[] {
  const bloco = new RegExp(`<select form="${form_id}" name="${campo}">([\\s\\S]*?)</select>`).exec(html);
  expect(bloco, `a tela não tem o seletor ${campo} de ${form_id}`).not.toBeNull();
  return [...bloco![1]!.matchAll(/value="([^"]*)"/g)].map((m) => m[1]!);
}

async function _dois_treinamentos(): Promise<[number, number]> {
  await _criar();
  await _criar({ codigo: "BRIGADA", nome: "Brigada de Incêndio" });
  return [await _id_do_treinamento(), await _id_do_treinamento("BRIGADA")];
}

describe("vínculos da linha do catálogo", () => {
  it("o seletor só oferece modelo do próprio treinamento", async () => {
    await coord();
    const [nr35, brigada] = await _dois_treinamentos();
    const generico = _id_do_modelo(await _criar_modelo("Genérico CSSO"));
    const so_brigada = _id_do_modelo(await _criar_modelo("Só da Brigada", { treinamento_id: String(brigada) }));
    const tela = (await cliente.get("/treinamentos/catalogo")).text;
    const do_nr35 = _opcoes(tela, `f-trein-${nr35}`, "modelo_vigente_id");
    expect(do_nr35).not.toContain(String(so_brigada));
    expect(do_nr35).toContain(String(generico));
    expect(_opcoes(tela, `f-trein-${brigada}`, "modelo_vigente_id")).toContain(String(so_brigada));
  });

  it("catálogo recusa modelo de outro treinamento", async () => {
    await coord();
    const [nr35, brigada] = await _dois_treinamentos();
    const so_brigada = _id_do_modelo(await _criar_modelo("Só da Brigada", { treinamento_id: String(brigada) }));
    const resposta = await _editar_treinamento(nr35, { modelo_vigente_id: String(so_brigada) });
    expect(resposta.status).toBe(303);
    expect((await cliente.get(resposta.location!)).text).toContain("outro treinamento");
    expect((await _treinamento(nr35)).modelo_vigente_id).toBeNull();
  });

  it.each([
    ["modelo_vigente_id", "99999"],
    ["instrutor_padrao_id", "77777"],
  ])("id que não existe (%s) vira recusa e não página de erro", async (campo, valor) => {
    await coord();
    await _criar();
    const alvo = await _id_do_treinamento();
    const resposta = await _editar_treinamento(alvo, { [campo]: valor });
    expect(resposta.status).toBe(303);
    expect((await cliente.get(resposta.location!)).text).toContain("não encontrad");
  });

  it("modelo superado continua na linha de quem o usa", async () => {
    await coord();
    await _criar();
    const alvo = await _id_do_treinamento();
    const v1 = _id_do_modelo(await _criar_modelo("Padrão", { treinamento_id: String(alvo) }));
    await _editar_treinamento(alvo, { modelo_vigente_id: String(v1) });
    await cliente.post(`/treinamentos/modelos/${v1}/versao`, {}, { seguir: false });
    const tela = (await cliente.get("/treinamentos/catalogo")).text;
    expect(_opcoes(tela, `f-trein-${alvo}`, "modelo_vigente_id")).toContain(String(v1));
    await _editar_treinamento(alvo, { carga_horaria_horas: "16", modelo_vigente_id: String(v1) });
    expect((await _treinamento(alvo)).modelo_vigente_id).toBe(v1);
  });

  it("instrutor inativo não vira padrão de treinamento", async () => {
    await coord();
    await _criar();
    const alvo = await _id_do_treinamento();
    await cliente.post("/treinamentos/assinaturas", { nome: "Joana Ribeiro", externo: "1", vigencia_inicio: "2026-01-01" });
    const [assinatura] = await db.select().from(e.assinatura_instrutor);
    await db.update(e.assinatura_instrutor).set({ ativo: false }).where(eq(e.assinatura_instrutor.id, assinatura!.id));
    const resposta = await _editar_treinamento(alvo, { instrutor_padrao_id: String(assinatura!.id) });
    expect((await cliente.get(resposta.location!)).text).toContain("inativa");
    expect((await _treinamento(alvo)).instrutor_padrao_id).toBeNull();
  });
});

// =====================================================================
// Assinatura de instrutor
// =====================================================================
async function _servidor(): Promise<number> {
  const [s] = await db.insert(e.servidor).values({ siape: "2165804", nome: "Fabrício Raimundi Andrade" }).returning();
  return s!.id;
}

async function _assinatura_unica() {
  const todas = await db.query.assinatura_instrutor.findMany({ with: { servidor: true } });
  expect(todas).toHaveLength(1);
  return todas[0]!;
}

describe("assinatura de instrutor", () => {
  it("assinatura de instrutor servidor lê o nome do cadastro", async () => {
    const servidor_id = await _servidor();
    await coord();
    const resposta = await cliente.post(
      "/treinamentos/assinaturas",
      {
        servidor_id: String(servidor_id),
        titulo: "Eng. Seg. do Trabalho",
        conselho: "crea",
        registro_conselho: "MG-123456",
        vigencia_inicio: "2019-01-01",
      },
      { seguir: false },
    );
    expect(resposta.status).toBe(303);
    const assinatura = await _assinatura_unica();
    expect(assinatura.servidor_id).toBe(servidor_id);
    expect(assinatura.externo).toBe(false);
    expect(AssinaturaInstrutor.nome_exibicao(assinatura)).toBe("Fabrício Raimundi Andrade");
    expect(assinatura.conselho).toBe("CREA"); // normalizado na entrada
    expect(AssinaturaInstrutor.registro_completo(assinatura)).toBe("CREA MG-123456");
    expect(AssinaturaInstrutor.vigente_em(assinatura, "2026-08-13")).toBe(true);
    const lista = (await cliente.get("/treinamentos/assinaturas")).text;
    expect(lista).toContain("Fabrício Raimundi Andrade");
    expect(lista).toContain("MG-123456");
  });

  it("assinatura externa dispensa servidor", async () => {
    await coord();
    await cliente.post(
      "/treinamentos/assinaturas",
      {
        nome: "Joana Ribeiro",
        externo: "1",
        organizacao: "Corpo de Bombeiros",
        vigencia_inicio: "2026-01-01",
        vigencia_fim: "2026-12-31",
      },
      { seguir: false },
    );
    const assinatura = await _assinatura_unica();
    expect(assinatura.externo).toBe(true);
    expect(assinatura.servidor_id).toBeNull();
    expect(AssinaturaInstrutor.nome_exibicao(assinatura)).toBe("Joana Ribeiro");
    expect(AssinaturaInstrutor.vigente_em(assinatura, "2027-01-01")).toBe(false);
  });

  it("instrutor interno sem servidor é recusado", async () => {
    await coord();
    const resposta = await cliente.post("/treinamentos/assinaturas", { nome: "Alguém", vigencia_inicio: "2026-01-01" });
    expect(resposta.text).toContain("precisa estar vinculado a um servidor");
  });

  it("editar assinatura registra diff", async () => {
    await coord();
    await cliente.post(
      "/treinamentos/assinaturas",
      { nome: "Joana Ribeiro", externo: "1", vigencia_inicio: "2026-01-01" },
      { seguir: false },
    );
    const alvo = (await _assinatura_unica()).id;
    await cliente.post(
      `/treinamentos/assinaturas/${alvo}`,
      { nome: "Joana Ribeiro Nunes", externo: "1", titulo: "Bombeira militar", vigencia_inicio: "2026-01-01", ativo: "1" },
      { seguir: false },
    );
    expect((await _assinatura_unica()).nome).toBe("Joana Ribeiro Nunes");
    const campos = new Set(
      (
        await db
          .select()
          .from(e.historico_evento)
          .where(
            and(eq(e.historico_evento.entidade, "assinatura_instrutor"), eq(e.historico_evento.tipo_evento, "CAMPO_ALTERADO")),
          )
      ).map((ev) => ev.campo),
    );
    expect(campos.has("nome") && campos.has("titulo")).toBe(true);
  });

  it("vigência invertida é recusada", async () => {
    await coord();
    const resposta = await cliente.post("/treinamentos/assinaturas", {
      nome: "Joana",
      externo: "1",
      vigencia_inicio: "2026-06-01",
      vigencia_fim: "2026-01-01",
    });
    expect(resposta.text).toContain("não pode ser anterior ao início");
  });
});

// =====================================================================
// Permissões
// =====================================================================
describe("permissões", () => {
  it("quem só consulta vê o catálogo mas não edita", async () => {
    await coord();
    await _criar();
    await entrar(cliente, "secretaria_csso");
    const lista = await cliente.get("/treinamentos/catalogo");
    expect(lista.status).toBe(200);
    expect(lista.text).toContain("Trabalho em Altura");
    // a tela abre em leitura: sem formulário de edição e sem botão de salvar
    expect(lista.text).not.toContain("Novo treinamento");
    expect(lista.text).not.toContain('action="/treinamentos/catalogo/');
    expect((await cliente.post("/treinamentos/catalogo", NR35)).status).toBe(403);
  });

  it.each([
    ["secretaria_csso", "/treinamentos/modelos", 403],
    ["secretaria_csso", "/treinamentos/assinaturas", 403],
    ["admin_ti", "/treinamentos/catalogo", 403],
    ["admin_ti", "/treinamentos/modelos", 403],
    ["auditor_interno", "/treinamentos/catalogo", 200],
    ["auditor_interno", "/treinamentos/assinaturas", 403],
    ["coordenador_csso", "/treinamentos/modelos", 200],
    ["coordenador_csso", "/treinamentos/assinaturas", 200],
  ] as const)("permissão das telas: %s %s -> %i", async (perfil, caminho, esperado) => {
    await entrar(cliente, perfil);
    expect((await cliente.get(caminho)).status).toBe(esperado);
  });

  it("permissões novas nascem no módulo TREINAMENTOS", async () => {
    const por_codigo = Object.fromEntries((await db.select().from(e.permissao)).map((p) => [p.codigo, p.modulo]));
    for (const codigo of [
      "treinamento.ver",
      "treinamento.gerenciar",
      "assinatura.gerenciar",
      "turma.criar",
      "turma.inscrever",
      "turma.concluir",
    ]) {
      expect(por_codigo[codigo], codigo).toBe("TREINAMENTOS");
    }
    expect(por_codigo["parecer.emitir"]).toBe("ADICIONAL");
  });
});

// =====================================================================
// O módulo no menu e no mapa
// =====================================================================
describe("o módulo no menu e no mapa", () => {
  it("módulo declara as telas que existem", () => {
    const modulo = modulos.por_codigo("certificados")!;
    expect(modulo.disponivel).toBe(true);
    expect(modulo.itens.map((i) => [i.caminho, i.permissao])).toEqual([
      ["/turmas", "treinamento.ver"],
      ["/turmas/minhas", "treinamento.ver"],
      ["/certificados/meus", "treinamento.ver"],
      ["/certificados", "certificado.ver"],
      ["/treinamentos/catalogo", "treinamento.ver"],
      ["/treinamentos/modelos", "treinamento.gerenciar"],
      ["/treinamentos/assinaturas", "assinatura.gerenciar"],
    ]);
    // o que falta continua declarado: entregue por fatias, não escondido
    expect(modulo.itens_previstos.length).toBeGreaterThan(0);
  });

  it.each(["/treinamentos/catalogo", "/treinamentos/modelos", "/treinamentos/modelos/7"])(
    "a tela %s marca o módulo",
    (caminho) => {
      expect(modulos.modulo_ativo(caminho)!.codigo).toBe("certificados");
    },
  );

  it("menu e mapa mostram o módulo", async () => {
    await coord();
    const barra = (await cliente.get("/treinamentos/catalogo")).text;
    expect(barra).toContain("Certificados e Treinamentos");
    expect(barra).toContain('href="/treinamentos/assinaturas"');
    const mapa = (await cliente.get("/modulos")).text;
    for (const caminho of ["/treinamentos/catalogo", "/treinamentos/modelos", "/treinamentos/assinaturas"]) {
      expect(mapa).toContain(`href="${caminho}"`);
    }
    expect(mapa).toContain("O que ainda vem");
  });

  it("o mapa não oferece a tela a quem não pode", async () => {
    await entrar(cliente, "secretaria_csso");
    const mapa = (await cliente.get("/modulos")).text;
    expect(mapa).toContain('href="/treinamentos/catalogo"');
    expect(mapa).not.toContain('href="/treinamentos/modelos"');
    expect(mapa).not.toContain('href="/treinamentos/assinaturas"');
  });
});

// =====================================================================
// O esquema
// =====================================================================
// Não se aplica à nuvem: o teste Python conferia que o SQLAlchemy ordena o
// esquema inteiro (create_all/drop_all num SQLite em memória) apesar do ciclo
// treinamento <-> certificado_modelo. Aqui o esquema é criado pela migração do
// drizzle-kit, que emite toda FK como ALTER TABLE depois dos CREATE TABLE — e
// toda a suíte já migra o banco-modelo a cada execução.
it.skip("o esquema inteiro continua ordenável para criar e apagar (SQLAlchemy/SQLite — não se aplica)", () => {});
