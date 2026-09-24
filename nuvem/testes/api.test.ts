/**
 * `/api/v1` e `/celular` — o contrato da fase 2, provado pelo lado de fora.
 * Porte de `testes/integracao/test_api_v1.py`.
 *
 * O que se prova aqui não é regra de negócio (ela mora nos serviços e tem os
 * próprios testes): é que a API chama a MESMA regra, com a mesma sessão, a mesma
 * RN-19 e a mesma trilha — e que responde JSON em todo caminho, inclusive nos
 * que a tela responderia com 303 ou com HTML.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { asc, desc, eq, inArray, and } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as e from "../src/db/esquema/index.js";
import { somar_dias } from "../src/dominio/datas.js";
import { hoje } from "../src/servicos/datas_br.js";
import { pastaDeEstaticos } from "../src/rotas/aplicativo.js";
import { bancoLimpo, contas, entrar, type AmbienteDeTeste, type Cliente } from "./ajuda";

const FETCH = { "x-requested-with": "fetch" };

// o primeiro `bancoLimpo()` na coleta registra a limpeza do arquivo
await bancoLimpo();

interface Amb extends AmbienteDeTeste {
  contas: Record<string, [string, string]>;
}
async function novo(): Promise<Amb> {
  const amb = await bancoLimpo();
  return { ...amb, contas: await contas(amb.db) };
}
async function como(amb: Amb, perfil: string): Promise<Cliente> {
  return entrar(amb.novoCliente(), amb.contas[perfil]![0]);
}

async function _servidor(c: Cliente, siape = "1110654", nome = "Marco Antônio"): Promise<number> {
  const criado = await c.post("/servidores", { siape, nome }, { seguir: false });
  expect(criado.status, criado.text.slice(0, 500)).toBe(303);
  return Number(criado.location!.split("/").pop()!.split("?")[0]);
}

/** Um item de catálogo sem exigência de CA — a semente não traz item nenhum. */
async function _item(amb: Amb): Promise<number> {
  const [ativo] = await amb.db.select().from(e.epi_item).where(eq(e.epi_item.ativo, true)).limit(1);
  if (ativo) return ativo.id;
  const [categoria] = await amb.db.select().from(e.epi_categoria).orderBy(asc(e.epi_categoria.id)).limit(1);
  const [item] = await amb.db
    .insert(e.epi_item)
    .values({ nome: "Bota de segurança", categoria_id: categoria!.id, exige_ca: false, quantidade_padrao: 1 })
    .returning();
  return item!.id;
}

// =====================================================================
// Sessão, permissão e forma — sempre em JSON
// =====================================================================
describe("sessão, permissão e forma", () => {
  it("sem sessão a API responde 401 em JSON, e não 303", async () => {
    const amb = await novo();
    const resposta = await amb.novoCliente().get("/api/v1/eu", { seguir: false });
    expect(resposta.status).toBe(401);
    expect(resposta.json().erro.startsWith("Sessão ausente")).toBe(true);
  });

  it("o índice e a identidade", async () => {
    const amb = await novo();
    const c = await como(amb, "almoxarife_sesmt");
    const indice = (await c.get("/api/v1")).json();
    expect(indice.rotas).toContain("GET  /api/v1/eu");
    const eu = (await c.get("/api/v1/eu")).json();
    expect(eu.login).toBe("almoxarife_sesmt");
    expect(eu.permissoes).toContain("epi.entregar");
    expect(eu.permissoes).not.toContain("processo.ver");
    expect(eu.versao).toBeTruthy();
  });

  it("sem permissão a API responde 403 em JSON", async () => {
    const amb = await novo();
    const c = await como(amb, "consulta_progep");
    const resposta = await c.get("/api/v1/epis/itens");
    expect(resposta.status).toBe(403);
    expect(resposta.json().motivos[0]).toContain("epi.entregar");
  });

  it("todo POST exige o cabeçalho de fetch", async () => {
    const amb = await novo();
    const c = await como(amb, "coordenador_csso");
    const resposta = await c.postJson("/api/v1/epis/entregas", { servidor_id: 1, item_id: 1, quantidade: 1 });
    expect(resposta.status).toBe(403);
    expect(resposta.json().erro).toContain("X-Requested-With");
  });

  it("corpo sem forma volta no formato de erro da API", async () => {
    const amb = await novo();
    const c = await como(amb, "coordenador_csso");
    const resposta = await c.postJson("/api/v1/epis/entregas", { quantidade: "x" }, { cabecalhos: FETCH });
    expect(resposta.status).toBe(422);
    const corpo = resposta.json();
    expect(corpo.erro).toBe("O envio não tem a forma esperada.");
    expect(corpo.motivos.some((m: string) => m.includes("servidor_id"))).toBe(true);
    // JSON quebrado também: um formato de erro só
    const quebrado = await c.enviar("POST", "/api/v1/epis/entregas", "{", { tipo: "application/json", cabecalhos: FETCH });
    expect(quebrado.status).toBe(422);
    expect(quebrado.json().erro).toBe("O envio não tem a forma esperada.");
  });
});

// =====================================================================
// O balcão
// =====================================================================
describe("o balcão", () => {
  /**
   * A API passa pela MESMA função da tela (`pode_ver_nominal`): quando ela diz
   * não, o nome não acha e o rótulo sai opaco; o SIAPE acha sempre. No Python a
   * prova trocava a função (monkeypatch); aqui, o perfil do coordenador perde as
   * duas permissões que abrem o nome (`exposicao.ver`, `epi.ficha`) no banco do
   * teste — nenhum perfil semeado tem `epi.entregar` sem poder ler nome.
   */
  it("a busca de quem recebe aplica a RN-19 por linha", async () => {
    const amb = await novo();
    const c = await como(amb, "coordenador_csso");
    await _servidor(c);
    const nominal = (await c.get("/api/v1/epis/servidores?q=Marco")).json();
    expect(nominal.length).toBeGreaterThan(0);
    expect(nominal[0].nominal).toBe(true);
    expect(nominal[0].rotulo).toBe("Marco Antônio · SIAPE 1110654");

    const [perfil] = await amb.db.select().from(e.perfil).where(eq(e.perfil.codigo, "coordenador_csso"));
    const nominais = await amb.db
      .select()
      .from(e.permissao)
      .where(inArray(e.permissao.codigo, ["exposicao.ver", "epi.ficha"]));
    await amb.db.delete(e.perfil_permissao).where(
      and(
        eq(e.perfil_permissao.perfil_id, perfil!.id),
        inArray(
          e.perfil_permissao.permissao_id,
          nominais.map((p) => p.id),
        ),
      ),
    );
    const por_nome = (await c.get("/api/v1/epis/servidores?q=Marco")).json();
    expect(por_nome, "o nome não pode achar para quem não pode lê-lo").toEqual([]);
    const por_siape = (await c.get("/api/v1/epis/servidores?q=1110654")).json();
    expect(por_siape.length).toBeGreaterThan(0);
    expect(por_siape[0].nominal).toBe(false);
    expect(por_siape[0].rotulo).not.toContain("Marco");
    expect(por_siape[0].rotulo).not.toContain("1110654");
  });

  it("itens e lotes", async () => {
    const amb = await novo();
    await _item(amb);
    const c = await como(amb, "almoxarife_sesmt");
    const itens = (await c.get("/api/v1/epis/itens")).json();
    expect(itens.length).toBeGreaterThan(0);
    for (const chave of ["id", "nome", "quantidade_padrao", "tamanhos", "exige_ca"]) expect(itens[0]).toHaveProperty(chave);
    const lotes = await c.get(`/api/v1/epis/itens/${itens[0].id}/lotes`);
    expect(lotes.status).toBe(200);
    expect(Array.isArray(lotes.json())).toBe(true);
    expect((await c.get("/api/v1/epis/itens/999999/lotes")).status).toBe(404);
  });

  it("registrar a entrega pela API grava a mesma ficha", async () => {
    const amb = await novo();
    const c = await como(amb, "coordenador_csso");
    const servidor_id = await _servidor(c);
    const item_id = await _item(amb);
    const resposta = await c.postJson(
      "/api/v1/epis/entregas",
      { servidor_id, item_id, quantidade: 1, data_evento: hoje() },
      { cabecalhos: FETCH },
    );
    if (resposta.status === 422) {
      // sem lote com CA válido o serviço recusa (RN-25): a recusa vem inteira
      const corpo = resposta.json();
      expect(corpo.erro).toBe("A entrega foi recusada.");
      expect(corpo.motivos.length).toBeGreaterThan(0);
      return;
    }
    expect(resposta.status, resposta.text).toBe(201);
    const corpo = resposta.json();
    expect(corpo.ficha).toBe(`/epis/fichas/${servidor_id}`);
    expect(corpo.comprovante.startsWith("/epis/fichas/registros/")).toBe(true);
    const [registro] = await amb.db.select().from(e.epi_ficha_registro).where(eq(e.epi_ficha_registro.id, corpo.registro_id));
    expect(registro?.servidor_id).toBe(servidor_id);

    const ficha = (await c.get(`/api/v1/epis/fichas/${servidor_id}`)).json();
    expect(ficha.nominal).toBe(true);
    expect(ficha.linhas[0].registro_id).toBe(corpo.registro_id);
    // a leitura pela API entra na trilha de acesso, como a da tela
    const acessos = await amb.db
      .select()
      .from(e.acesso_dado_sensivel)
      .where(eq(e.acesso_dado_sensivel.servidor_id, servidor_id))
      .orderBy(desc(e.acesso_dado_sensivel.id));
    expect(acessos[0]?.campo).toBe("epi_ficha");
  });

  it("entrega com data futura é recusada como na tela", async () => {
    const amb = await novo();
    const c = await como(amb, "coordenador_csso");
    const servidor_id = await _servidor(c);
    const item_id = await _item(amb);
    const resposta = await c.postJson(
      "/api/v1/epis/entregas",
      { servidor_id, item_id, quantidade: 1, data_evento: "2099-01-01" },
      { cabecalhos: FETCH },
    );
    expect(resposta.status).toBe(422);
    expect(resposta.json().erro).toBe("A entrega não pode ter data futura.");
  });

  it("a ficha de outro exige a permissão", async () => {
    const amb = await novo();
    const servidor_id = await _servidor(await como(amb, "coordenador_csso"));
    const c = await como(amb, "servidor_consulta");
    expect((await c.get(`/api/v1/epis/fichas/${servidor_id}`)).status).toBe(403);
  });
});

// =====================================================================
// A chamada
// =====================================================================
describe("a chamada", () => {
  it("turmas exige avaliar e filtra por situação", async () => {
    const amb = await novo();
    expect((await (await como(amb, "almoxarife_sesmt")).get("/api/v1/turmas")).status).toBe(403);
    const c = await como(amb, "coordenador_csso");
    expect((await c.get("/api/v1/turmas")).json()).toEqual([]);
    const ruim = await c.get("/api/v1/turmas?situacao=NADA");
    expect(ruim.status).toBe(422);
    expect(ruim.json().motivos).toContain("EM_ANDAMENTO");
  });

  it("grade de turma inexistente é 404 em JSON", async () => {
    const amb = await novo();
    const c = await como(amb, "coordenador_csso");
    const resposta = await c.get("/api/v1/turmas/999/presencas");
    expect(resposta.status).toBe(404);
    expect(resposta.json().erro).toContain("escopo");
  });

  // ------------------------------------------------------------------
  // Com uma turma de verdade — a montagem é a de `presenca.test.ts`
  // ------------------------------------------------------------------
  const INICIO = somar_dias(hoje(), -2);

  async function turma_rodando() {
    const amb = await novo();
    const c = await como(amb, "coordenador_csso");
    let r = await c.post(
      "/treinamentos/catalogo",
      { codigo: "NR-35", nome: "Trabalho em Altura — NR-35", carga_horaria_horas: "8", validade_meses: "24", norma_referencia: "NR-35" },
      { seguir: false },
    );
    expect(r.status, r.text.slice(0, 500)).toBe(303);
    const [t] = await amb.db.select().from(e.treinamento).orderBy(asc(e.treinamento.id)).limit(1);
    r = await c.post(
      "/turmas",
      {
        treinamento_id: String(t!.id),
        data_inicio: INICIO,
        data_fim: INICIO,
        local: "Auditório do Campus JK",
        frequencia_minima_percentual: "75",
      },
      { seguir: false },
    );
    expect(r.status, r.text.slice(0, 500)).toBe(303);
    const [turma] = await amb.db.select().from(e.turma).orderBy(asc(e.turma.id)).limit(1);
    for (const destino of ["INSCRICOES_ABERTAS", "EM_ANDAMENTO"]) {
      expect((await c.post(`/turmas/${turma!.id}/situacao`, { destino }, { seguir: false })).status).toBe(303);
    }
    const [sv] = await amb.db.insert(e.servidor).values({ siape: "1110654", nome: "Marco Antônio" }).returning();
    r = await c.post(`/turmas/${turma!.id}/inscricoes`, { servidor_id: String(sv!.id) }, { seguir: false });
    expect(r.status, r.text.slice(0, 500)).toBe(303);
    const [i] = await amb.db.select().from(e.inscricao).orderBy(desc(e.inscricao.id)).limit(1);
    return { cliente: c, turma_id: turma!.id, inscricao_id: i!.id };
  }

  it("a chamada pela API lança pelo mesmo serviço", async () => {
    const { cliente, turma_id, inscricao_id } = await turma_rodando();
    const turmas = (await cliente.get("/api/v1/turmas")).json();
    expect(turmas.map((t: { id: number }) => t.id)).toEqual([turma_id]);
    expect(turmas[0].dias).toEqual([INICIO]);
    expect(turmas[0].inscritos).toBe(1);

    const grade = (await cliente.get(`/api/v1/turmas/${turma_id}/presencas`)).json();
    expect(grade.retificando).toBe(false);
    let linha = grade.linhas[0];
    expect(linha.inscricao_id).toBe(inscricao_id);
    expect(linha.nominal).toBe(true);
    expect(linha.participante).toBe("Marco Antônio");
    expect(linha.por_dia).toEqual({});
    expect(linha.frequencia).toBe("0");

    const lancado = await cliente.postJson(
      `/api/v1/turmas/${turma_id}/presencas`,
      { inscricao_id, data: INICIO, presente: true },
      { cabecalhos: FETCH },
    );
    expect(lancado.status, lancado.text).toBe(200);
    linha = lancado.json().linhas[0];
    expect(linha.por_dia[INICIO].presente).toBe(true);
    expect(linha.frequencia).toBe("100");
  });

  it("a chamada pela API devolve a recusa do serviço", async () => {
    const { cliente, turma_id, inscricao_id } = await turma_rodando();
    const fora = `${Number(INICIO.slice(0, 4)) - 1}${INICIO.slice(4)}`;
    const recusa = await cliente.postJson(
      `/api/v1/turmas/${turma_id}/presencas`,
      { inscricao_id, data: fora, presente: true },
      { cabecalhos: FETCH },
    );
    expect(recusa.status).toBe(422);
    expect(recusa.json().erro).toBe("O lançamento foi recusado.");
    expect(recusa.json().motivos[0]).toContain("não é dia de");
    const inexistente = await cliente.postJson(
      `/api/v1/turmas/${turma_id}/presencas`,
      { inscricao_id: 999, data: INICIO },
      { cabecalhos: FETCH },
    );
    expect(inexistente.status).toBe(422);
    expect(inexistente.json().erro).toContain("Inscrição não encontrada");
  });
});

// =====================================================================
// A tela de bolso e o que a sustenta
// =====================================================================
describe("a tela de bolso", () => {
  it("abre e declara o que a pessoa pode", async () => {
    const amb = await novo();
    const corpo = (await (await como(amb, "almoxarife_sesmt")).get("/celular")).text;
    expect(corpo).toContain('data-pode-entregar="1"');
    expect(corpo).toContain('data-pode-chamada=""');
    expect(corpo).toContain('id="tela-balcao"');
    expect(corpo).not.toContain('id="tela-chamada"');
    expect(corpo).toContain('<link rel="manifest" href="/estaticos/manifest.webmanifest">');
    expect(corpo).toContain('<script src="/estaticos/js/celular.js" defer></script>');
    // o primeiro nome (o `split()[0]` do Jinja)
    expect(corpo).toMatch(/<span data-eu-nome>Almoxarife<\/span>/);
  });

  it("diz por que está vazia para quem não tem trabalho nela", async () => {
    const amb = await novo();
    const corpo = (await (await como(amb, "consulta_progep")).get("/celular")).text;
    expect(corpo).toContain("ainda não tem trabalho para você");
  });

  it("exige sessão", async () => {
    const amb = await novo();
    const resposta = await amb.novoCliente().get("/celular", { seguir: false });
    expect(resposta.status).toBe(303);
    expect(resposta.location).toContain("/login");
  });

  it("o service worker é servido da raiz, sem sessão; o manifesto e a folha existem", async () => {
    const amb = await novo();
    const sw = await amb.novoCliente().get("/sw.js");
    expect(sw.status).toBe(200);
    expect(sw.cabecalho("content-type")).toContain("javascript");
    expect(sw.cabecalho("cache-control")).toBe("no-cache");
    expect(sw.text).toContain("/api/");
    expect(sw.text).toContain("CASCA");
    // `/estaticos/` sai do CDN na nuvem (não passa pelo app): confere-se o arquivo publicado
    const estaticos = pastaDeEstaticos();
    const manifesto = JSON.parse(readFileSync(path.join(estaticos, "manifest.webmanifest"), "utf-8"));
    expect(manifesto.start_url).toBe("/celular");
    readFileSync(path.join(estaticos, "css", "celular.css"));
    readFileSync(path.join(estaticos, "img", "icone.svg"));
  });

  it("o service worker nunca guarda resposta da API", () => {
    const texto = readFileSync(path.join(pastaDeEstaticos(), "js", "sw.js"), "utf-8");
    const inicio = texto.indexOf("var CASCA = [");
    const casca = texto.slice(inicio, texto.indexOf("];", inicio));
    expect(casca).not.toContain("/api/");
    expect(texto).toContain("CASCA.indexOf(url.pathname) === -1");
  });
});
