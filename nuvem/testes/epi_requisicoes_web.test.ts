/**
 * Fatia 4 de Gestão de EPI, pela tela: fila, formulário, análise e entrega.
 * Porte de `testes/integracao/test_epi_requisicoes_web.py`.
 *
 * O que só a tela pode quebrar: a permissão do menu igual à da rota; o 403 da
 * RN-28 com a mensagem INTEIRA; o reenvio da RN-26 na própria tela; a busca que
 * recusa CPF; só RASCUNHO editável; a troca parcial; o sino do requerente.
 *
 * Cada teste ganha um banco novo (`bancoLimpo()`), como o `banco` do pytest.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { redefinirConfig } from "../src/config.js";
import { somar_dias } from "../src/dominio/datas.js";
import { ROTULO_EVENTO } from "../src/servicos/auditoria.js";
import { bancoLimpo, contas, entrar, type AmbienteDeTeste, type Campos, type Cliente, type Resposta } from "./ajuda";
import { DAQUI_A_UM_ANO, HOJE } from "./ajuda_epi_requisicao";

const FILA = "/epis/requisicoes";
const NOVA = "/epis/requisicoes/nova";
const ENTREGAS = "/epis/entregas";

// o primeiro `bancoLimpo()` na coleta registra a limpeza do arquivo
await bancoLimpo();

interface Amb extends AmbienteDeTeste {
  contas: Record<string, [string, string]>;
}
/** Banco virgem por teste (restaurado no lugar — `testes/ajuda.ts`). */
async function novo(): Promise<Amb> {
  const amb = await bancoLimpo();
  return { ...amb, contas: await contas(amb.db) };
}
async function como(amb: Amb, perfil: string): Promise<Cliente> {
  return entrar(amb.novoCliente(), amb.contas[perfil]![0]);
}

// =====================================================================
// Cenário
// =====================================================================
interface Cenario {
  servidor: number;
  item: number;
  entrada: number;
  unidade: number;
}

async function cenario(
  amb: Amb,
  o: { quantidade_maxima?: number | null; periodo_maximo_meses?: number | null; exige_justificativa?: boolean } = {},
): Promise<Cenario> {
  return amb.db.transaction(async (tx) => {
    const [categoria] = await tx.select().from(e.epi_categoria).where(eq(e.epi_categoria.codigo, "PROT_MEMBROS_SUPERIORES"));
    const [unidade] = await tx.select().from(e.unidade_uorg).orderBy(asc(e.unidade_uorg.id)).limit(1);
    const [cargo] = await tx.select().from(e.cargo).orderBy(asc(e.cargo.id)).limit(1);
    const [servidor] = await tx
      .insert(e.servidor)
      .values({
        siape: "7654321",
        nome: "Joana Ribeiro de Almeida",
        email: "joana.almeida@ufvjm.edu.br",
        cargo_id: cargo!.id,
        unidade_uorg_id: unidade!.id,
      })
      .returning();
    const [item] = await tx
      .insert(e.epi_item)
      .values({
        nome: "Luva de proteção química nitrílica",
        categoria_id: categoria!.id,
        fabricante: "Fabricante Exemplo Ltda",
        modelo: "NX-200",
        exige_ca: true,
        numero_ca: "41234",
        validade_ca: DAQUI_A_UM_ANO,
        unidade_medida: "PAR",
        tamanhos: "P\nM\nG",
        quantidade_padrao: 1,
        quantidade_maxima: o.quantidade_maxima ?? null,
        periodo_maximo_meses: o.periodo_maximo_meses ?? null,
        exige_justificativa: o.exige_justificativa ?? false,
      })
      .returning();
    const [entrada] = await tx
      .insert(e.epi_entrada_estoque)
      .values({
        epi_item_id: item!.id,
        tamanho: "M",
        empenho: "2026NE000123",
        data_entrada: somar_dias(HOJE, -30),
        quantidade_recebida: 10,
        lote: "L-2026-08",
        numero_ca: "41234",
        validade_ca: DAQUI_A_UM_ANO,
      })
      .returning();
    await tx.insert(e.epi_movimento_estoque).values({ entrada_id: entrada!.id, tipo: "ENTRADA", quantidade: 10 });
    return { servidor: servidor!.id, item: item!.id, entrada: entrada!.id, unidade: unidade!.id };
  });
}

/** Um segundo lote do mesmo item, com o CA vencido. RN-25 na tela. */
async function lote_vencido(amb: Amb, cen: Cenario): Promise<number> {
  const [entrada] = await amb.db
    .insert(e.epi_entrada_estoque)
    .values({
      epi_item_id: cen.item,
      tamanho: "M",
      data_entrada: somar_dias(HOJE, -800),
      quantidade_recebida: 5,
      lote: "L-2023-01",
      numero_ca: "30001",
      validade_ca: somar_dias(HOJE, -10),
    })
    .returning();
  await amb.db.insert(e.epi_movimento_estoque).values({ entrada_id: entrada!.id, tipo: "ENTRADA", quantidade: 5 });
  return entrada!.id;
}

/** Faz da conta o titular do pedido — é o que arma a RN-28. */
async function amarrar_conta_ao_servidor(amb: Amb, login: string, servidor_id: number) {
  await amb.db.update(e.usuario).set({ servidor_id }).where(eq(e.usuario.login, login));
}

function abrir(cliente: Cliente, cen: Cenario, troca: Campos = {}) {
  return cliente.post(
    FILA,
    {
      servidor_id: String(cen.servidor),
      chefia_servidor_id: "",
      finalidade: "ROTINA",
      descricao_atividade: "Manipulação de reagentes no laboratório",
      riscos_declarados: "Contato com ácidos e solventes",
      urgencia: "NORMAL",
      justificativa_urgencia: "",
      ...troca,
    },
    { seguir: false },
  );
}

function acrescentar(cliente: Cliente, requisicao_id: number, cen: Cenario, troca: Campos = {}) {
  return cliente.post(
    `${FILA}/${requisicao_id}/itens`,
    { item_id: String(cen.item), quantidade: "1", tamanho: "M", justificativa: "", ...troca },
    { seguir: false },
  );
}

const requisicoes = (amb: Amb) => amb.db.select().from(e.epi_requisicao).orderBy(asc(e.epi_requisicao.id));
const ultima = async (amb: Amb) => (await requisicoes(amb)).at(-1)!;
const linhas = (amb: Amb, requisicao_id: number) =>
  amb.db
    .select()
    .from(e.epi_requisicao_item)
    .where(eq(e.epi_requisicao_item.requisicao_id, requisicao_id))
    .orderBy(asc(e.epi_requisicao_item.id));
async function motivo(amb: Amb, codigo = "SEM_EXPOSICAO"): Promise<number> {
  const [m] = await amb.db.select().from(e.epi_motivo_recusa).where(eq(e.epi_motivo_recusa.codigo, codigo));
  return m!.id;
}

/** O que o sistema respondeu, venha por redirect ou pela tela redesenhada. */
function recado(r: Resposta): string {
  return r.location ? decodeURIComponent(r.location) : r.text;
}

/** Rascunho com uma linha, já protocolado. */
async function pedido_enviado(amb: Amb, cliente: Cliente, cen: Cenario, troca: Campos = {}): Promise<number> {
  await abrir(cliente, cen);
  const requisicao = await ultima(amb);
  await acrescentar(cliente, requisicao.id, cen, troca);
  const r = await cliente.post(`${FILA}/${requisicao.id}/enviar`, {}, { seguir: false });
  expect(r.status, recado(r)).toBe(303);
  return requisicao.id;
}

const entrega_de_balcao = (cliente: Cliente, cen: Cenario) =>
  cliente.post(
    ENTREGAS,
    {
      servidor_id: String(cen.servidor),
      item_id: String(cen.item),
      quantidade: "1",
      entrada_id: String(cen.entrada),
      tamanho: "M",
      data_evento: HOJE,
      observacao: "",
      justificativa_excecao: "",
    },
    { seguir: false },
  );

// =====================================================================
// 1. Permissão de cada rota — e o menu que não pode mentir
// =====================================================================
describe("permissões", () => {
  it.each([
    ["coordenador_csso", 200, 200],
    ["tecnico_seguranca", 200, 200],
    ["engenheiro_seguranca", 200, 200],
    ["medico_trabalho", 200, 200],
    ["secretaria_csso", 200, 200],
    ["servidor_consulta", 200, 200],
    ["almoxarife_sesmt", 200, 403],
    ["consulta_progep", 200, 403],
    ["auditor_interno", 200, 403],
    ["superintendente", 200, 403],
    ["admin_ti", 403, 403],
  ])("telas de requisição para %s", async (perfil, fila, nova) => {
    const amb = await novo();
    const cliente = await como(amb, perfil);
    expect((await cliente.get(FILA)).status).toBe(fila);
    expect((await cliente.get(NOVA)).status).toBe(nova);
  });

  it.each([
    ["coordenador_csso", 303, 303],
    ["secretaria_csso", 303, 403],
    ["servidor_consulta", 303, 403],
    ["almoxarife_sesmt", 403, 403],
    ["auditor_interno", 403, 403],
  ])("escrever e decidir para %s", async (perfil, pode_abrir, decidir) => {
    const amb = await novo();
    const cen = await cenario(amb);
    const requisicao_id = await pedido_enviado(amb, await como(amb, "coordenador_csso"), cen);
    const cliente = await como(amb, perfil);
    expect((await abrir(cliente, cen)).status).toBe(pode_abrir);
    expect((await cliente.post(`${FILA}/${requisicao_id}/analise`, {}, { seguir: false })).status).toBe(decidir);
  });

  it("o menu oferece a fila e esconde o formulário de quem não pede", async () => {
    const amb = await novo();
    const mapa = (await (await como(amb, "almoxarife_sesmt")).get("/modulos")).text;
    expect(mapa).toContain(`href="${FILA}"`);
    expect(mapa).not.toContain(`href="${NOVA}"`);
  });
});

// =====================================================================
// 2. O caminho inteiro, pela tela
// =====================================================================
describe("o caminho inteiro", () => {
  it("do rascunho à entrega, o pedido atravessa o sistema", async () => {
    const amb = await novo();
    const cen = await cenario(amb);
    const cliente = await como(amb, "coordenador_csso");
    expect((await abrir(cliente, cen)).status).toBe(303);
    let requisicao = await ultima(amb);
    expect(requisicao.protocolo).toBeNull();
    expect(requisicao.estado).toBe("RASCUNHO");

    expect((await acrescentar(cliente, requisicao.id, cen)).status).toBe(303);
    const enviada = await cliente.post(`${FILA}/${requisicao.id}/enviar`, {}, { seguir: false });
    expect(enviada.status).toBe(303);
    expect(recado(enviada)).toContain("EPI-");

    requisicao = await ultima(amb);
    expect(requisicao.estado).toBe("ENVIADA");
    expect(requisicao.protocolo).toBe(`EPI-${HOJE.slice(0, 4)}-0001`);
    expect(requisicao.unidade_uorg_id).toBe(cen.unidade);
    expect(requisicao.cargo_snapshot).toBeTruthy();

    expect((await cliente.post(`${FILA}/${requisicao.id}/analise`, {}, { seguir: false })).status).toBe(303);
    const linha = (await linhas(amb, requisicao.id))[0]!;
    const aprovada = await cliente.post(
      `${FILA}/${requisicao.id}/itens/${linha.id}/aprovar`,
      { quantidade_aprovada: "1", justificativa: "", autorizar_excesso: "" },
      { seguir: false },
    );
    expect(aprovada.status, recado(aprovada)).toBe(303);
    expect(
      (
        await cliente.post(
          `${FILA}/${requisicao.id}/concluir`,
          { parecer: "Exposição compatível com o posto." },
          { seguir: false },
        )
      ).status,
    ).toBe(303);
    expect((await ultima(amb)).estado).toBe("ANALISADA");

    const entregue = await cliente.post(
      `${FILA}/${requisicao.id}/itens/${linha.id}/entregar`,
      { entrada_id: String(cen.entrada), quantidade: "1", observacao: "" },
      { seguir: false },
    );
    expect(entregue.status, recado(entregue)).toBe(303);
    expect(recado(entregue)).toContain("comprovante");
    expect((await ultima(amb)).estado).toBe("ATENDIDA");
    expect((await linhas(amb, requisicao.id))[0]!.estado).toBe("ENTREGUE");
  });

  it("a tela não oferece botão para os estados do sistema", async () => {
    const amb = await novo();
    const cen = await cenario(amb);
    const cliente = await como(amb, "coordenador_csso");
    await abrir(cliente, cen);
    const requisicao_id = (await ultima(amb)).id;
    await acrescentar(cliente, requisicao_id, cen, { quantidade: "2" });
    await cliente.post(`${FILA}/${requisicao_id}/enviar`, {}, { seguir: false });
    await cliente.post(`${FILA}/${requisicao_id}/analise`, {}, { seguir: false });
    const linha = (await linhas(amb, requisicao_id))[0]!;
    await cliente.post(`${FILA}/${requisicao_id}/itens/${linha.id}/aprovar`, { quantidade_aprovada: "2" }, { seguir: false });
    await cliente.post(`${FILA}/${requisicao_id}/concluir`, { parecer: "" }, { seguir: false });
    await cliente.post(
      `${FILA}/${requisicao_id}/itens/${linha.id}/entregar`,
      { entrada_id: String(cen.entrada), quantidade: "1" },
      { seguir: false },
    );
    expect((await ultima(amb)).estado).toBe("EM_ATENDIMENTO");

    const corpo = (await cliente.get(`${FILA}/${requisicao_id}`)).text;
    const acoes = new Set([...corpo.matchAll(/action="(\/epis\/requisicoes\/[^"]*)"/g)].map((m) => m[1]!));
    expect(acoes.size).toBeGreaterThan(0);
    expect([...acoes].filter((a) => a.includes("atend"))).toEqual([]);
    expect(corpo).toContain("Este estado é do sistema, não de um botão.");
  });
});

// =====================================================================
// 3. RN-28 — o 403 com a mensagem inteira
// =====================================================================
describe("RN-28 na tela", () => {
  it("nega a autoanálise e mostra as duas saídas", async () => {
    const amb = await novo();
    const cen = await cenario(amb);
    await amarrar_conta_ao_servidor(amb, "coordenador_csso", cen.servidor);
    const cliente = await como(amb, "coordenador_csso");
    const requisicao_id = await pedido_enviado(amb, cliente, cen);
    const negado = await cliente.post(`${FILA}/${requisicao_id}/analise`, {}, { seguir: false, cabecalhos: { accept: "text/html" } });
    expect(negado.status).toBe(403);
    expect(negado.text).toContain("RN-28");
    expect(negado.text).toContain("epi.analisar");
    expect(negado.text).toContain("/epis/entregas/nova");
    expect(negado.text).toContain("outra pessoa com a permissão de analisar EPI");
    expect((await ultima(amb)).estado).toBe("ENVIADA");
  });

  it("vale em toda operação de decisão, e não só ao pegar o pedido", async () => {
    const amb = await novo();
    const cen = await cenario(amb);
    const cliente = await como(amb, "coordenador_csso");
    const requisicao_id = await pedido_enviado(amb, cliente, cen);
    expect((await cliente.post(`${FILA}/${requisicao_id}/analise`, {}, { seguir: false })).status).toBe(303);
    const linha = (await linhas(amb, requisicao_id))[0]!;
    // só AGORA a conta vira a titular do pedido
    await amarrar_conta_ao_servidor(amb, "coordenador_csso", cen.servidor);
    const m = String(await motivo(amb));
    for (const [caminho, dados] of [
      [`/itens/${linha.id}/aprovar`, { quantidade_aprovada: "1" }],
      [`/itens/${linha.id}/recusar`, { motivo_id: m }],
      ["/concluir", { parecer: "" }],
      ["/indeferir", { motivo_id: m }],
      ["/devolver", { motivo: "não é meu caso" }],
    ] as const) {
      const r = await cliente.post(`${FILA}/${requisicao_id}${caminho}`, dados, {
        seguir: false,
        cabecalhos: { accept: "text/html" },
      });
      expect(r.status, caminho).toBe(403);
      expect(r.text, caminho).toContain("RN-28");
    }
  });

  it("a RN-28 não trava o trabalho: o balcão continua aberto", async () => {
    const amb = await novo();
    const cen = await cenario(amb);
    await amarrar_conta_ao_servidor(amb, "coordenador_csso", cen.servidor);
    const cliente = await como(amb, "coordenador_csso");
    expect((await cliente.get("/epis/entregas/nova")).status).toBe(200);
    const entrega = await entrega_de_balcao(cliente, cen);
    expect(entrega.status, recado(entrega)).toBe(303);
  });
});

// =====================================================================
// 4. RN-26 — o bloqueio com caminho de reenvio na própria tela
// =====================================================================
describe("RN-26 na tela", () => {
  it("bloqueia o excesso e oferece a autorização", async () => {
    const amb = await novo();
    const cen = await cenario(amb, { quantidade_maxima: 1, periodo_maximo_meses: 12 });
    const cliente = await como(amb, "coordenador_csso");
    // a ficha já registra uma entrega na janela
    await entrega_de_balcao(cliente, cen);
    const requisicao_id = await pedido_enviado(amb, cliente, cen);
    await cliente.post(`${FILA}/${requisicao_id}/analise`, {}, { seguir: false });
    const linha = (await linhas(amb, requisicao_id))[0]!;

    const bloqueada = await cliente.post(
      `${FILA}/${requisicao_id}/itens/${linha.id}/aprovar`,
      { quantidade_aprovada: "1", justificativa: "", autorizar_excesso: "" },
      { seguir: false },
    );
    expect(bloqueada.status).toBe(303);
    expect(recado(bloqueada)).toContain("erro=");
    expect(recado(bloqueada)).toContain("autorize a exceção");
    expect((await linhas(amb, requisicao_id))[0]!.estado).toBe("SOLICITADO");

    const sem_texto = await cliente.post(
      `${FILA}/${requisicao_id}/itens/${linha.id}/aprovar`,
      { quantidade_aprovada: "1", justificativa: "", autorizar_excesso: "1" },
      { seguir: false },
    );
    expect(recado(sem_texto)).toContain("justificativa por escrito");

    const autorizada = await cliente.post(
      `${FILA}/${requisicao_id}/itens/${linha.id}/aprovar`,
      {
        quantidade_aprovada: "1",
        justificativa: "A primeira luva foi perfurada por respingo de ácido.",
        autorizar_excesso: "1",
      },
      { seguir: false },
    );
    expect(autorizada.status).toBe(303);
    expect(recado(autorizada)).toContain("seu nome");
    const decidida = (await linhas(amb, requisicao_id))[0]!;
    expect(decidida.estado).toBe("APROVADO");
    expect(decidida.excedeu_maximo).toBe(true);
    expect(decidida.autorizado_por).not.toBeNull();
  });

  it("a tela de análise traz a caixa de autorização antes de qualquer erro", async () => {
    const amb = await novo();
    const cen = await cenario(amb, { quantidade_maxima: 1, periodo_maximo_meses: 12 });
    const cliente = await como(amb, "coordenador_csso");
    const requisicao_id = await pedido_enviado(amb, cliente, cen);
    await cliente.post(`${FILA}/${requisicao_id}/analise`, {}, { seguir: false });
    const corpo = (await cliente.get(`${FILA}/${requisicao_id}`)).text;
    expect(corpo).toContain('name="autorizar_excesso"');
    expect(corpo).toContain("1 por 12 meses");
    expect(corpo).toContain("com o seu nome");
  });
});

// =====================================================================
// 5. A fila: filtro, contagem e a busca que recusa CPF
// =====================================================================
describe("a fila", () => {
  it("filtra por estado e conta cada um", async () => {
    const amb = await novo();
    const cen = await cenario(amb);
    const cliente = await como(amb, "coordenador_csso");
    const enviado = await pedido_enviado(amb, cliente, cen);
    await abrir(cliente, cen); // um rascunho, que fica de fora do filtro
    const rascunho = (await ultima(amb)).id;
    const todos = await cliente.get(FILA);
    expect(todos.status).toBe(200);
    expect(todos.text).toContain(`href="/epis/requisicoes/${enviado}"`);
    expect(todos.text).toContain(`href="/epis/requisicoes/${rascunho}"`);
    const so = (await cliente.get(`${FILA}?estado=ENVIADA`)).text;
    expect(so).toContain(`href="/epis/requisicoes/${enviado}"`);
    expect(so).not.toContain(`href="/epis/requisicoes/${rascunho}"`);
  });

  it("a busca acha pelo protocolo, pelo SIAPE, pelo nome e pelo e-mail", async () => {
    const amb = await novo();
    const cen = await cenario(amb);
    const cliente = await como(amb, "coordenador_csso");
    const requisicao_id = await pedido_enviado(amb, cliente, cen);
    const protocolo = (await ultima(amb)).protocolo!;
    for (const termo of [protocolo, "7654321", "Joana", "joana.almeida@ufvjm.edu.br"]) {
      const corpo = (await cliente.get(`${FILA}?q=${encodeURIComponent(termo)}`)).text;
      expect(corpo, termo).toContain(`href="/epis/requisicoes/${requisicao_id}"`);
    }
    const vazio = (await cliente.get(`${FILA}?q=${encodeURIComponent("Fulano de Tal")}`)).text;
    expect(vazio).not.toContain(`href="/epis/requisicoes/${requisicao_id}"`);
  });

  it("a busca não aceita CPF e diz por quê", async () => {
    const amb = await novo();
    const cen = await cenario(amb);
    const cliente = await como(amb, "coordenador_csso");
    const requisicao_id = await pedido_enviado(amb, cliente, cen);
    for (const cpf of ["12345678909", "123.456.789-09"]) {
      const corpo = (await cliente.get(`${FILA}?q=${encodeURIComponent(cpf)}`)).text;
      expect(corpo, cpf).toContain("não armazena CPF");
      expect(corpo, cpf).not.toContain(`href="/epis/requisicoes/${requisicao_id}"`);
    }
  });

  it("a busca por nome não vira oráculo para quem não vê nome", async () => {
    const amb = await novo();
    const cen = await cenario(amb);
    const requisicao_id = await pedido_enviado(amb, await como(amb, "coordenador_csso"), cen);
    const cliente = await como(amb, "secretaria_csso");
    expect((await cliente.get(FILA)).text).not.toContain("Joana Ribeiro de Almeida");
    expect((await cliente.get(`${FILA}?q=Joana`)).text).not.toContain(`href="/epis/requisicoes/${requisicao_id}"`);
    const por_siape = (await cliente.get(`${FILA}?q=7654321`)).text;
    expect(por_siape).toContain(`href="/epis/requisicoes/${requisicao_id}"`);
    expect(por_siape).not.toContain("Joana Ribeiro de Almeida");
  });
});

// =====================================================================
// 6. A recusa é um seletor, e o texto sai congelado
// =====================================================================
describe("a recusa", () => {
  it("vem do catálogo, com o texto visível antes da escolha", async () => {
    const amb = await novo();
    const cen = await cenario(amb);
    const cliente = await como(amb, "coordenador_csso");
    const requisicao_id = await pedido_enviado(amb, cliente, cen);
    await cliente.post(`${FILA}/${requisicao_id}/analise`, {}, { seguir: false });
    const corpo = (await cliente.get(`${FILA}/${requisicao_id}`)).text;
    expect(corpo).toContain('class="seletor-motivo"');
    expect(corpo).toContain("data-texto=");
    expect(corpo).toContain("data-exige=");
  });

  it("congela o texto, e ele aparece na ficha do pedido", async () => {
    const amb = await novo();
    const cen = await cenario(amb);
    const cliente = await como(amb, "coordenador_csso");
    const requisicao_id = await pedido_enviado(amb, cliente, cen);
    await cliente.post(`${FILA}/${requisicao_id}/analise`, {}, { seguir: false });
    const linha = (await linhas(amb, requisicao_id))[0]!;
    const recusada = await cliente.post(
      `${FILA}/${requisicao_id}/itens/${linha.id}/recusar`,
      { motivo_id: String(await motivo(amb)), complemento: "" },
      { seguir: false },
    );
    expect(recusada.status, recado(recusada)).toBe(303);
    const decidida = (await linhas(amb, requisicao_id))[0]!;
    expect(decidida.estado).toBe("RECUSADO");
    expect(decidida.texto_recusa_snapshot).toBeTruthy();
    const corpo = (await cliente.get(`${FILA}/${requisicao_id}`)).text;
    expect(corpo).toContain(escapar(decidida.texto_recusa_snapshot!.slice(0, 40)));
    expect(corpo).toContain("SEM_EXPOSICAO");
  });

  it("recusar sem motivo do catálogo é barrado com a razão escrita", async () => {
    const amb = await novo();
    const cen = await cenario(amb);
    const cliente = await como(amb, "coordenador_csso");
    const requisicao_id = await pedido_enviado(amb, cliente, cen);
    await cliente.post(`${FILA}/${requisicao_id}/analise`, {}, { seguir: false });
    const linha = (await linhas(amb, requisicao_id))[0]!;
    const r = await cliente.post(
      `${FILA}/${requisicao_id}/itens/${linha.id}/recusar`,
      { motivo_id: "", complemento: "" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    expect(recado(r)).toContain("RN-27");
    expect((await linhas(amb, requisicao_id))[0]!.estado).toBe("SOLICITADO");
  });
});

/** O autoescape do template: o texto congelado sai com `&#39;` etc. */
function escapar(texto: string): string {
  return texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// =====================================================================
// 7. Só RASCUNHO é editável
// =====================================================================
describe("só o rascunho se edita", () => {
  it("editar e acrescentar item só existem no rascunho", async () => {
    const amb = await novo();
    const cen = await cenario(amb);
    const cliente = await como(amb, "coordenador_csso");
    await abrir(cliente, cen);
    const requisicao_id = (await ultima(amb)).id;
    const rascunho = (await cliente.get(`${FILA}/${requisicao_id}`)).text;
    expect(rascunho).toContain('id="novo-item"');
    expect(rascunho).toContain(`action="${FILA}/${requisicao_id}/excluir"`);

    await acrescentar(cliente, requisicao_id, cen);
    await cliente.post(`${FILA}/${requisicao_id}/enviar`, {}, { seguir: false });
    const enviado = (await cliente.get(`${FILA}/${requisicao_id}`)).text;
    expect(enviado).not.toContain('id="novo-item"');
    expect(enviado).not.toContain(`action="${FILA}/${requisicao_id}/excluir"`);

    const bloqueado = await acrescentar(cliente, requisicao_id, cen, { tamanho: "G" });
    expect(bloqueado.status).toBe(200);
    expect(recado(bloqueado)).toContain("rascunho");
    expect((await linhas(amb, requisicao_id)).length).toBe(1);
  });

  it("excluir rascunho não fica colado em enviar pedido", async () => {
    const amb = await novo();
    const cen = await cenario(amb);
    const cliente = await como(amb, "coordenador_csso");
    await abrir(cliente, cen);
    const requisicao_id = (await ultima(amb)).id;
    await acrescentar(cliente, requisicao_id, cen);
    const corpo = (await cliente.get(`${FILA}/${requisicao_id}`)).text;
    expect(corpo).toContain('href="#excluir-rascunho"');
    expect(corpo).toContain('id="excluir-rascunho"');
    expect(corpo).toContain("1 linha(s) de item");
    expect(corpo).toContain("a rotina de trabalho e os riscos declarados");
    const acao = `action="${FILA}/${requisicao_id}/excluir"`;
    expect(corpo.split(acao).length - 1).toBe(1);
    expect(corpo.indexOf("Enviar pedido")).toBeLessThan(corpo.indexOf('id="excluir-rascunho"'));
    expect(corpo.indexOf('id="excluir-rascunho"')).toBeLessThan(corpo.indexOf(acao));
  });

  it("excluir rascunho some com o pedido e deixa o evento", async () => {
    const amb = await novo();
    const cen = await cenario(amb);
    const cliente = await como(amb, "coordenador_csso");
    await abrir(cliente, cen);
    const requisicao_id = (await ultima(amb)).id;
    const r = await cliente.post(`${FILA}/${requisicao_id}/excluir`, {}, { seguir: false });
    expect(r.status).toBe(303);
    expect(await requisicoes(amb)).toEqual([]);
    expect(recado(r)).toContain("trilha");
  });
});

// =====================================================================
// 8. RN-25 na tela da entrega
// =====================================================================
describe("RN-25 na tela", () => {
  async function aprovado(amb: Amb, cen: Cenario, concluir = true) {
    const cliente = await como(amb, "coordenador_csso");
    const requisicao_id = await pedido_enviado(amb, cliente, cen);
    await cliente.post(`${FILA}/${requisicao_id}/analise`, {}, { seguir: false });
    const linha = (await linhas(amb, requisicao_id))[0]!;
    await cliente.post(`${FILA}/${requisicao_id}/itens/${linha.id}/aprovar`, { quantidade_aprovada: "1" }, { seguir: false });
    if (concluir) await cliente.post(`${FILA}/${requisicao_id}/concluir`, { parecer: "" }, { seguir: false });
    return { cliente, requisicao_id, linha };
  }

  it("lote com CA vencido aparece marcado e com o motivo ao lado", async () => {
    const amb = await novo();
    const cen = await cenario(amb);
    await lote_vencido(amb, cen);
    const { cliente, requisicao_id } = await aprovado(amb, cen);
    const corpo = (await cliente.get(`${FILA}/${requisicao_id}`)).text;
    expect(corpo).toContain("L-2023-01");
    expect(corpo).toContain("INDISPONÍVEL");
    expect(corpo).toContain("venceu em");
    expect(corpo).toContain("CA vencido");
  });

  it("o lote candidato aparece ao lado do item para quem só lê", async () => {
    const amb = await novo();
    const cen = await cenario(amb);
    const { requisicao_id, linha } = await aprovado(amb, cen, false);
    const corpo = (await (await como(amb, "auditor_interno")).get(`${FILA}/${requisicao_id}`)).text;
    expect(corpo).toContain("L-2026-08");
    expect(corpo).toContain("CA 41234");
    expect(corpo).toContain("disponível");
    expect(corpo).not.toContain(`/itens/${linha.id}/entregar`);
  });

  it("entregar de lote vencido é recusado com o motivo escrito", async () => {
    const amb = await novo();
    const cen = await cenario(amb);
    const vencido = await lote_vencido(amb, cen);
    const { cliente, requisicao_id, linha } = await aprovado(amb, cen);
    const r = await cliente.post(
      `${FILA}/${requisicao_id}/itens/${linha.id}/entregar`,
      { entrada_id: String(vencido), quantidade: "1", observacao: "" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    expect(recado(r)).toContain("venceu em");
    expect((await linhas(amb, requisicao_id))[0]!.estado).toBe("APROVADO");
  });
});

// =====================================================================
// 9. Os três lugares de HTMX, e a guia
// =====================================================================
describe("fragmentos e guia", () => {
  it("os fragmentos HTMX respondem e exigem a permissão de pedir", async () => {
    const amb = await novo();
    const cen = await cenario(amb, { exige_justificativa: true });
    const cliente = await como(amb, "coordenador_csso");
    const servidores = await cliente.get(`${FILA}/servidores?q=7654321`);
    expect(servidores.status).toBe(200);
    expect(servidores.text).toContain("SIAPE 7654321");
    const opcoes = await cliente.get(`${FILA}/item-opcoes?item_id=${cen.item}`);
    expect(opcoes.status).toBe(200);
    expect(opcoes.text).toContain("obrigatória para este item");
    const saldo = await cliente.get(`${FILA}/item-saldo?item_id=${cen.item}&tamanho=M`);
    expect(saldo.status).toBe(200);
    expect(saldo.text).toContain("L-2026-08");
    expect(saldo.text).toContain("não reserva nada");

    const almox = await como(amb, "almoxarife_sesmt");
    for (const caminho of ["servidores", "item-opcoes", "item-saldo"]) {
      expect((await almox.get(`${FILA}/${caminho}`)).status, caminho).toBe(403);
    }
  });

  it("a guia de entrega sai do congelado", async () => {
    const amb = await novo();
    const cen = await cenario(amb);
    const cliente = await como(amb, "coordenador_csso");
    const requisicao_id = await pedido_enviado(amb, cliente, cen);
    await cliente.post(`${FILA}/${requisicao_id}/analise`, {}, { seguir: false });
    const linha = (await linhas(amb, requisicao_id))[0]!;
    await cliente.post(
      `${FILA}/${requisicao_id}/itens/${linha.id}/recusar`,
      { motivo_id: String(await motivo(amb)), complemento: "" },
      { seguir: false },
    );
    const guia = await cliente.get(`${FILA}/${requisicao_id}/guia`);
    expect(guia.status).toBe(200);
    expect(guia.text).toContain((await ultima(amb)).protocolo!);
    expect(guia.text).toContain(escapar((await linhas(amb, requisicao_id))[0]!.texto_recusa_snapshot!.slice(0, 40)));
    expect(guia.text).toContain("não é a prova de entrega");
  });

  it("a guia abre para quem só lê", async () => {
    const amb = await novo();
    const cen = await cenario(amb);
    const requisicao_id = await pedido_enviado(amb, await como(amb, "coordenador_csso"), cen);
    const auditor = await como(amb, "auditor_interno");
    expect((await auditor.get(`${FILA}/${requisicao_id}`)).status).toBe(200);
    expect((await auditor.get(`${FILA}/${requisicao_id}/guia`)).status).toBe(200);
    const admin = await como(amb, "admin_ti");
    expect((await admin.get(`${FILA}/${requisicao_id}`)).status).toBe(403);
    expect((await admin.get(`${FILA}/${requisicao_id}/guia`)).status).toBe(403);
  });
});

// =====================================================================
// 10. A trilha embaixo da ficha
// =====================================================================
it("a ficha mostra as duas máquinas na mesma linha do tempo", async () => {
  const amb = await novo();
  const cen = await cenario(amb);
  const cliente = await como(amb, "coordenador_csso");
  const requisicao_id = await pedido_enviado(amb, cliente, cen);
  await cliente.post(`${FILA}/${requisicao_id}/analise`, {}, { seguir: false });
  const linha = (await linhas(amb, requisicao_id))[0]!;
  await cliente.post(
    `${FILA}/${requisicao_id}/itens/${linha.id}/recusar`,
    { motivo_id: String(await motivo(amb)), complemento: "" },
    { seguir: false },
  );
  const corpo = (await cliente.get(`${FILA}/${requisicao_id}`)).text;
  for (const codigo of ["EPI_REQUISICAO_CRIADA", "EPI_REQUISICAO_ENVIADA", "EPI_REQUISICAO_EM_ANALISE", "EPI_ITEM_RECUSADO"]) {
    expect(corpo, codigo).toContain(ROTULO_EVENTO[codigo]!);
    expect(corpo, codigo).not.toContain(codigo);
  }
});

// =====================================================================
// 11. A recusa dentro do rascunho não apaga o que foi digitado
// =====================================================================
const ROTINA_LONGA =
  "Transferência diária de ácido sulfúrico concentrado entre frascos de 20 L " +
  "na capela 3 do bloco B, das 8h às 12h, com apoio de bomba peristáltica.";
const RISCOS_LONGOS =
  "Respingo de ácido em face e antebraço, vapor ácido na zona respiratória e " + "contato dérmico durante a troca de mangueira.";

function valor(corpo: string, campo: string): string | null {
  const achado = new RegExp(`<(?:input|textarea)[^>]*\\bname="${campo}"[^>]*>`).exec(corpo);
  if (!achado) return null;
  const v = /\bvalue="([^"]*)"/.exec(achado[0]);
  return v ? v[1]! : null;
}
const html = (t: string) => escapar(t);

describe("a recusa no rascunho devolve o digitado", () => {
  it("rascunho recusado devolve os dois textos longos", async () => {
    const amb = await novo();
    const cen = await cenario(amb);
    const cliente = await como(amb, "coordenador_csso");
    await abrir(cliente, cen);
    const requisicao_id = (await ultima(amb)).id;
    const r = await cliente.post(
      `${FILA}/${requisicao_id}`,
      {
        chefia_servidor_id: "",
        finalidade: "ROTINA",
        urgencia: "URGENTE",
        justificativa_urgencia: "reposição pedida no atestado médico",
        descricao_atividade: ROTINA_LONGA,
        riscos_declarados: RISCOS_LONGOS,
      },
      { seguir: false },
    );
    expect(r.status, "voltou a redirecionar e a perder o texto").toBe(200);
    expect(r.text).toContain('class="aviso aviso-erro"');
    expect(r.text).toContain(html(ROTINA_LONGA));
    expect(r.text).toContain(html(RISCOS_LONGOS));
    expect(r.text).toMatch(/<option value="URGENTE"[^>]*\bselected\b/);
    expect((await ultima(amb)).descricao_atividade).not.toBe(ROTINA_LONGA);
  });

  it("acrescentar item recusado devolve o bloco do item inteiro", async () => {
    const amb = await novo();
    const cen = await cenario(amb);
    const cliente = await como(amb, "coordenador_csso");
    await abrir(cliente, cen);
    const requisicao_id = (await ultima(amb)).id;
    const r = await acrescentar(cliente, requisicao_id, cen, {
      quantidade: "3",
      justificativa: "uso exigido pelo atestado médico da chefia",
    });
    expect(r.status).toBe(200);
    expect(r.text).toContain("termo proibido");
    expect(r.text).toMatch(new RegExp(`<option value="${cen.item}"[^>]*\\bselected\\b`));
    expect(valor(r.text, "quantidade")).toBe("3");
    expect(r.text).toContain(html("uso exigido pelo atestado médico da chefia"));
    expect(r.text).toMatch(/<option value="M"[^>]*\bselected\b/);
    expect(await linhas(amb, requisicao_id)).toEqual([]);
  });

  it("editar linha recusada volta na própria linha e de gaveta aberta", async () => {
    const amb = await novo();
    const cen = await cenario(amb);
    const cliente = await como(amb, "coordenador_csso");
    await abrir(cliente, cen);
    const requisicao_id = (await ultima(amb)).id;
    await acrescentar(cliente, requisicao_id, cen);
    await acrescentar(cliente, requisicao_id, cen, { tamanho: "G" });
    const [primeira, segunda] = await linhas(amb, requisicao_id);
    const texto = "troca por desgaste conforme atestado médico";
    const r = await cliente.post(
      `${FILA}/${requisicao_id}/itens/${segunda!.id}`,
      { quantidade: "4", tamanho: "G", justificativa: texto },
      { seguir: false },
    );
    expect(r.status).toBe(200);
    const corpo = r.text;
    const t = html(texto);
    expect(corpo).toContain(t);
    expect(corpo.split(t).length - 1).toBe(1);
    expect(corpo).toMatch(new RegExp(`id="j-${segunda!.id}"[^>]*>[^<]*${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    expect(corpo).toContain(`id="j-${primeira!.id}"`);
    const gavetas = [...corpo.matchAll(/<dialog class="popup popup-gaveta"[^>]*>/g)].map((m) => m[0]);
    expect(gavetas.length).toBe(2);
    const abertas = gavetas.filter((g) => g.includes(" open>"));
    expect(abertas.length).toBe(1);
    expect(abertas[0]).toContain(`id="acoes-item-${segunda!.id}"`);
    expect((await linhas(amb, requisicao_id))[1]!.quantidade_solicitada).toBe(segunda!.quantidade_solicitada);
  });
});

// =====================================================================
// A troca parcial da lista de itens
// =====================================================================
describe("troca parcial", () => {
  async function em_analise(amb: Amb) {
    const cen = await cenario(amb);
    const cliente = await como(amb, "coordenador_csso");
    const requisicao_id = await pedido_enviado(amb, cliente, cen);
    expect((await cliente.post(`${FILA}/${requisicao_id}/analise`, {}, { seguir: false })).status).toBe(303);
    return { cliente, requisicao_id, linha: (await linhas(amb, requisicao_id))[0]! };
  }

  it("decidir item por HTMX devolve a seção e não a página", async () => {
    const amb = await novo();
    const { cliente, requisicao_id, linha } = await em_analise(amb);
    const r = await cliente.post(
      `${FILA}/${requisicao_id}/itens/${linha.id}/aprovar`,
      { quantidade_aprovada: "1" },
      { seguir: false, cabecalhos: { "HX-Request": "true" } },
    );
    expect(r.status, r.text).toBe(200);
    expect(r.text).not.toContain("<html");
    expect(r.text).toContain("Itens do pedido");
    expect(r.text).toContain("<table>");
    expect(r.text).not.toContain("sem decisão");
    expect((await linhas(amb, requisicao_id))[0]!.estado).toBe("APROVADO");
  });

  it("sem HTMX, decidir item continua respondendo 303", async () => {
    const amb = await novo();
    const { cliente, requisicao_id, linha } = await em_analise(amb);
    const r = await cliente.post(
      `${FILA}/${requisicao_id}/itens/${linha.id}/aprovar`,
      { quantidade_aprovada: "1" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    expect((await linhas(amb, requisicao_id))[0]!.estado).toBe("APROVADO");
  });

  it("a recusa de regra por HTMX volta em 200 com o motivo", async () => {
    const amb = await novo();
    const { cliente, requisicao_id, linha } = await em_analise(amb);
    const r = await cliente.post(
      `${FILA}/${requisicao_id}/itens/${linha.id}/recusar`,
      { motivo_id: "" },
      { seguir: false, cabecalhos: { "HX-Request": "true" } },
    );
    expect(r.status).toBe(200);
    expect(r.text).toContain("RN-27");
    expect(r.text).toContain("Itens do pedido");
    expect((await linhas(amb, requisicao_id))[0]!.estado).toBe("SOLICITADO");
  });

  it("a entrega continua recarregando a página, de propósito", () => {
    const bruto = readFileSync(new URL("../templates/partes/itens_do_pedido.html", import.meta.url), "utf8");
    const fonte = bruto.replace(/\{#[\s\S]*?#\}/g, "");
    const i = fonte.indexOf("<h3>Entregar</h3>");
    expect(fonte.slice(i - 400, i)).not.toContain("hx-post");
  });
});

// =====================================================================
// 13. O sino do requerente
// =====================================================================
const SINO = /(\d+) pendência\(s\) aberta\(s\)/;

async function sino(cliente: Cliente): Promise<number> {
  const r = await cliente.get(FILA);
  expect(r.status, r.text.slice(0, 400)).toBe(200);
  const achado = SINO.exec(r.text);
  return achado ? Number(achado[1]) : 0;
}

/** Protocolado com duas linhas — uma para aprovar, outra para recusar. */
async function pedido_de_duas_linhas(amb: Amb, cliente: Cliente, cen: Cenario): Promise<number> {
  await abrir(cliente, cen);
  const requisicao_id = (await ultima(amb)).id;
  await acrescentar(cliente, requisicao_id, cen, { tamanho: "M" });
  await acrescentar(cliente, requisicao_id, cen, { tamanho: "G" });
  const r = await cliente.post(`${FILA}/${requisicao_id}/enviar`, {}, { seguir: false });
  expect(r.status, recado(r)).toBe(303);
  return requisicao_id;
}

async function decidir(amb: Amb, cliente: Cliente, requisicao_id: number, aprovar: number, recusar: number) {
  await cliente.post(`${FILA}/${requisicao_id}/analise`, {}, { seguir: false });
  await cliente.post(
    `${FILA}/${requisicao_id}/itens/${aprovar}/aprovar`,
    { quantidade_aprovada: "1", justificativa: "" },
    { seguir: false },
  );
  await cliente.post(
    `${FILA}/${requisicao_id}/itens/${recusar}/recusar`,
    { motivo_id: String(await motivo(amb)), complemento: "" },
    { seguir: false },
  );
  const r = await cliente.post(`${FILA}/${requisicao_id}/concluir`, { parecer: "" }, { seguir: false });
  expect(r.status, recado(r)).toBe(303);
}

describe("o sino do requerente", () => {
  it("toca na decisão e na reserva", async () => {
    const amb = await novo();
    const cen = await cenario(amb);
    await amarrar_conta_ao_servidor(amb, "servidor_consulta", cen.servidor);
    let requerente = await como(amb, "servidor_consulta");
    expect(await sino(requerente), "sino sujo antes de a jornada começar").toBe(0);
    const requisicao_id = await pedido_de_duas_linhas(amb, requerente, cen);
    expect(await sino(requerente)).toBe(0);

    const tecnico = await como(amb, "tecnico_seguranca");
    const [l0, l1] = await linhas(amb, requisicao_id);
    await decidir(amb, tecnico, requisicao_id, l0!.id, l1!.id);
    requerente = await como(amb, "servidor_consulta");
    expect(await sino(requerente), "a decisão continua sem chegar a quem pediu").toBe(1);

    const reservada = await tecnico.post(
      `${FILA}/${requisicao_id}/itens/${l0!.id}/reservar`,
      { entrada_id: String(cen.entrada), quantidade: "1" },
      { seguir: false },
    );
    expect(reservada.status, recado(reservada)).toBe(303);
    expect(await sino(requerente)).toBe(2);
    const tarefas = (await requerente.get("/pendencias")).text;
    expect(tarefas).toContain("espera você retirar");
    expect(tarefas).toContain(`href="/epis/requisicoes/${requisicao_id}?de=pendencias"`);

    const entregue = await tecnico.post(
      `${FILA}/${requisicao_id}/itens/${l0!.id}/entregar`,
      { entrada_id: String(cen.entrada), quantidade: "1", observacao: "" },
      { seguir: false },
    );
    expect(entregue.status, recado(entregue)).toBe(303);
    expect(await sino(requerente)).toBe(0);
    expect((await requerente.get("/pendencias")).text).not.toContain("comprovante assinado");
  });

  it("o aviso do requerente não nomeia ninguém, e o titular o lê", async () => {
    const amb = await novo();
    const cen = await cenario(amb);
    await amarrar_conta_ao_servidor(amb, "servidor_consulta", cen.servidor);
    const requerente = await como(amb, "servidor_consulta");
    const requisicao_id = await pedido_de_duas_linhas(amb, requerente, cen);
    const protocolo = (await ultima(amb)).protocolo!;
    const [l0, l1] = await linhas(amb, requisicao_id);
    await decidir(amb, await como(amb, "tecnico_seguranca"), requisicao_id, l0!.id, l1!.id);

    const avisos = await amb.db.select().from(e.pendencia).where(eq(e.pendencia.tipo, "EPI_DECISAO_A_LER"));
    expect(avisos.length).toBe(1);
    expect(avisos[0]!.descricao).toContain(protocolo);
    expect(avisos[0]!.descricao).not.toContain("Joana");
    expect(avisos[0]!.descricao).not.toContain("7654321");

    const corpo = (await requerente.get("/pendencias")).text;
    expect(corpo).toContain(protocolo);
    expect(corpo).not.toContain("conteúdo suprimido");
  });

  it("o aviso de retirada fecha quando a reserva é solta", async () => {
    const amb = await novo();
    const cen = await cenario(amb);
    await amarrar_conta_ao_servidor(amb, "servidor_consulta", cen.servidor);
    const requerente = await como(amb, "servidor_consulta");
    const requisicao_id = await pedido_de_duas_linhas(amb, requerente, cen);
    const tecnico = await como(amb, "tecnico_seguranca");
    const [l0, l1] = await linhas(amb, requisicao_id);
    await decidir(amb, tecnico, requisicao_id, l0!.id, l1!.id);
    await tecnico.post(
      `${FILA}/${requisicao_id}/itens/${l0!.id}/reservar`,
      { entrada_id: String(cen.entrada), quantidade: "1" },
      { seguir: false },
    );
    const solta = await tecnico.post(
      `${FILA}/${requisicao_id}/itens/${l0!.id}/soltar-reserva`,
      { motivo: "lote descartado por avaria no transporte" },
      { seguir: false },
    );
    expect(solta.status, recado(solta)).toBe(303);
    const [retirada] = await amb.db.select().from(e.pendencia).where(eq(e.pendencia.tipo, "EPI_RETIRADA_DISPONIVEL"));
    expect(retirada!.concluida).toBe(true);
    expect(await sino(requerente)).toBe(1);
  });

  it("o indeferimento chega a quem pediu", async () => {
    const amb = await novo();
    const cen = await cenario(amb);
    await amarrar_conta_ao_servidor(amb, "servidor_consulta", cen.servidor);
    const requerente = await como(amb, "servidor_consulta");
    const requisicao_id = await pedido_enviado(amb, requerente, cen);
    const tecnico = await como(amb, "tecnico_seguranca");
    await tecnico.post(`${FILA}/${requisicao_id}/analise`, {}, { seguir: false });
    const linha = (await linhas(amb, requisicao_id))[0]!;
    const m = String(await motivo(amb));
    await tecnico.post(`${FILA}/${requisicao_id}/itens/${linha.id}/recusar`, { motivo_id: m, complemento: "" }, { seguir: false });
    const indeferida = await tecnico.post(
      `${FILA}/${requisicao_id}/indeferir`,
      { motivo_id: m, complemento: "", parecer: "" },
      { seguir: false },
    );
    expect(indeferida.status, recado(indeferida)).toBe(303);
    expect(await sino(requerente)).toBe(1);
    expect((await requerente.get("/pendencias")).text).toContain("foi indeferido");
  });

  it("a ficha diz onde retirar, ou diz que não sabe", async () => {
    const amb = await novo();
    const cen = await cenario(amb);
    await amarrar_conta_ao_servidor(amb, "servidor_consulta", cen.servidor);
    const tecnico = await como(amb, "tecnico_seguranca");
    const requisicao_id = await pedido_enviado(amb, tecnico, cen);
    const linha = (await linhas(amb, requisicao_id))[0]!;
    await tecnico.post(`${FILA}/${requisicao_id}/analise`, {}, { seguir: false });
    await tecnico.post(
      `${FILA}/${requisicao_id}/itens/${linha.id}/aprovar`,
      { quantidade_aprovada: "1", justificativa: "" },
      { seguir: false },
    );
    await tecnico.post(`${FILA}/${requisicao_id}/concluir`, { parecer: "" }, { seguir: false });
    await tecnico.post(
      `${FILA}/${requisicao_id}/itens/${linha.id}/reservar`,
      { entrada_id: String(cen.entrada), quantidade: "1" },
      { seguir: false },
    );
    const sem = (await tecnico.get(`${FILA}/${requisicao_id}`)).text;
    expect(sem).toContain("local de retirada ainda não está registrado");
    expect(sem).toContain("CSSO_EPI_LOCAL_RETIRADA");

    const endereco = "Almoxarifado do SESMT — prédio 5, sala 12, de 8h às 11h";
    process.env.CSSO_EPI_LOCAL_RETIRADA = endereco;
    redefinirConfig();
    try {
      const com = (await tecnico.get(`${FILA}/${requisicao_id}`)).text;
      expect(com).toContain(endereco);
      expect(com).not.toContain("ainda não está registrado");
    } finally {
      delete process.env.CSSO_EPI_LOCAL_RETIRADA;
      redefinirConfig();
    }
  });
});
