/**
 * Catálogos: cadastro, edição pelo popup "Editar" de cada linha com diff na
 * trilha, e a recusa que reabre o popup de onde veio. Porte de `test_cargos.py`, das partes de tela de
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
/** O <dialog> de um popup, do `<dialog` ao `</dialog>`, para conferir o que há dentro dele. */
const popup = (corpo: string, id: string) => {
  const m = new RegExp(`<dialog class="popup" id="${id}"[\\s\\S]*?</dialog>`).exec(corpo);
  return m ? m[0] : "";
};
const abertos = (corpo: string) => [...corpo.matchAll(/<dialog[^>]*id="([^"]+)"[^>]*\sopen>/g)].map((m) => m[1]);

const CATALOGOS = [
  "campi", "unidades-uorg", "postos-trabalho", "cargos", "agentes-nocivos", "tipos-risco",
  "fundamentacoes-legais", "percentuais", "textos-padrao", "portarias", "checklists-modelo",
  "autoridades-destinatarias", "setores-emissores",
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
    expect(r.text).not.toContain('id="editar-campus-');
    expect(r.text).not.toContain(">Editar</a>");
  });

  // A lista é só leitura: nenhum campo na linha, e o "Editar" de cada uma abre
  // o popup com os campos que a rota de edição lê.
  it.each([
    ["campi", "editar-campus-", "f-campus-"],
    ["unidades-uorg", "editar-uorg-", "f-uorg-"],
    ["postos-trabalho", "editar-posto-", "f-posto-"],
    ["cargos", "editar-cargo-", "cargo-"],
    ["agentes-nocivos", "editar-agente-", "f-agente-"],
    ["tipos-risco", "editar-risco-", "f-risco-"],
    ["fundamentacoes-legais", "editar-fund-", "f-fund-"],
    ["percentuais", "editar-perc-", "f-perc-"],
    ["autoridades-destinatarias", "editar-aut-", "f-aut-"],
    ["setores-emissores", "editar-setor-emissor-", "f-setor-"],
  ])("%s: lista só de leitura e um popup de editar por linha", async (catalogo, prefixo, antigo) => {
    const corpo = (await amb.cliente.get(`/catalogos/${catalogo}`)).text;
    expect(corpo).not.toContain(`form="${antigo}`);
    expect(corpo).not.toMatch(/<td[^>]*>\s*<(input|select|textarea)\b/);
    expect(corpo).toContain(`href="#${prefixo}`);
    expect(corpo).toMatch(new RegExp(`<dialog class="popup" id="${prefixo}\\d+"`));
    expect(abertos(corpo)).toEqual([]);
  });
});

describe("autoridade destinatária e setor emissor", () => {
  it("cadastra autoridade com vigência e audita", async () => {
    const r = await amb.cliente.post(
      "/catalogos/autoridades-destinatarias",
      { nome: "Fulana de Tal", cargo: "Pró-Reitora de Gestão de Pessoas", tratamento: "Senhora Pró-Reitora", vigencia_inicio: "2026-10-01" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    const [a] = await amb.db.select().from(e.autoridade_destinataria).where(eq(e.autoridade_destinataria.nome, "Fulana de Tal"));
    expect(a!.vigencia_inicio).toBe("2026-10-01");
    const [ev] = await amb.db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "AUTORIDADE_CRIADA"));
    expect(ev!.entidade_id).toBe(a!.id);
  });

  it("edita autoridade em linha com diff", async () => {
    const [a] = await amb.db.select().from(e.autoridade_destinataria).limit(1);
    await amb.cliente.post(
      `/catalogos/autoridades-destinatarias/${a!.id}`,
      { nome: a!.nome, cargo: a!.cargo, tratamento: a!.tratamento, vigencia_inicio: a!.vigencia_inicio, vigencia_fim: "2026-09-30" },
      { seguir: false },
    );
    const [depois] = await amb.db.select().from(e.autoridade_destinataria).where(eq(e.autoridade_destinataria.id, a!.id));
    expect(depois!.vigencia_fim).toBe("2026-09-30");
  });

  it("cadastra setor emissor; mesma sigla e início é recusado com o popup aberto", async () => {
    const dados = { sigla_composta: "SEST/DASA/PROGEP", nome_extenso: "Seção de Segurança", vigencia_inicio: "2026-11-01" };
    expect((await amb.cliente.post("/catalogos/setores-emissores", dados, { seguir: false })).status).toBe(303);
    const [s] = await amb.db.select().from(e.setor_emissor).where(eq(e.setor_emissor.vigencia_inicio, "2026-11-01"));
    expect(s!.cidade).toBe("Diamantina");
    const corpo = (await amb.cliente.post("/catalogos/setores-emissores", dados)).text;
    expect(abertos(corpo)).toEqual(["novo"]);
    expect(corpo).toContain("Já existe SEST/DASA/PROGEP");
  });

  it("exige catalogo.gerenciar", async () => {
    await entrar(amb.cliente, "secretaria_csso");
    const r = await amb.cliente.post("/catalogos/setores-emissores", { sigla_composta: "X", nome_extenso: "X", vigencia_inicio: "2026-01-01" });
    expect(r.status).toBe(403);
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

  it("renomear para o nome de outro reabre o popup de editar daquele cargo, e não o de cadastro", async () => {
    await amb.cliente.post("/catalogos/cargos", { nome: "OUTRO CARGO" }, { seguir: false });
    const [outro] = await amb.db.select().from(e.cargo).where(eq(e.cargo.nome, "OUTRO CARGO"));
    const r = await amb.cliente.post("/catalogos/cargos", {
      cargo_id: String(outro!.id),
      nome: "TECNICO DE LABORATORIO AREA",
      codigo_siape: "709999",
    });
    expect(r.status).toBe(200);
    expect(abertos(r.text)).toEqual([`editar-cargo-${outro!.id}`]);
    const caixa = popup(r.text, `editar-cargo-${outro!.id}`);
    expect(caixa).toContain("Já existe outro cargo");
    expect(caixa).toContain('value="709999"');
    expect(caixa).toContain(`name="cargo_id" value="${outro!.id}"`);
    // o cadastro, fechado, não herda o digitado da edição
    expect(popup(r.text, "novo")).not.toContain('value="709999"');
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

describe("edição pelo popup", () => {
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
    expect(r.status).toBe(200);
    expect(r.text).toMatch(new RegExp(`<dialog class="popup" id="editar-uorg-${outra!.id}"[^>]* open>`));
    expect(popup(r.text, `editar-uorg-${outra!.id}`)).toContain('value="250"');
    expect(r.text).not.toContain(`form="f-uorg-`);
  });

  it("campus com nome em branco reabre o popup daquele campus com o digitado", async () => {
    const [dia] = await amb.db.select().from(e.campus).where(eq(e.campus.sigla, "DIA"));
    const r = await amb.cliente.post(`/catalogos/campi/${dia!.id}`, { nome: "   ", cidade: "Cidade Digitada", uf: "BA", avancado: "1" });
    expect(r.status).toBe(200);
    expect(r.text).toMatch(new RegExp(`<dialog class="popup" id="editar-campus-${dia!.id}"[^>]* open>`));
    expect(abertos(r.text)).toEqual([`editar-campus-${dia!.id}`]);
    const caixa = popup(r.text, `editar-campus-${dia!.id}`);
    expect(caixa).toContain("Preencha nome");
    expect(caixa).toContain('value="Cidade Digitada"');
    expect(caixa).toContain('value="BA"');
    expect(caixa).toMatch(/name="avancado" value="1" checked/);
    expect(r.text).not.toContain(`form="f-campus-`);
    const [depois] = await amb.db.select().from(e.campus).where(eq(e.campus.id, dia!.id));
    expect(depois!.cidade).toBe(dia!.cidade);
  });

  it("posto repetido na edição reabre o popup do posto, com a descrição digitada", async () => {
    const [famed] = await amb.db.select().from(e.unidade_uorg).where(eq(e.unidade_uorg.codigo_uorg, "250"));
    const [p] = await amb.db
      .insert(e.posto_trabalho)
      .values({ unidade_uorg_id: famed!.id, nome: "Sala de teste", descricao: "a descrição" })
      .returning();
    const [leac] = await amb.db
      .select()
      .from(e.posto_trabalho)
      .where(and(eq(e.posto_trabalho.unidade_uorg_id, famed!.id), eq(e.posto_trabalho.nome, "Laboratório Escola de análises Clínicas (LEAC)")));
    // o popup leva a descrição: a linha antiga não a mandava, e salvar a apagava
    expect(popup((await amb.cliente.get("/catalogos/postos-trabalho")).text, `editar-posto-${p!.id}`)).toContain('value="a descrição"');
    const r = await amb.cliente.post(`/catalogos/postos-trabalho/${p!.id}`, {
      nome: leac!.nome,
      unidade_uorg_id: String(famed!.id),
      descricao: "digitada",
      ativo: "1",
    });
    expect(r.status).toBe(200);
    expect(abertos(r.text)).toEqual([`editar-posto-${p!.id}`]);
    const caixa = popup(r.text, `editar-posto-${p!.id}`);
    expect(caixa).toContain("Já existe esse posto nesta unidade.");
    expect(caixa).toContain('value="digitada"');
  });

  it("setor emissor com sigla e início de outro reabre o popup do setor", async () => {
    const base = { nome_extenso: "Seção", vigencia_inicio: "2026-11-01" };
    await amb.cliente.post("/catalogos/setores-emissores", { ...base, sigla_composta: "AAA/TESTE" }, { seguir: false });
    await amb.cliente.post("/catalogos/setores-emissores", { ...base, sigla_composta: "BBB/TESTE" }, { seguir: false });
    const [b] = await amb.db.select().from(e.setor_emissor).where(eq(e.setor_emissor.sigla_composta, "BBB/TESTE"));
    const r = await amb.cliente.post(`/catalogos/setores-emissores/${b!.id}`, {
      ...base,
      sigla_composta: "AAA/TESTE",
      email: "digitado@ufvjm.edu.br",
    });
    expect(r.status).toBe(200);
    expect(abertos(r.text)).toEqual([`editar-setor-emissor-${b!.id}`]);
    const caixa = popup(r.text, `editar-setor-emissor-${b!.id}`);
    expect(caixa).toContain("Já existe outro setor");
    expect(caixa).toContain('value="digitado@ufvjm.edu.br"');
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

// =====================================================================
// O que o teste das telas de configurações achou (26/10/2026)
// =====================================================================
describe("validações dos catálogos que faltavam", () => {
  it("cargo com o mesmo nome, sem contar caixa nem acento, é recusado — no cadastro e na edição", async () => {
    const r = await amb.cliente.post("/catalogos/cargos", { nome: "tecnico de laboratorio area" });
    expect(r.status).toBe(200);
    expect(r.text).toContain("já está cadastrado");
    expect(await amb.db.select().from(e.cargo).where(eq(e.cargo.nome, "tecnico de laboratorio area"))).toHaveLength(0);
    const outro = await amb.cliente.post("/catalogos/cargos", { nome: "Cargo Outro Teste" });
    expect(outro.status).toBe(200);
    const [novo] = await amb.db.select().from(e.cargo).where(eq(e.cargo.nome, "Cargo Outro Teste"));
    const edicao = await amb.cliente.post("/catalogos/cargos", { cargo_id: String(novo!.id), nome: "Técnico de Laboratório Área" });
    expect(edicao.text).toContain("Já existe outro cargo");
  });

  it("unidade com o mesmo nome oficial de outra é recusada, no cadastro e na edição", async () => {
    const [csso] = await amb.db.select().from(e.unidade_uorg).where(eq(e.unidade_uorg.sigla, "CSSO"));
    const base = { campus_id: String(csso!.campus_id), tipo: "COORDENADORIA", nome_extenso: "Duplicada" };
    const r = await amb.cliente.post("/catalogos/unidades-uorg", { ...base, nome_oficial: "coordenadoria de seguranca e saude ocupacional" });
    expect(r.status).toBe(200);
    expect(r.text).toContain("Já existe uma unidade com o nome oficial");
    const antes = await amb.db.select().from(e.unidade_uorg);
    expect(antes.filter((u) => u.nome_oficial.toUpperCase().includes("SEGURANCA E SAUDE OCUPACIONAL"))).toHaveLength(1);
    // a edição de OUTRA unidade para esse nome também
    const [outra] = antes.filter((u) => u.id !== csso!.id);
    const edicao = await amb.cliente.post(`/catalogos/unidades-uorg/${outra!.id}`, {
      nome_oficial: csso!.nome_oficial,
      nome_extenso: outra!.nome_extenso,
      tipo: outra!.tipo,
      campus_id: String(outra!.campus_id),
    });
    expect(edicao.text).toContain("Já existe outra unidade com o nome oficial");
    // editar a própria CSSO sem mudar o nome continua passando
    const propria = await amb.cliente.post(`/catalogos/unidades-uorg/${csso!.id}`, {
      nome_oficial: csso!.nome_oficial,
      nome_extenso: csso!.nome_extenso,
      tipo: csso!.tipo,
      campus_id: String(csso!.campus_id),
      ativo: "1",
    });
    expect(propria.text).not.toContain("Já existe outra unidade");
  });

  it("autoridade e setor emissor com o fim da vigência antes do início são recusados", async () => {
    const aut = await amb.cliente.post("/catalogos/autoridades-destinatarias", {
      nome: "FULANO DE TESTE", cargo: "Pró-reitor", tratamento: "Ilmo. Sr.", vigencia_inicio: "2026-05-01", vigencia_fim: "2026-04-01",
    });
    expect(aut.text).toContain("O fim da vigência não pode ser antes do início.");
    expect(await amb.db.select().from(e.autoridade_destinataria).where(eq(e.autoridade_destinataria.nome, "FULANO DE TESTE"))).toHaveLength(0);
    const set = await amb.cliente.post("/catalogos/setores-emissores", {
      sigla_composta: "TST/SISA", nome_extenso: "Setor de Teste", vigencia_inicio: "2027-02-01", vigencia_fim: "2027-01-01",
    });
    expect(set.text).toContain("O fim da vigência não pode ser antes do início.");
    expect(await amb.db.select().from(e.setor_emissor).where(eq(e.setor_emissor.sigla_composta, "TST/SISA"))).toHaveLength(0);
  });

  it("texto maior que a coluna responde 422 com a frase, e não 500", async () => {
    const r = await amb.cliente.post("/catalogos/campi", { sigla: "ABCDEFGHIJKLMNOP", nome: "X", cidade: "Y" }, { cabecalhos: { accept: "text/html" } });
    expect(r.status).toBe(422);
    expect(r.text).toContain("passa do tamanho permitido");
    expect(await amb.db.select().from(e.campus).where(eq(e.campus.nome, "X"))).toHaveLength(0);
    // e o formulário limita o tamanho antes
    const form = (await amb.cliente.get("/catalogos/campi")).text;
    expect(form).toMatch(/id="novo-sigla" name="sigla" maxlength="12"/);
  });

  // 26/10/2026 — o teste no navegador achou linha em branco, duplicata por caixa
  // e 500 em texto longo nos catálogos de agentes, riscos, fundamentações,
  // percentuais, textos padrão, portarias e checklists.
  describe("recusas dos catálogos de parecer", () => {
    const post = (caminho: string, dados: Record<string, string>) => amb.cliente.post(caminho, dados);

    it("agente nocivo: em branco, igual a outro (caixa/acento) e longo demais são recusados, no cadastro e na edição", async () => {
      const [agente] = await amb.db.select().from(e.agente_nocivo).orderBy(e.agente_nocivo.id);
      const [risco] = await amb.db.select().from(e.tipo_risco);
      const antes = (await amb.db.select().from(e.agente_nocivo)).length;
      const base = { tipo_risco_id: String(risco!.id) };
      const branco = await post("/catalogos/agentes-nocivos", { ...base, descricao: "   " });
      expect(branco.text).toContain("o campo não pode ficar em branco");
      const igual = await post("/catalogos/agentes-nocivos", { ...base, descricao: agente!.descricao.toUpperCase() });
      expect(igual.text).toContain("Já existe");
      expect(abertos(igual.text)).toEqual(["novo"]);
      const longo = await post("/catalogos/agentes-nocivos", { ...base, descricao: "X".repeat(201) });
      expect(longo.text).toContain("passa de 200 caracteres");
      expect(await amb.db.select().from(e.agente_nocivo)).toHaveLength(antes);
      const outro = (await amb.db.select().from(e.agente_nocivo).orderBy(e.agente_nocivo.id))[1]!;
      const edicao = await post(`/catalogos/agentes-nocivos/${outro.id}`, { ...base, descricao: agente!.descricao.toLowerCase(), ativo: "1" });
      expect(edicao.text).toContain("Já existe");
      expect(abertos(edicao.text)).toEqual([`editar-agente-${outro.id}`]);
    });

    it("tipo de risco, percentual e fundamentação: nome repetido ou grande demais volta como recusa (não 500)", async () => {
      const [t1, t2] = await amb.db.select().from(e.tipo_risco).orderBy(e.tipo_risco.id);
      const rep = await post(`/catalogos/tipos-risco/${t1!.id}`, { nome: t2!.nome.toUpperCase() });
      expect(rep.text).toContain("Já existe");
      expect((await post(`/catalogos/tipos-risco/${t1!.id}`, { nome: "Y".repeat(61) })).text).toContain("passa de 60 caracteres");
      const [p1, p2] = await amb.db.select().from(e.percentual_aplicavel).orderBy(e.percentual_aplicavel.id);
      expect((await post(`/catalogos/percentuais/${p1!.id}`, { rotulo: p2!.rotulo })).text).toContain("Já existe");
      expect((await post(`/catalogos/percentuais/${p1!.id}`, { rotulo: "R".repeat(41) })).text).toContain("passa de 40 caracteres");
      const [f1] = await amb.db.select().from(e.fundamentacao_legal).orderBy(e.fundamentacao_legal.id);
      const corpo = { norma: f1!.norma, anexo: "A".repeat(21), texto: "texto", vigente: "1" };
      expect((await post(`/catalogos/fundamentacoes-legais/${f1!.id}`, corpo)).text).toContain("O anexo passa de 20 caracteres");
      expect((await post(`/catalogos/fundamentacoes-legais/${f1!.id}`, { ...corpo, anexo: "", texto: "  " })).text).toContain("Preencha o texto");
      const [t1depois] = await amb.db.select().from(e.tipo_risco).where(eq(e.tipo_risco.id, t1!.id));
      expect(t1depois!.nome).toBe(t1!.nome);
    });

    it("texto padrão: código com espaço/acento e texto em branco são recusados; código bom versiona", async () => {
      const dados = { categoria: "ASSUNTO", template: "Olá" };
      const antes = (await amb.db.select().from(e.texto_padrao)).length;
      for (const codigo of ["  ", "Código Ação", "COM ESPACO", "A".repeat(41)]) {
        const r = await post("/catalogos/textos-padrao", { ...dados, codigo });
        expect(r.text, codigo).toContain("O código tem de 1 a 40 letras");
      }
      expect((await post("/catalogos/textos-padrao", { ...dados, codigo: "TESTE_Y", template: "  " })).text).toContain("Preencha o texto");
      expect(await amb.db.select().from(e.texto_padrao)).toHaveLength(antes);
      expect((await post("/catalogos/textos-padrao", { ...dados, codigo: "TESTE_Y" })).status).toBe(200);
      expect(await amb.db.select().from(e.texto_padrao)).toHaveLength(antes + 1);
    });

    it("portaria: número com letra ou maior que a coluna é recusado na edição", async () => {
      const [fam] = await amb.db.select().from(e.unidade_uorg).limit(1);
      await post("/catalogos/portarias", { texto_original: "PORTARIA/FAMED Nº 7, DE 3 DE MARÇO DE 2024", unidade_emissora_id: String(fam!.id) });
      const [p] = await amb.db.select().from(e.portaria_localizacao);
      const base = { texto_original: p!.texto_original, data_publicacao: p!.data_publicacao };
      expect((await post(`/catalogos/portarias/${p!.id}`, { ...base, numero: "12A" })).text).toContain("de 1 a 10 dígitos");
      expect((await post(`/catalogos/portarias/${p!.id}`, { ...base, numero: "9".repeat(11) })).text).toContain("de 1 a 10 dígitos");
      expect((await post(`/catalogos/portarias/${p!.id}`, { ...base, texto_original: "  ", numero: "7" })).text).toContain("Preencha o texto");
    });

    it("checklist: sem itens, item repetido ou longo, e nome repetido (que atualizava em silêncio) são recusados", async () => {
      expect((await post("/catalogos/checklists-modelo", { nome: "Modelo A", itens: "  \n " })).text).toContain("ao menos um item");
      expect((await post("/catalogos/checklists-modelo", { nome: "Modelo A", itens: "Um\num" })).text).toContain("aparece mais de uma vez");
      expect((await post("/catalogos/checklists-modelo", { nome: "Modelo A", itens: "G".repeat(301) })).text).toContain("passa de 300 caracteres");
      await post("/catalogos/checklists-modelo", { nome: "Modelo A", itens: "Um\nDois" });
      const repetido = await post("/catalogos/checklists-modelo", { nome: "modelo a", itens: "Outro" });
      expect(repetido.text).toContain("Já existe");
      const [m] = await amb.db.select().from(e.checklist_modelo).where(eq(e.checklist_modelo.nome, "Modelo A"));
      expect(m!.itens).toBe("Um\nDois");
      // editar: o nome de OUTRO modelo é recusado; o próprio nome passa
      await post("/catalogos/checklists-modelo", { nome: "Modelo B", itens: "x" });
      const [b] = await amb.db.select().from(e.checklist_modelo).where(eq(e.checklist_modelo.nome, "Modelo B"));
      expect((await post(`/catalogos/checklists-modelo/${b!.id}`, { nome: "MODELO A", itens: "x", ativo: "1" })).text).toContain("Já existe");
      await post(`/catalogos/checklists-modelo/${b!.id}`, { nome: "Modelo B", itens: "x\ny", ativo: "1" });
      const [b_depois] = await amb.db.select().from(e.checklist_modelo).where(eq(e.checklist_modelo.id, b!.id));
      expect(b_depois!.itens).toBe("x\ny");
    });
  });
});
