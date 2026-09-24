/**
 * O editor do parecer pela tela: número editável, portaria sem sair do
 * editor, classificação escolhida, trava de edição simultânea, recusa que não
 * grava, escopo do titular, RN-19 na prévia, o painel de EPI e as entregas
 * (docx/pdf/prévia) inexistentes.
 *
 * Porte de `test_editor_ajustes.py`, `test_edicao_simultanea_parecer.py` e das
 * partes de `/pareceres` de `test_recusa_nao_grava.py`,
 * `test_rotas_nao_encontrado.py`, `test_comportamentos_de_tela.py`,
 * `test_escopo_do_titular.py`, `test_privacidade.py` e `test_epi_adicional.py`.
 * Os cadastros de campus/unidade/posto de `test_editor_ajustes.py` são da rota
 * de catálogos (outro trecho do porte).
 *
 * Um banco novo por teste: o Python tinha banco novo por teste, e estes testes
 * leem "o" parecer e "a" exposição do banco.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, asc, count, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import * as servico from "../src/servicos/parecer.js";
import * as epi_ficha from "../src/servicos/epi_ficha.js";
import * as datas_br from "../src/servicos/datas_br.js";
import { UsuarioAtual } from "../src/servicos/rbac.js";
import { bancoLimpo, contas, entrar, naTransacao, type AmbienteDeTeste, type Cliente } from "./ajuda";
import { atores, cenario, parecerDe } from "./ajuda_processos";

let amb: AmbienteDeTeste;
let db: Banco;

await bancoLimpo();

beforeEach(async () => {
  amb = await bancoLimpo();
  db = amb.db;
  await contas(db);
});

const HTML = { cabecalhos: { accept: "text/html" } };

async function abrir_rascunho(perfil = "coordenador_csso"): Promise<[Cliente, string, number]> {
  const cliente = await entrar(amb.novoCliente(), perfil);
  const criado = await cliente.post("/processos/novo", { nup: "23086.021284/2024-56", tipo_processo_id: "1" }, { seguir: false });
  expect(criado.status, criado.text.slice(0, 500)).toBe(303);
  const rascunho = await cliente.get(`${criado.location}/parecer`, { seguir: false });
  const caminho = rascunho.location!;
  return [cliente, caminho, Number(caminho.split("/").pop())];
}

async function o_parecer() {
  const todos = await db.select().from(e.parecer_tecnico);
  expect(todos).toHaveLength(1);
  return todos[0]!;
}

async function versao_na_tela(cliente: Cliente, caminho: string): Promise<string> {
  const corpo = (await cliente.get(caminho)).text;
  const achado = /name="versao_lida" value="(\d+)"/.exec(corpo);
  expect(achado, "o formulário tem de levar a versão que foi lida").toBeTruthy();
  return achado![1]!;
}

async function famed_id(): Promise<number> {
  const [famed] = await db.select().from(e.unidade_uorg).where(eq(e.unidade_uorg.codigo_uorg, "250"));
  return famed!.id;
}

async function quantos_eventos(tipo?: string): Promise<number> {
  const [l] = await db
    .select({ n: count() })
    .from(e.historico_evento)
    .where(tipo ? eq(e.historico_evento.tipo_evento, tipo) : undefined);
  return l!.n;
}

// =====================================================================
// Número editável (test_editor_ajustes)
// =====================================================================
describe("número do parecer", () => {
  it("pode ser digitado no rascunho", async () => {
    const [cliente, caminho] = await abrir_rascunho();
    expect((await cliente.get(caminho)).text).toContain('name="numero"');
    await cliente.post(caminho, { numero: "9", ano: "2026" }, { seguir: false });
    expect((await o_parecer()).numero).toBe(9);
  });

  it("número já usado é recusado", async () => {
    await db.insert(e.parecer_tecnico).values({ numero: 9, ano: 2026, situacao: "RESERVADO" });
    const [cliente, caminho] = await abrir_rascunho();
    const r = await cliente.post(caminho, { numero: "9", ano: "2026" });
    expect(r.text).toContain("já pertence a outro parecer");
  });

  it("número digitado empurra a sequência", async () => {
    const [cliente, caminho] = await abrir_rascunho();
    await cliente.post(caminho, { numero: "37", ano: "2026" }, { seguir: false });
    const [seq] = await db.select().from(e.parecer_sequencia).where(eq(e.parecer_sequencia.ano, 2026));
    expect(seq!.ultimo_numero).toBe(37);
  });

  it("a alteração do número fica na auditoria", async () => {
    const [cliente, caminho] = await abrir_rascunho();
    await cliente.post(caminho, { numero: "12", ano: "2026" }, { seguir: false });
    const [evento] = await db
      .select()
      .from(e.historico_evento)
      .where(eq(e.historico_evento.tipo_evento, "NUMERO_DEFINIDO_MANUALMENTE"));
    expect(evento).toBeTruthy();
    expect(evento!.valor_novo).toBe(12);
  });

  it("número repetido não deixa o parecer com ano novo e número velho (test_recusa_nao_grava)", async () => {
    await db.insert(e.parecer_tecnico).values({ numero: 9, ano: 2027, situacao: "RESERVADO" });
    const [cliente, caminho, id] = await abrir_rascunho();
    const [antes] = await db.select().from(e.parecer_tecnico).where(eq(e.parecer_tecnico.id, id));
    expect(antes!.ano).not.toBe(2027);
    const r = await cliente.post(caminho, { numero: "9", ano: "2027" });
    expect(r.text).toContain("já pertence a outro parecer");
    const [depois] = await db.select().from(e.parecer_tecnico).where(eq(e.parecer_tecnico.id, id));
    expect(depois!.ano).toBe(antes!.ano);
    expect(depois!.numero).toBe(0);
  });

  it("o formulário declara chave e versão do rascunho local; salvar incrementa a versão", async () => {
    const [cliente, caminho, id] = await abrir_rascunho();
    const corpo = (await cliente.get(caminho)).text;
    expect(corpo).toContain(`data-rascunho-local="parecer-${id}"`);
    const versao = Number(/data-rascunho-versao="(\d+)"/.exec(corpo)![1]);
    await cliente.post(caminho, { ano: "2026" }, { seguir: false });
    const nova = Number(/data-rascunho-versao="(\d+)"/.exec((await cliente.get(caminho)).text)![1]);
    expect(nova).toBe(versao + 1);
  });
});

// =====================================================================
// Portaria pelo próprio editor
// =====================================================================
describe("portaria pelo editor", () => {
  it("cadastra sem sair do editor e já vincula", async () => {
    const [cliente, caminho] = await abrir_rascunho();
    const corpo = (await cliente.get(caminho)).text;
    expect(corpo).toContain('href="#cadastrar-portaria" data-abre-popup>Cadastrar portaria</a>');
    expect(corpo).toContain('<h2 id="cadastrar-portaria-titulo">Cadastrar portaria</h2>');
    expect(corpo).toContain("nenhuma cadastrada");

    const r = await cliente.post(
      `${caminho}/portaria`,
      { texto_original: "PORTARIA/FAMED Nº 35, DE 17 DE SETEMBRO DE 2024", unidade_emissora_id: await famed_id() },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    const portarias = await db.select().from(e.portaria_localizacao);
    expect(portarias).toHaveLength(1);
    expect(portarias[0]!.numero).toBe("35");
    expect(portarias[0]!.data_publicacao).toBe("2024-09-17");
    expect(portarias[0]!.texto_original.startsWith("PORTARIA/FAMED")).toBe(true);
    expect((await o_parecer()).portaria_id).toBe(portarias[0]!.id);
  });

  it("portaria sem data legível avisa", async () => {
    const [cliente, caminho] = await abrir_rascunho();
    const r = await cliente.post(`${caminho}/portaria`, {
      texto_original: "portaria sem data",
      unidade_emissora_id: await famed_id(),
    });
    expect(r.text).toContain("não consegui ler a data");
  });

  it("portaria repetida reaproveita (035, 35 e 0035 são a mesma)", async () => {
    const [cliente, caminho] = await abrir_rascunho();
    const dados = { texto_original: "PORTARIA/FAMED Nº 035, DE 17 DE SETEMBRO DE 2024", unidade_emissora_id: await famed_id() };
    await cliente.post(`${caminho}/portaria`, dados, { seguir: false });
    await cliente.post(`${caminho}/portaria`, dados, { seguir: false });
    expect(await db.select().from(e.portaria_localizacao)).toHaveLength(1);
  });

  it("formulário incompleto vira tela 422 com casca; quem não pede HTML recebe JSON", async () => {
    const cliente = await entrar(amb.novoCliente(), "coordenador_csso");
    const tela = await cliente.post(
      "/pareceres/1/portaria",
      { texto_original: "PORTARIA X" },
      { cabecalhos: { accept: "text/html,application/xhtml+xml" } },
    );
    expect(tela.status).toBe(422);
    expect(tela.text).toContain("formulário incompleto");
    expect(tela.text).toContain("unidade_emissora_id");
    expect(tela.text).toContain("nada foi gravado");
    expect(tela.text).toContain('class="lateral"');
    const json = await cliente.post("/pareceres/1/portaria", { texto_original: "PORTARIA X" });
    expect(json.status).toBe(422);
    expect(json.json()).toHaveProperty("detail");
  });
});

// =====================================================================
// Classificação e exposições
// =====================================================================
describe("classificação e exposições", () => {
  const nova = () => ({
    horas_exposicao_mensais: null as string | number | null,
    jornada_mensal_horas: null as string | number | null,
    percentual_jornada: null as string | number | null,
    classificacao_exposicao: null as string | null,
    classificacao_origem: "CALCULADA",
  });

  it("informada quando não há medição", () => {
    const x = servico.aplicar_classificacao(nova(), "HABITUAL");
    expect(x.classificacao_exposicao).toBe("HABITUAL");
    expect(x.classificacao_origem).toBe("INFORMADA");
    expect(x.percentual_jornada).toBeNull();
  });

  it("a medição prevalece sobre a escolha", () => {
    const x = servico.aplicar_classificacao({ ...nova(), horas_exposicao_mensais: 160, jornada_mensal_horas: 160 }, "EVENTUAL");
    expect(x.classificacao_exposicao).toBe("PERMANENTE");
    expect(x.classificacao_origem).toBe("CALCULADA");
    expect(servico.divergencia_de_classificacao(x, "EVENTUAL")).toContain("prevaleceu a medição");
    expect(servico.divergencia_de_classificacao(x, "EVENTUAL")).toContain("(100.0%)");
  });

  it("sem horas e sem escolha fica indefinida; valor inválido é ignorado", () => {
    expect(servico.aplicar_classificacao(nova(), null).classificacao_exposicao).toBeNull();
    expect(servico.aplicar_classificacao(nova(), "SEMPRE").classificacao_exposicao).toBeNull();
  });

  async function agente_e_percentual() {
    const [agente] = await db
      .select()
      .from(e.agente_nocivo)
      .where(eq(e.agente_nocivo.descricao, "Contato permanente com material infecto-contagiante"));
    const [percentual] = await db.select().from(e.percentual_aplicavel).orderBy(asc(e.percentual_aplicavel.id)).limit(1);
    return [agente!, percentual!] as const;
  }

  it("a classificação escolhida pela tela", async () => {
    const [cliente, caminho] = await abrir_rascunho();
    expect((await cliente.get(caminho)).text).toContain("Classificação (art. 9º)");
    const [agente, percentual] = await agente_e_percentual();
    await cliente.post(
      `${caminho}/exposicoes`,
      { agente_nocivo_id: agente.id, percentual_id: percentual.id, classificacao: "PERMANENTE", principal: "1" },
      { seguir: false },
    );
    const exposicoes = await db.select().from(e.exposicao);
    expect(exposicoes).toHaveLength(1);
    expect(exposicoes[0]!.classificacao_exposicao).toBe("PERMANENTE");
    expect(exposicoes[0]!.classificacao_origem).toBe("INFORMADA");
    expect((await cliente.get(caminho)).text).toContain("informada");
  });

  it("horas informadas: a divergência vai para a trilha e a medição fica", async () => {
    const [cliente, caminho] = await abrir_rascunho();
    const [agente, percentual] = await agente_e_percentual();
    await cliente.post(
      `${caminho}/exposicoes`,
      {
        agente_nocivo_id: agente.id,
        percentual_id: percentual.id,
        classificacao: "EVENTUAL",
        horas_exposicao_mensais: "160",
        jornada_mensal_horas: "160",
      },
      { seguir: false },
    );
    const [x] = await db.select().from(e.exposicao);
    expect(x!.classificacao_exposicao).toBe("PERMANENTE");
    expect(Number(x!.percentual_jornada)).toBe(100);
    expect(await quantos_eventos("CLASSIFICACAO_DIVERGENTE")).toBe(1);
    // o mesmo agente duas vezes é recusado
    const r = await cliente.post(`${caminho}/exposicoes`, { agente_nocivo_id: agente.id, percentual_id: percentual.id });
    expect(r.text).toContain("Esse agente já está no parecer.");
  });

  it("remover exposição diz o que leva junto antes de apagar", async () => {
    const [cliente, caminho] = await abrir_rascunho();
    const [agente, percentual] = await agente_e_percentual();
    await cliente.post(
      `${caminho}/exposicoes`,
      { agente_nocivo_id: agente.id, percentual_id: percentual.id, classificacao: "PERMANENTE", principal: "1" },
      { seguir: false },
    );
    const [x] = await db.select().from(e.exposicao);
    const corpo = (await cliente.get(caminho)).text;
    const acao = `${caminho}/exposicoes/${x!.id}/excluir`;
    expect(corpo).toContain(acao);
    const gatilho = `href="#acoes-exposicao-${x!.id}"`;
    expect(corpo).toContain(gatilho);
    expect(corpo.indexOf(gatilho)).toBeLessThan(corpo.indexOf(acao));
    expect(corpo).toContain(`<dialog class="popup popup-gaveta" id="acoes-exposicao-${x!.id}"`);
    expect(corpo).toContain("as horas e a jornada declaradas");
    expect(corpo).toContain(agente.descricao);
    await cliente.post(acao, {}, { seguir: false });
    expect(await db.select().from(e.exposicao)).toHaveLength(0);
  });

  it("emitir com trava continua sendo botão desabilitado", async () => {
    const [cliente, caminho] = await abrir_rascunho();
    const corpo = (await cliente.get(caminho)).text;
    expect(corpo).toContain("bloqueio(s)");
    expect(corpo).not.toContain('href="#emitir-parecer"');
    expect(corpo).not.toContain('id="emitir-parecer"');
    expect(corpo).toContain('<button type="button" disabled>Emitir (consome número)</button>');
  });

  it("o rascunho tem os campos ligados", async () => {
    const [cliente, caminho] = await abrir_rascunho();
    const corpo = (await cliente.get(caminho)).text;
    expect(corpo).toContain('<fieldset class="campos">');
    expect(corpo).not.toContain("Conteúdo congelado");
  });
});

// =====================================================================
// Edição simultânea (test_edicao_simultanea_parecer)
// =====================================================================
describe("duas pessoas no mesmo rascunho", () => {
  it("a segunda, com versão velha, é recusada — e o que escreveu volta", async () => {
    const [coord, caminho] = await abrir_rascunho();
    const outra = await entrar(amb.novoCliente(), "tecnico_seguranca");
    const lida_coord = await versao_na_tela(coord, caminho);
    const lida_tecnica = await versao_na_tela(outra, caminho);
    expect(lida_coord).toBe(lida_tecnica);

    const primeira = await outra.post(
      caminho,
      { ano: "2026", versao_lida: lida_tecnica, texto_alteracao: "Texto da técnica." },
      { seguir: false },
    );
    expect(primeira.status).toBe(303);

    const segunda = await coord.post(caminho, { ano: "2026", versao_lida: lida_coord, texto_alteracao: "Texto do coordenador." });
    expect(segunda.status).toBe(200);
    expect(segunda.text).toContain("Técnica de Teste salvou este parecer");
    expect(segunda.text).toContain("Nada do que você enviou foi gravado");
    expect(segunda.text).toContain("Não gravado");
    expect(segunda.text).toContain("Texto do coordenador.");
    expect((await o_parecer()).texto_alteracao).toBe("Texto da técnica.");
  });

  it("a mesma pessoa em duas abas é avisada como tal", async () => {
    const [cliente, caminho] = await abrir_rascunho();
    const lida = await versao_na_tela(cliente, caminho);
    await cliente.post(caminho, { ano: "2026", versao_lida: lida, texto_reavaliacao: "Aba 1." }, { seguir: false });
    const r = await cliente.post(caminho, { ano: "2026", versao_lida: lida, texto_reavaliacao: "Aba 2." });
    expect(r.text).toContain("Você mesmo salvou este parecer em outra aba");
    expect((await o_parecer()).texto_reavaliacao).toBe("Aba 1.");
  });

  it("versão em dia salva normalmente", async () => {
    const [cliente, caminho] = await abrir_rascunho();
    for (const texto of ["Primeiro.", "Segundo."]) {
      const lida = await versao_na_tela(cliente, caminho);
      const r = await cliente.post(caminho, { ano: "2026", versao_lida: lida, texto_alteracao: texto }, { seguir: false });
      expect(r.status).toBe(303);
      expect((await o_parecer()).texto_alteracao).toBe(texto);
    }
  });

  it("a recusa não consome versão nem escreve auditoria", async () => {
    const [cliente, caminho] = await abrir_rascunho();
    const lida = await versao_na_tela(cliente, caminho);
    await cliente.post(caminho, { ano: "2026", versao_lida: lida, texto_alteracao: "Vale." }, { seguir: false });
    const versao = (await o_parecer()).versao;
    // a leitura nominal da tela entra em `acesso_dado_sensivel`, não na trilha
    const eventos = await quantos_eventos();
    await cliente.post(caminho, { ano: "2026", versao_lida: lida, texto_alteracao: "Não vale." });
    expect((await o_parecer()).versao).toBe(versao);
    expect(await quantos_eventos()).toBe(eventos);
  });
});

// =====================================================================
// Emissão pela tela: a recusa não carimba a data (test_recusa_nao_grava)
// =====================================================================
describe("emissão pela tela", () => {
  it("emissão bloqueada não carimba a data de emissão", async () => {
    const [cliente, caminho, id] = await abrir_rascunho();
    const [habilitado] = await db
      .select()
      .from(e.profissional_habilitado)
      .where(eq(e.profissional_habilitado.nome, "Fabrício Raimundi Andrade"));
    // signatário em ordem: o bloqueio vem dos campos que faltam, não da RN-01
    await db.update(e.parecer_tecnico).set({ signatario_id: habilitado!.id }).where(eq(e.parecer_tecnico.id, id));
    const r = await cliente.post(`${caminho}/emitir`, {});
    expect(r.text).toContain("laudo técnico");
    const [depois] = await db.select().from(e.parecer_tecnico).where(eq(e.parecer_tecnico.id, id));
    expect(depois!.data_emissao).toBeNull();
    expect(depois!.situacao).toBe("RASCUNHO");
  });

  it("signatário sem habilitação guarda o evento mas não a data (403)", async () => {
    const [cliente, caminho, id] = await abrir_rascunho(); // nasce sem signatário
    const antes = await quantos_eventos("ASSINATURA_NEGADA");
    const r = await cliente.post(`${caminho}/emitir`, {}, HTML);
    expect(r.status).toBe(403);
    expect(await quantos_eventos("ASSINATURA_NEGADA")).toBe(antes + 1);
    const [depois] = await db.select().from(e.parecer_tecnico).where(eq(e.parecer_tecnico.id, id));
    expect(depois!.data_emissao).toBeNull();
  });

  it("emite pela tela, sai com o aviso de PDF, e assinar exige habilitação", async () => {
    const parecer_id = await naTransacao(async (tx) => (await cenario(tx)).parecer_id);
    const cliente = await entrar(amb.novoCliente(), "coordenador_csso");
    const r = await cliente.post(`/pareceres/${parecer_id}/emitir`, {}, { seguir: false });
    expect(r.status).toBe(303);
    expect(decodeURIComponent(r.location!)).toContain("Parecer 1/2025 emitido. PDF indisponível");
    const [p] = await db.select().from(e.parecer_tecnico).where(eq(e.parecer_tecnico.id, parecer_id));
    expect(p!.situacao).toBe("EMITIDO");
    // a técnica não subscreve: 403 e o evento fica
    const tecnica = await entrar(amb.novoCliente(), "tecnico_seguranca");
    const antes = await quantos_eventos("ASSINATURA_NEGADA");
    expect((await tecnica.post(`/pareceres/${parecer_id}/assinar`, {}, HTML)).status).toBe(403);
    expect(await quantos_eventos("ASSINATURA_NEGADA")).toBe(antes + 1);
    // o coordenador (habilitado por `contas`) assina
    const assinado = await cliente.post(`/pareceres/${parecer_id}/assinar`, {}, { seguir: false });
    expect(assinado.status).toBe(303);
    const [depois] = await db.select().from(e.parecer_tecnico).where(eq(e.parecer_tecnico.id, parecer_id));
    expect(depois!.situacao).toBe("ASSINADO");
    // anular sem motivo volta ao editor; com motivo, anula
    expect((await cliente.post(`/pareceres/${parecer_id}/anular`, { motivo: "  " })).text).toContain("anulação exige motivo");
    await cliente.post(`/pareceres/${parecer_id}/anular`, { motivo: "erro material" }, { seguir: false });
    const [anulado] = await db.select().from(e.parecer_tecnico).where(eq(e.parecer_tecnico.id, parecer_id));
    expect(anulado!.situacao).toBe("ANULADO");
  });

  it.each(["EMITIDO", "ASSINADO", "ANULADO"])("o parecer %s desliga o formulário inteiro", async (situacao) => {
    const parecer_id = await naTransacao(async (tx) => {
      const a = await atores(tx);
      const c = await cenario(tx);
      const p = await parecerDe(tx, c.parecer_id);
      await servico.emitir(tx, p, a.COORDENADOR, { gerar_pdf: false });
      if (situacao === "ASSINADO") {
        await tx.update(e.parecer_tecnico).set({ situacao: "ASSINADO" }).where(eq(e.parecer_tecnico.id, p.id));
      } else if (situacao === "ANULADO") {
        await servico.anular(tx, p, a.COORDENADOR, "teste");
      }
      return p.id;
    });
    const cliente = await entrar(amb.novoCliente(), "coordenador_csso");
    const corpo = (await cliente.get(`/pareceres/${parecer_id}`)).text;
    expect(corpo).toContain('<fieldset class="campos" disabled>');
    expect(corpo).not.toContain("Salvar rascunho");
    if (situacao === "ANULADO") expect(corpo).toContain("Parecer anulado.");
    else expect(corpo).toContain("Conteúdo congelado na emissão (RN-14)");
    // e a rota recusa salvar por cima do emitido
    if (situacao !== "ANULADO") {
      expect((await cliente.post(`/pareceres/${parecer_id}`, { ano: "2025" })).text).toContain("imutável (RN-14)");
    }
  });

  it("o botão de PDF diz antes do clique que o PDF não sai", async () => {
    const parecer_id = await naTransacao(async (tx) => {
      const a = await atores(tx);
      const c = await cenario(tx);
      await servico.emitir(tx, await parecerDe(tx, c.parecer_id), a.COORDENADOR, { gerar_pdf: false });
      return c.parecer_id;
    });
    const cliente = await entrar(amb.novoCliente(), "coordenador_csso");
    const corpo = (await cliente.get(`/pareceres/${parecer_id}`)).text;
    expect(corpo).toContain("Gerar PDF");
    expect(corpo).toContain("indisponível — sai o .docx");
    const pdf = await cliente.get(`/pareceres/${parecer_id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.cabecalho("content-type")).toContain("wordprocessingml");
    expect(pdf.cabecalho("content-disposition")).toContain("Antonio");
  });
});

// =====================================================================
// Id inexistente (test_rotas_nao_encontrado) e escopo do titular
// =====================================================================
describe("id inexistente e escopo do titular", () => {
  it("/pareceres/{id} inexistente volta à lista (303); docx/pdf/prévia dão 404", async () => {
    const cliente = await entrar(amb.novoCliente(), "coordenador_csso");
    const ficha = await cliente.get("/pareceres/999999", { ...HTML, seguir: false });
    expect([303, 404]).toContain(ficha.status);
    for (const rota of ["docx", "pdf", "previa"]) {
      const r = await cliente.get(`/pareceres/999999/${rota}`, { ...HTML, seguir: false });
      expect(r.status, rota).toBe(404);
    }
  });

  async function cena() {
    return naTransacao(async (tx) => {
      const [cargo] = await tx.select().from(e.cargo).orderBy(asc(e.cargo.id)).limit(1);
      const [unidade] = await tx.select().from(e.unidade_uorg).orderBy(asc(e.unidade_uorg.id)).limit(1);
      const [etapa] = await tx.select().from(e.fluxo_etapa).where(eq(e.fluxo_etapa.codigo, "EM_ANDAMENTO"));
      const [tipo] = await tx.select().from(e.tipo_processo).where(eq(e.tipo_processo.codigo, "ADICIONAL_OCUPACIONAL"));
      const ids: Record<string, number> = {};
      for (const [papel, siape, nome, nup, numero] of [
        ["titular", "3010011", "Adelaide Nunes Prata", "23086.000111/2026-11", 901],
        ["terceiro", "3010077", "Gorete Vasconcelos Pimenta", "23086.000222/2026-22", 902],
      ] as const) {
        const [servidor] = await tx
          .insert(e.servidor)
          .values({ siape, nome, cargo_id: cargo!.id, unidade_uorg_id: unidade!.id })
          .returning();
        const [processo] = await tx
          .insert(e.processo)
          .values({
            nup,
            tipo_processo_id: tipo!.id,
            etapa_id: etapa!.id,
            estado_tecnico: "PARECER_EM_ELABORACAO",
            servidor_id: servidor!.id,
            unidade_uorg_id: unidade!.id,
            data_autuacao: "2026-01-05",
          })
          .returning();
        const [parecer] = await tx
          .insert(e.parecer_tecnico)
          .values({
            numero,
            ano: 2026,
            situacao: "RASCUNHO",
            processo_id: processo!.id,
            servidor_id: servidor!.id,
            unidade_uorg_id: unidade!.id,
          })
          .returning();
        ids[`servidor_${papel}`] = servidor!.id;
        ids[`parecer_${papel}`] = parecer!.id;
      }
      await tx
        .update(e.usuario)
        .set({ servidor_id: ids.servidor_titular })
        .where(eq(e.usuario.login, "servidor_consulta"));
      return ids;
    });
  }

  async function acessos(servidor_id: number) {
    return db.select().from(e.acesso_dado_sensivel).where(eq(e.acesso_dado_sensivel.servidor_id, servidor_id));
  }

  it("o titular lendo o próprio parecer não vira linha de acesso; o de terceiro deixa rastro", async () => {
    const ids = await cena();
    const titular = await entrar(amb.novoCliente(), "servidor_consulta");
    expect((await titular.get(`/pareceres/${ids.parecer_titular}`)).status).toBe(200);
    expect(await acessos(ids.servidor_titular!)).toEqual([]);
    for (const perfil of ["coordenador_csso", "secretaria_csso"]) {
      const c = await entrar(amb.novoCliente(), perfil);
      expect((await c.get(`/pareceres/${ids.parecer_terceiro}`)).status).toBe(200);
    }
    const campos = new Set((await acessos(ids.servidor_terceiro!)).map((a) => a.campo));
    expect(campos.has("parecer_tecnico.nominal")).toBe(true);
  });

  it("o titular abre o próprio parecer e não o de terceiro; o documento de terceiro não sai", async () => {
    const ids = await cena();
    const titular = await entrar(amb.novoCliente(), "servidor_consulta");
    expect((await titular.get(`/pareceres/${ids.parecer_titular}`, { seguir: false })).status).toBe(200);
    expect((await titular.get(`/pareceres/${ids.parecer_terceiro}`, { seguir: false })).status).toBe(303);
    for (const sufixo of ["/docx", "/pdf", "/previa"]) {
      expect((await titular.get(`/pareceres/${ids.parecer_terceiro}${sufixo}`)).status, sufixo).toBe(404);
    }
    // "não existe" e "não pode" respondem igual
    for (const molde of ["/pareceres/{}", "/pareceres/{}/docx", "/pareceres/{}/previa"]) {
      const inexistente = await titular.get(molde.replace("{}", "999999"), { seguir: false });
      const proibido = await titular.get(molde.replace("{}", String(ids.parecer_terceiro)), { seguir: false });
      expect(inexistente.status, molde).toBe(proibido.status);
      expect(inexistente.location).toBe(proibido.location);
    }
  });

  it("a equipe da CSSO e o auditor continuam vendo o parecer de qualquer servidor", async () => {
    const ids = await cena();
    for (const perfil of ["coordenador_csso", "engenheiro_seguranca", "tecnico_seguranca", "medico_trabalho", "auditor_interno"]) {
      const c = await entrar(amb.novoCliente(), perfil);
      for (const chave of ["parecer_titular", "parecer_terceiro"]) {
        expect((await c.get(`/pareceres/${ids[chave]}`)).status, `${perfil} ${chave}`).toBe(200);
      }
    }
  });
});

// =====================================================================
// RN-19 na prévia (test_privacidade)
// =====================================================================
describe("RN-19 na prévia do parecer", () => {
  const NOME = "Adelaide Nunes Prata";
  const SIAPE = "3010011";

  async function parecer_do_servidor() {
    return naTransacao(async (tx) => {
      const [insal] = await tx.select().from(e.tipo_adicional).where(eq(e.tipo_adicional.codigo, "INSALUBRIDADE"));
      const [servidor] = await tx.insert(e.servidor).values({ siape: SIAPE, nome: NOME }).returning();
      const [p] = await tx
        .insert(e.parecer_tecnico)
        .values({
          numero: 0,
          ano: Number(datas_br.hoje().slice(0, 4)),
          situacao: "RASCUNHO",
          servidor_id: servidor!.id,
          tipo_adicional_id: insal!.id,
        })
        .returning();
      return { parecer: p!.id, servidor: servidor!.id };
    });
  }

  it("a prévia não entrega nome nem SIAPE a quem não tem exposicao.ver", async () => {
    const { parecer } = await parecer_do_servidor();
    const secretaria = await entrar(amb.novoCliente(), "secretaria_csso");
    for (const caminho of [`/pareceres/${parecer}`, `/pareceres/${parecer}/previa`]) {
      const r = await secretaria.get(caminho);
      expect(r.status, caminho).toBe(200);
      expect(r.text, caminho).not.toContain(NOME);
      expect(r.text, caminho).not.toContain(SIAPE);
      expect(/SRV-[0-9a-f]{4}\b/.test(r.text), caminho).toBe(true);
    }
  });

  it("continua nominal para quem vê exposição, e para o titular", async () => {
    const { parecer, servidor } = await parecer_do_servidor();
    const coord = await entrar(amb.novoCliente(), "coordenador_csso");
    const corpo = (await coord.get(`/pareceres/${parecer}/previa`)).text;
    expect(corpo).toContain(NOME);
    expect(corpo).toContain(SIAPE);
    await db.update(e.usuario).set({ servidor_id: servidor }).where(eq(e.usuario.login, "servidor_consulta"));
    const titular = await entrar(amb.novoCliente(), "servidor_consulta");
    expect((await titular.get(`/pareceres/${parecer}/previa`)).text).toContain(NOME);
  });
});

// =====================================================================
// O painel de EPI do editor (test_epi_adicional, §6)
// =====================================================================
describe("o painel de EPI do editor", () => {
  const ENTREGA = "2024-10-01";
  const AVALIACAO = "2025-02-11";

  async function montar_para_a_tela(codigo_adicional: string, validade_ca: string) {
    return naTransacao(async (tx) => {
      const [unidade] = await tx.select().from(e.unidade_uorg).orderBy(asc(e.unidade_uorg.id)).limit(1);
      const [cargo] = await tx.select().from(e.cargo).orderBy(asc(e.cargo.id)).limit(1);
      const [adicional] = await tx.select().from(e.tipo_adicional).where(eq(e.tipo_adicional.codigo, codigo_adicional));
      const [percentual] = await tx
        .select()
        .from(e.percentual_aplicavel)
        .where(eq(e.percentual_aplicavel.tipo_adicional_id, adicional!.id))
        .orderBy(asc(e.percentual_aplicavel.id))
        .limit(1);
      const [agente] = await tx.select().from(e.agente_nocivo).orderBy(asc(e.agente_nocivo.id)).limit(1);
      const [etapa] = await tx.select().from(e.fluxo_etapa).where(eq(e.fluxo_etapa.codigo, "EM_ANDAMENTO"));
      const [tipo] = await tx.select().from(e.tipo_processo).where(eq(e.tipo_processo.codigo, "ADICIONAL_OCUPACIONAL"));
      const [servidor] = await tx
        .insert(e.servidor)
        .values({ siape: "7654321", nome: "Joana Ribeiro de Almeida", cargo_id: cargo!.id, unidade_uorg_id: unidade!.id })
        .returning();
      const [processo] = await tx
        .insert(e.processo)
        .values({
          nup: "23086.021284/2024-56",
          tipo_processo_id: tipo!.id,
          etapa_id: etapa!.id,
          estado_tecnico: "PARECER_EM_ELABORACAO",
          servidor_id: servidor!.id,
          unidade_uorg_id: unidade!.id,
          data_autuacao: "2024-10-01",
        })
        .returning();
      const [laudo] = await tx
        .insert(e.laudo_tecnico)
        .values({
          numero_siape: "26255-000.125/2019",
          ano: 2019,
          tipo_adicional_id: adicional!.id,
          unidade_uorg_id: unidade!.id,
          data_emissao: "2019-06-01",
        })
        .returning();
      const [parecer] = await tx
        .insert(e.parecer_tecnico)
        .values({
          numero: 0,
          ano: 2025,
          situacao: "RASCUNHO",
          processo_id: processo!.id,
          servidor_id: servidor!.id,
          laudo_id: laudo!.id,
          tipo_adicional_id: adicional!.id,
          unidade_uorg_id: unidade!.id,
        })
        .returning();
      const [exposicao] = await tx
        .insert(e.exposicao)
        .values({
          parecer_id: parecer!.id,
          agente_nocivo_id: agente!.id,
          percentual_id: percentual!.id,
          fundamentacao_id: agente!.fundamentacao_id!,
          principal: true,
          data_avaliacao: AVALIACAO,
        })
        .returning();
      const [categoria] = await tx
        .select()
        .from(e.epi_categoria)
        .where(eq(e.epi_categoria.codigo, "PROT_MEMBROS_SUPERIORES"));
      const [item] = await tx
        .insert(e.epi_item)
        .values({
          nome: "Luva de proteção química nitrílica",
          categoria_id: categoria!.id,
          exige_ca: true,
          numero_ca: "41234",
          validade_ca,
          unidade_medida: "PAR",
          vida_util_meses: 6,
        })
        .returning();
      const [entrada] = await tx
        .insert(e.epi_entrada_estoque)
        .values({
          epi_item_id: item!.id,
          data_entrada: datas_br.somar_dias(ENTREGA, -30),
          quantidade_recebida: 20,
          lote: "L-2024-09",
          numero_ca: "41234",
          validade_ca,
        })
        .returning();
      await tx.insert(e.epi_movimento_estoque).values({ entrada_id: entrada!.id, tipo: "ENTRADA", quantidade: 20 });
      const [conta] = await tx.select().from(e.usuario).where(eq(e.usuario.login, "almoxarife_sesmt"));
      await epi_ficha.registrar_entrega(
        tx,
        new UsuarioAtual({ id: conta!.id, login: "semente", nome: "Almoxarifado", permissoes: ["epi.entregar"], perfis: [] }),
        { servidor: servidor!, item: item!, quantidade: 2, entrada: entrada!, tamanho: "M", data_evento: ENTREGA },
      );
      return { parecer: parecer!.id, exposicao: exposicao!.id };
    });
  }

  it("a tela diz que CA vencido não sustenta neutralização", async () => {
    const ids = await montar_para_a_tela("INSALUBRIDADE", "2024-12-31");
    const cliente = await entrar(amb.novoCliente(), "coordenador_csso");
    const pagina = await cliente.get(`/pareceres/${ids.parecer}`);
    expect(pagina.status).toBe(200);
    for (const trecho of [
      "EPI recebido até 11/02/2025",
      "Luva de proteção química nitrílica",
      "31/12/2024",
      "Não sustenta neutralização porque",
      "não sustenta</strong> alegação de neutralização",
      "RN-32",
      'value="NEUTRALIZA"',
      'value="NEUTRALIZA_PARCIAL"',
    ]) {
      expect(pagina.text, trecho).toContain(trecho);
    }
    expect(pagina.text).not.toContain("EPI não cessa periculosidade");
  });

  it("a tela não oferece neutralização para periculosidade", async () => {
    const ids = await montar_para_a_tela("PERICULOSIDADE", "2030-01-01");
    const cliente = await entrar(amb.novoCliente(), "coordenador_csso");
    const pagina = await cliente.get(`/pareceres/${ids.parecer}`);
    expect(pagina.status).toBe(200);
    expect(pagina.text).toContain("EPI não cessa periculosidade");
    expect(pagina.text).not.toContain('value="NEUTRALIZA"');
    expect(pagina.text).not.toContain('value="NEUTRALIZA_PARCIAL"');
    expect(pagina.text).toContain('value="NAO_NEUTRALIZA"');
  });

  it("a rota recusa neutralizar periculosidade e não grava", async () => {
    const ids = await montar_para_a_tela("PERICULOSIDADE", "2030-01-01");
    const cliente = await entrar(amb.novoCliente(), "coordenador_csso");
    const r = await cliente.post(`/pareceres/${ids.parecer}/exposicoes/${ids.exposicao}/epi`, {
      epi_neutraliza: "NEUTRALIZA",
      justificativa_epi: "luva isolante classe 2",
    });
    expect(r.status).toBe(200);
    expect(r.text).toContain("não cessa periculosidade");
    const [x] = await db.select().from(e.exposicao).where(eq(e.exposicao.id, ids.exposicao));
    expect(x!.epi_neutraliza).toBe("NAO_AVALIADO");
    expect(x!.justificativa_epi).toBeNull();
  });

  it("insalubridade aceita a avaliação pela tela (coordenador habilitado)", async () => {
    const ids = await montar_para_a_tela("INSALUBRIDADE", "2030-01-01");
    const cliente = await entrar(amb.novoCliente(), "coordenador_csso");
    const r = await cliente.post(
      `/pareceres/${ids.parecer}/exposicoes/${ids.exposicao}/epi`,
      { epi_neutraliza: "NEUTRALIZA_PARCIAL", justificativa_epi: "luva nitrílica com CA vigente na data" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    const [x] = await db.select().from(e.exposicao).where(eq(e.exposicao.id, ids.exposicao));
    expect(x!.epi_neutraliza).toBe("NEUTRALIZA_PARCIAL");
    void and;
  });
});

// =====================================================================
// Integração: dois defeitos que o Python também tem (DESVIOS.md, Integração)
// =====================================================================
describe("rascunho sem número", () => {
  it("dois processos podem ter rascunho no mesmo ano (uq_parecer só para parecer numerado)", async () => {
    const [cliente, primeiro] = await abrir_rascunho();
    const { nup_dv } = await import("../src/servicos/nup.js");
    const nup = `23086.000100/2024-${nup_dv("230860001002024")}`;
    const outro = await cliente.post("/processos/novo", { nup, tipo_processo_id: "1" }, { seguir: false });
    expect(outro.status, outro.text.slice(0, 300)).toBe(303);
    const segundo = await cliente.get(`${outro.location}/parecer`, { seguir: false });
    expect(segundo.status).toBe(303);
    expect(segundo.location).toMatch(/^\/pareceres\/\d+$/);
    expect(segundo.location).not.toBe(primeiro);
    const rascunhos = await db.select().from(e.parecer_tecnico).where(eq(e.parecer_tecnico.numero, 0));
    expect(rascunhos).toHaveLength(2);
    // o número EMITIDO continua único no ano
    await expect(
      db.insert(e.parecer_tecnico).values([
        { numero: 7, ano: 2031, situacao: "RESERVADO" },
        { numero: 7, ano: 2031, situacao: "RESERVADO" },
      ] as never),
    ).rejects.toThrow();
  });

  it("o .docx de rascunho incompleto é recusado com o que falta, e não 500", async () => {
    const [cliente, caminho] = await abrir_rascunho();
    const r = await cliente.get(`${caminho}/docx`, { seguir: false });
    expect(r.status).toBe(422);
    expect(r.text).toContain("Faltam dados obrigatorios");
  });
});
