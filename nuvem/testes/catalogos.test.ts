/**
 * Catálogos: cadastro, edição em linha com diff na trilha, e a recusa que
 * reabre o popup. Porte de `test_cargos.py`, das partes de tela de
 * `test_catalogos_edicao.py` e dos casos de catálogo de
 * `test_popup_de_cadastro.py`. (Os testes de "parecer emitido reimprime do
 * congelado" são do porte de Processos — dependem de `servicos/parecer`.)
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { hoje_iso } from "../src/dominio/datas.js";
import { bancoLimpo, contas, entrar, type AmbienteDeTeste } from "./ajuda";

let amb: AmbienteDeTeste = await bancoLimpo();
beforeEach(async () => {
  amb = await bancoLimpo();
  await contas(amb.db);
  await entrar(amb.cliente, "coordenador_csso");
});
const abertos = (corpo: string) => [...corpo.matchAll(/<dialog[^>]*id="([^"]+)"[^>]*\sopen>/g)].map((m) => m[1]);

const CATALOGOS = [
  "campi", "unidades-uorg", "postos-trabalho", "cargos", "agentes-nocivos", "tipos-risco",
  "fundamentacoes-legais", "percentuais", "textos-padrao", "portarias", "checklists-modelo",
];

describe("índice e telas", () => {
  it("o índice lista os onze, e cargos traz o que veio dos seeds", async () => {
    const indice = (await amb.cliente.get("/catalogos")).text;
    expect(indice).toContain("/catalogos/cargos");
    const lista = await amb.cliente.get("/catalogos/cargos");
    expect(lista.status).toBe(200);
    expect(lista.text).toContain("TECNICO DE LABORATORIO AREA");
  });

  it.each(CATALOGOS)("%s abre sem erro de template e oferece edição", async (catalogo) => {
    const r = await amb.cliente.get(`/catalogos/${catalogo}`);
    expect(r.status, catalogo).toBe(200);
    expect(r.text.split("</form>").length - 1, catalogo).toBeGreaterThanOrEqual(1);
  });

  it("quem só consulta vê a tela em leitura", async () => {
    await entrar(amb.cliente, "secretaria_csso");
    const r = await amb.cliente.get("/catalogos/campi");
    expect(r.status).toBe(200);
    expect(r.text).toContain("somente leitura");
    expect(r.text).not.toContain('action="/catalogos/campi/');
  });
});

describe("cargos", () => {
  it("cadastrar cargo", async () => {
    const r = await amb.cliente.post("/catalogos/cargos", { nome: "TECNICO EM QUIMICA", codigo_siape: "701001" }, { seguir: false });
    expect(r.status).toBe(303);
    const [cargo] = await amb.db.select().from(e.cargo).where(eq(e.cargo.nome, "TECNICO EM QUIMICA"));
    expect(cargo!.codigo_siape).toBe("701001");
  });

  it("cargo repetido é recusado reabrindo o popup com o digitado", async () => {
    const dados = { nome: "TECNICO DE LABORATORIO AREA", codigo_siape: "701200" };
    const corpo = (await amb.cliente.post("/catalogos/cargos", dados)).text;
    expect(abertos(corpo)).toEqual(["novo"]);
    expect(corpo).toContain("já está cadastrado");
    expect(corpo).toContain('value="TECNICO DE LABORATORIO AREA"');
  });

  it("nome em branco é recusado", async () => {
    expect((await amb.cliente.post("/catalogos/cargos", { nome: "   " })).text).toContain("não pode ficar em branco");
  });

  it("editar cargo audita o diff", async () => {
    const [cargo] = await amb.db.select().from(e.cargo).where(eq(e.cargo.nome, "TECNICO DE LABORATORIO AREA"));
    await amb.cliente.post(
      "/catalogos/cargos",
      { cargo_id: String(cargo!.id), nome: "TÉCNICO DE LABORATÓRIO/ÁREA", codigo_siape: "701200" },
      { seguir: false },
    );
    const [depois] = await amb.db.select().from(e.cargo).where(eq(e.cargo.id, cargo!.id));
    expect(depois!.nome).toBe("TÉCNICO DE LABORATÓRIO/ÁREA");
    expect(depois!.codigo_siape).toBe("701200");
    const [evento] = await amb.db
      .select()
      .from(e.historico_evento)
      .where(and(eq(e.historico_evento.entidade, "cargo"), eq(e.historico_evento.campo, "nome")));
    expect(evento!.valor_anterior).toBe("TECNICO DE LABORATORIO AREA");
  });

  it("renomear para o nome de outro é recusado na linha (banner vermelho)", async () => {
    await amb.cliente.post("/catalogos/cargos", { nome: "OUTRO CARGO" }, { seguir: false });
    const [outro] = await amb.db.select().from(e.cargo).where(eq(e.cargo.nome, "OUTRO CARGO"));
    const r = await amb.cliente.post("/catalogos/cargos", { cargo_id: String(outro!.id), nome: "TECNICO DE LABORATORIO AREA" });
    expect(r.text).toContain("Já existe outro cargo");
    expect(abertos(r.text)).toEqual([]);
  });

  it("a lista mostra quantos servidores usam", async () => {
    const [cargo] = await amb.db.select().from(e.cargo).where(eq(e.cargo.nome, "TECNICO DE LABORATORIO AREA"));
    await amb.db.insert(e.servidor).values([
      { siape: "1110654", nome: "Marco Antônio", cargo_id: cargo!.id },
      { siape: "1473142", nome: "Gabriela Silva", cargo_id: cargo!.id },
    ]);
    const corpo = (await amb.cliente.get("/catalogos/cargos")).text;
    expect(corpo).toContain("Servidores");
    expect(corpo).toContain('title="servidores neste cargo">2</span>');
  });

  it("cadastro de cargo exige permissão", async () => {
    await entrar(amb.cliente, "secretaria_csso");
    expect((await amb.cliente.post("/catalogos/cargos", { nome: "X" })).status).toBe(403);
  });

  it("sem cargo, a tela de servidores aponta o caminho", async () => {
    await amb.db.update(e.servidor).set({ cargo_id: null });
    await amb.db.delete(e.cargo);
    expect((await amb.cliente.get("/servidores")).text).toContain("cadastre um cargo");
  });
});

describe("edição em linha", () => {
  it("editar campus (checkbox ausente = desmarcado)", async () => {
    const [dia] = await amb.db.select().from(e.campus).where(eq(e.campus.sigla, "DIA"));
    const r = await amb.cliente.post(
      `/catalogos/campi/${dia!.id}`,
      { nome: "Campus Juscelino Kubitschek", cidade: "Diamantina", uf: "mg" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    const [depois] = await amb.db.select().from(e.campus).where(eq(e.campus.id, dia!.id));
    expect([depois!.nome, depois!.uf, depois!.avancado]).toEqual(["Campus Juscelino Kubitschek", "MG", false]);
  });

  it("código UORG de outra unidade é recusado", async () => {
    const [famed] = await amb.db.select().from(e.unidade_uorg).where(eq(e.unidade_uorg.codigo_uorg, "250"));
    const [outra] = await amb.db.select().from(e.unidade_uorg).where(eq(e.unidade_uorg.codigo_uorg, "261"));
    const r = await amb.cliente.post(`/catalogos/unidades-uorg/${outra!.id}`, {
      codigo_uorg: "250",
      nome_oficial: outra!.nome_oficial,
      nome_extenso: outra!.nome_extenso,
      tipo: outra!.tipo,
      campus_id: String(outra!.campus_id),
    });
    expect(r.text).toContain("já é de outra unidade");
    expect(famed).toBeDefined();
  });

  it("fundamentação normaliza aspas e carimba a conferência", async () => {
    const [f] = await amb.db.select().from(e.fundamentacao_legal).limit(1);
    await amb.cliente.post(
      `/catalogos/fundamentacoes-legais/${f!.id}`,
      { norma: f!.norma, texto: '"Trabalhos em contato permanente" com pacientes', vigente: "1" },
      { seguir: false },
    );
    const [depois] = await amb.db.select().from(e.fundamentacao_legal).where(eq(e.fundamentacao_legal.id, f!.id));
    expect(depois!.texto).toContain("“Trabalhos em contato permanente”");
    expect(depois!.dispositivo_conferido_em).toBe(hoje_iso());
  });

  it("percentual só edita o rótulo — o valor é a lei", async () => {
    const [p] = await amb.db.select().from(e.percentual_aplicavel).where(eq(e.percentual_aplicavel.rotulo, "Médio (10%)")).limit(1);
    await amb.cliente.post(`/catalogos/percentuais/${p!.id}`, { rotulo: "Médio (10 %)", valor: "35" }, { seguir: false });
    const [depois] = await amb.db.select().from(e.percentual_aplicavel).where(eq(e.percentual_aplicavel.id, p!.id));
    expect(depois!.rotulo).toBe("Médio (10 %)");
    expect(depois!.valor).toBe(p!.valor);
  });

  it("portaria: zeros à esquerda somem e o ano segue a data", async () => {
    const [famed] = await amb.db.select().from(e.unidade_uorg).where(eq(e.unidade_uorg.codigo_uorg, "250"));
    const [port] = await amb.db
      .insert(e.portaria_localizacao)
      .values({
        unidade_emissora_id: famed!.id,
        numero: "35",
        ano: 2024,
        data_publicacao: "2024-09-17",
        texto_original: "PORTARIA/FAMED Nº 35, DE 17 DE SETEMBRO DE 2024",
      })
      .returning();
    await amb.cliente.post(
      `/catalogos/portarias/${port!.id}`,
      { texto_original: "PORTARIA/FAMED Nº 35, DE 18 DE SETEMBRO DE 2024", numero: "035", data_publicacao: "2024-09-18" },
      { seguir: false },
    );
    const [depois] = await amb.db.select().from(e.portaria_localizacao).where(eq(e.portaria_localizacao.id, port!.id));
    expect([depois!.data_publicacao, depois!.numero, depois!.ano]).toEqual(["2024-09-18", "35", 2024]);
  });

  it("portaria nova extrai número e data do texto; repetida (001 = 1) é recusada", async () => {
    const [famed] = await amb.db.select().from(e.unidade_uorg).where(eq(e.unidade_uorg.codigo_uorg, "250"));
    await amb.db.update(e.unidade_uorg).set({ emite_portaria: true }).where(eq(e.unidade_uorg.id, famed!.id));
    const texto = "PORTARIA/FAMED Nº 035, DE 17 DE SETEMBRO DE 2024";
    const r = await amb.cliente.post("/catalogos/portarias", { texto_original: texto, unidade_emissora_id: String(famed!.id) }, { seguir: false });
    expect(r.status).toBe(303);
    const [p] = await amb.db.select().from(e.portaria_localizacao);
    expect([p!.numero, p!.data_publicacao]).toEqual(["35", "2024-09-17"]);
    const repetida = await amb.cliente.post("/catalogos/portarias", {
      texto_original: "PORTARIA/FAMED Nº 1, DE 17 DE SETEMBRO DE 2024",
      numero: "0035",
      unidade_emissora_id: String(famed!.id),
    });
    expect(repetida.text).toContain("Portaria já cadastrada");
    expect(abertos(repetida.text)).toEqual(["novo"]);
  });

  it("checklist modelo: cadastrar e editar", async () => {
    await amb.cliente.post("/catalogos/checklists-modelo", { nome: "Instrução", itens: "a\nb" }, { seguir: false });
    const [m] = await amb.db.select().from(e.checklist_modelo).where(eq(e.checklist_modelo.nome, "Instrução"));
    await amb.cliente.post(
      `/catalogos/checklists-modelo/${m!.id}`,
      { nome: "Instrução do adicional", itens: "a\nb\nc", ativo: "1" },
      { seguir: false },
    );
    const [depois] = await amb.db.select().from(e.checklist_modelo).where(eq(e.checklist_modelo.id, m!.id));
    expect(depois!.nome).toBe("Instrução do adicional");
    expect(depois!.itens.split("\n")).toHaveLength(3);
  });

  it("texto padrão versiona e aposenta a anterior", async () => {
    for (const t of ['Primeira "versão"', "Segunda"]) {
      await amb.cliente.post("/catalogos/textos-padrao", { categoria: "ASSUNTO", codigo: "TESTE_X", template: t }, { seguir: false });
    }
    const versoes = await amb.db.select().from(e.texto_padrao).where(eq(e.texto_padrao.codigo, "TESTE_X"));
    expect(versoes.map((v) => [v.versao, v.vigente]).sort()).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(versoes.find((v) => v.versao === 1)!.template).toContain("“versão”");
  });

  it("toda edição deixa diff na auditoria", async () => {
    const [risco] = await amb.db.select().from(e.tipo_risco).where(eq(e.tipo_risco.codigo, "BIOLOGICO"));
    await amb.cliente.post(`/catalogos/tipos-risco/${risco!.id}`, { nome: "Novo nome" }, { seguir: false });
    const [evento] = await amb.db.select().from(e.historico_evento).where(eq(e.historico_evento.entidade, "tipo_risco"));
    expect(evento!.valor_anterior).toBe("Agente Biológico");
    expect(evento!.valor_novo).toBe("Novo nome");
  });

  it.each([
    "/catalogos/campi/1",
    "/catalogos/unidades-uorg/1",
    "/catalogos/postos-trabalho/1",
    "/catalogos/tipos-risco/1",
    "/catalogos/fundamentacoes-legais/1",
    "/catalogos/percentuais/1",
    "/catalogos/agentes-nocivos/1",
    "/catalogos/portarias/1",
    "/catalogos/checklists-modelo/1",
  ])("%s exige permissão", async (caminho) => {
    await entrar(amb.cliente, "secretaria_csso");
    expect([403, 422]).toContain((await amb.cliente.post(caminho, {})).status);
  });

  it("posto duplicado no cadastro reabre o popup", async () => {
    const [famed] = await amb.db.select().from(e.unidade_uorg).where(eq(e.unidade_uorg.codigo_uorg, "250"));
    const corpo = (
      await amb.cliente.post("/catalogos/postos-trabalho", {
        unidade_uorg_id: String(famed!.id),
        nome: "Laboratório Escola de análises Clínicas (LEAC)",
        sigla: "LEAC2",
      })
    ).text;
    expect(corpo).toContain("Esse posto já existe nesta unidade.");
    expect(abertos(corpo)).toEqual(["novo"]);
    expect(corpo).toContain('value="LEAC2"');
  });
});
