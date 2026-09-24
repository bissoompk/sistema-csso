/**
 * O quadro: filtros em gaveta, quadro vazio que fala, e mover sem arrastar.
 * Porte de `testes/integracao/test_kanban_web.py`.
 *
 * Um banco para o arquivo: os testes do quadro VAZIO rodam primeiro, antes de
 * qualquer processo existir; os outros criam processo com NUP próprio.
 */
import { describe, expect, it } from "vitest";
import { nup_dv } from "../src/servicos/nup.js";
import { bancoLimpo, contas, entrar, type Cliente } from "./ajuda";

const { db, novoCliente } = await bancoLimpo();
await contas(db);

// o navegador submetendo um <form> pede HTML; o fetch do quadro aceita */*
const FORMULARIO = { accept: "text/html,application/xhtml+xml" };
let seq = 0;

/** Um NUP novo e válido (DV certo), para cada teste ter o seu processo. */
function nup_novo(): string {
  const sequencial = String(500000 + ++seq).padStart(6, "0");
  return `23086.${sequencial}/2024-${nup_dv(`23086${sequencial}2024`)}`;
}

async function coordenador(): Promise<Cliente> {
  return entrar(novoCliente(), "coordenador_csso");
}

async function processo_novo(cliente: Cliente, nup = nup_novo()): Promise<number> {
  const criado = await cliente.post("/processos/novo", { nup, tipo_processo_id: "1" }, { seguir: false });
  expect(criado.status, criado.text.slice(0, 2000)).toBe(303);
  return Number(criado.location!.split("/").pop()!.split("?")[0]);
}

/** RECEBIDO só sai para EM_TRIAGEM; da triagem, ARQUIVADO não exige anexo. */
async function em_triagem(cliente: Cliente, id: number) {
  const r = await cliente.post(
    `/kanban/mover/${id}`,
    { coluna: "A_FAZER", estado: "EM_TRIAGEM" },
    { cabecalhos: { "x-requested-with": "fetch" } },
  );
  expect(r.status, r.text).toBe(200);
}

describe("quadro vazio (antes de qualquer processo)", () => {
  it("filtros do quadro nascem fechados", async () => {
    const corpo = (await (await coordenador()).get("/kanban")).text;
    expect(corpo).toContain('<details class="cartao filtros">');
    expect(corpo).toContain("cinco controles");
  });

  it("no primeiro uso diz por onde começar", async () => {
    const corpo = (await (await coordenador()).get("/kanban")).text;
    expect(corpo).toContain("Nenhum processo no fluxo ainda.");
    expect(corpo).toContain("Novo processo");
    expect(corpo).toContain('href="/importar"');
    expect(corpo).toContain('<div class="rolagem-quadro" hidden>');
  });
});

describe("filtros", () => {
  it("abrem e dizem o que está aplicado", async () => {
    const corpo = (await (await coordenador()).get("/kanban?q=021284&atrasados=1")).text;
    expect(corpo).toContain('<details class="cartao filtros" open>');
    expect(corpo).toContain("2 aplicado(s)");
    expect(corpo).toContain("busca “021284”");
    expect(corpo).toContain("só acima do SLA");
  });

  it("quadro vazio por filtro diz onde o filtro olhou", async () => {
    const cliente = await coordenador();
    await processo_novo(cliente);
    const corpo = (await cliente.get("/kanban?q=nada-disso-existe")).text;
    expect(corpo).toContain("Nenhum processo neste recorte.");
    expect(corpo).toContain("O filtro olha NUP");
    expect(corpo).not.toContain("Nenhum processo no fluxo ainda.");
  });

  it("quadro com cartão não mostra o vazio", async () => {
    const cliente = await coordenador();
    await processo_novo(cliente);
    const corpo = (await cliente.get("/kanban")).text;
    expect(corpo).not.toContain("quadro-vazio");
    expect(corpo).toContain('<div class="rolagem-quadro">');
  });
});

describe("mover sem arrastar", () => {
  it("o cartão tem o menu de mover sem a coluna em que está", async () => {
    const cliente = await coordenador();
    const id = await processo_novo(cliente);
    const corpo = (await cliente.get("/kanban")).text;
    const inicio = corpo.indexOf(`id="cartao-${id}"`);
    const cartao = corpo.slice(inicio, corpo.indexOf("</article>", inicio));
    expect(cartao).toContain(`action="/kanban/mover/${id}" data-mover`);
    expect(cartao).not.toContain('value="A_FAZER"');
    for (const destino of ["NAO_INICIADO", "EM_ANDAMENTO", "AGUARDANDO", "CONCLUIDO"]) {
      expect(cartao, destino).toContain(`name="coluna" value="${destino}"`);
    }
    expect(cartao).toContain("mover para…");
  });

  it("quem não move processo não ganha o menu", async () => {
    await processo_novo(await coordenador());
    const corpo = (await (await entrar(novoCliente(), "consulta_progep")).get("/kanban")).text;
    if (corpo.includes("cartao-kanban")) expect(corpo).not.toContain(" data-mover>");
  });

  it("formulário comum move e volta ao quadro com a mensagem", async () => {
    const cliente = await coordenador();
    const id = await processo_novo(cliente);
    await em_triagem(cliente, id);
    const r = await cliente.post(
      `/kanban/mover/${id}`,
      { coluna: "CONCLUIDO", estado: "ARQUIVADO" },
      { cabecalhos: FORMULARIO, seguir: false },
    );
    expect(r.status, r.text).toBe(303);
    expect(r.location!.startsWith("/kanban?mensagem=")).toBe(true);
    const quadro = (await cliente.get(r.location!)).text;
    expect(quadro).toContain("movido para “Concluído”");
  });

  it("formulário comum recusado volta ao quadro com o motivo", async () => {
    const cliente = await coordenador();
    const id = await processo_novo(cliente);
    const r = await cliente.post(`/kanban/mover/${id}`, { coluna: "CONCLUIDO" }, { cabecalhos: FORMULARIO, seguir: false });
    expect(r.status, r.text).toBe(303);
    expect(r.location!.startsWith("/kanban?erro=")).toBe(true);
    const quadro = (await cliente.get(r.location!)).text;
    expect(quadro).toContain('class="aviso aviso-erro"');
  });

  it("o fetch do quadro continua recebendo o fragmento", async () => {
    const cliente = await coordenador();
    const id = await processo_novo(cliente);
    const fetch = { "x-requested-with": "fetch", accept: "*/*" };
    await em_triagem(cliente, id);
    const recusa = await cliente.post(`/kanban/mover/${id}`, { coluna: "CONCLUIDO" }, { cabecalhos: fetch });
    expect(recusa.status).toBe(422);
    expect(recusa.text).toContain("recusa-de-movimento");
    const ok = await cliente.post(`/kanban/mover/${id}`, { coluna: "CONCLUIDO", estado: "ARQUIVADO" }, { cabecalhos: fetch });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.text).toContain('class="cartao-kanban"');
    expect(ok.text).not.toContain('value="CONCLUIDO"');
    expect(ok.text).toContain('value="A_FAZER"');
  });

  it("recusa do fetch não grava nada", async () => {
    const cliente = await coordenador();
    const id = await processo_novo(cliente);
    const r = await cliente.post(`/kanban/mover/${id}`, { coluna: "CONCLUIDO" }, { cabecalhos: { "x-requested-with": "fetch" } });
    expect(r.status).toBe(422);
    const ficha = (await cliente.get(`/processos/${id}`, { cabecalhos: { accept: "text/html" } })).text;
    expect(ficha).toContain("Recebido");
  });

  it("o script do quadro tem um caminho só para os dois gestos", async () => {
    const corpo = (await (await coordenador()).get("/kanban")).text;
    expect(corpo).toContain("function mover(cartao, coluna)");
    expect(corpo).toContain("mover(arrastando, coluna)");
    expect(corpo).toContain("form[data-mover]");
    expect(corpo).toContain("'X-Requested-With': 'fetch'");
  });

  it("processo fora do alcance: 404 no fragmento, volta ao quadro no formulário", async () => {
    const cliente = await coordenador();
    const r = await cliente.post("/kanban/mover/999999", { coluna: "CONCLUIDO" });
    expect(r.status).toBe(404);
    const f = await cliente.post("/kanban/mover/999999", { coluna: "CONCLUIDO" }, { cabecalhos: FORMULARIO, seguir: false });
    expect(f.location).toContain("/kanban?erro=");
  });
});

// Porte das partes do quadro de `test_web_fluxo.py`: troca parcial não falha em silêncio.
describe("troca parcial não falha em silêncio", () => {
  it("a recusa do arrasto sai anunciada e com o motivo inteiro", async () => {
    const cliente = await coordenador();
    const id = await processo_novo(cliente);
    const r = await cliente.post(`/kanban/mover/${id}`, { coluna: "CONCLUIDO" });
    expect(r.status, r.text).toBe(422);
    expect(r.text).toContain('role="alert"');
    expect(r.text).toContain("recusa-de-movimento");
    expect(r.text).not.toContain('id="erro-movimento"');
    expect(r.text).toContain("Transição proibida");
  });

  it("o quadro não guarda mais a caixa de erro no topo", async () => {
    const corpo = (await (await coordenador()).get("/kanban")).text;
    expect(corpo).not.toContain('<div id="erro-movimento"></div>');
    expect(corpo).toContain(".catch(");
    expect(corpo).toContain("scrollIntoView");
    expect(corpo).toContain("function recontar");
  });
});
