/**
 * Fatia 3 de Gestão de EPI: o estoque — entrada de lote, razão e saldo.
 * Porte de `testes/integracao/test_epi_estoque.py`.
 *
 * O que estes testes protegem, em ordem de gravidade:
 * 1. Saldo é soma de movimentos, nunca célula.
 * 2. Devolução não é estorno (uma repõe saldo, o outro não).
 * 3. O lote vencido continua no estoque, marcado, e sai só por DESCARTE com motivo.
 * 4. Ajuste é a única forma legítima de o saldo encontrar a contagem física.
 *
 * Banco limpo por teste (`beforeEach`), como o fixture `banco` do pytest.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { asc, eq, getTableColumns, sql } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import * as epi_estoque from "../src/servicos/epi_estoque.js";
import { cadeia_integra } from "../src/servicos/auditoria.js";
import { hoje, numerica, somar_dias } from "../src/servicos/datas_br.js";
import { bancoLimpo, contas, entrar, type AmbienteDeTeste, type Cliente, type Resposta } from "./ajuda";

const ESTOQUE = "/epis/estoque";
const ENTREGAS = "/epis/entregas";
const FICHAS = "/epis/fichas";

const HOJE = hoje();
const ONTEM = somar_dias(HOJE, -1);
const DAQUI_A_UM_ANO = somar_dias(HOJE, 365);
const DAQUI_A_UM_MES = somar_dias(HOJE, 30);

let amb: AmbienteDeTeste = await bancoLimpo();
let db: Banco = amb.db;
let cliente: Cliente = amb.cliente;

beforeEach(async () => {
  amb = await bancoLimpo();
  db = amb.db;
  cliente = amb.cliente;
  await contas(db);
});

// =====================================================================
// Cenário
// =====================================================================
interface Cenario {
  item: number;
  servidor: number;
}

/** Um item de catálogo e um servidor. Os lotes entram pela tela. */
async function _cenario(opcoes: { vida_util_meses?: number | null } = {}): Promise<Cenario> {
  const [categoria] = await db.select().from(e.epi_categoria).where(eq(e.epi_categoria.codigo, "PROT_MEMBROS_SUPERIORES"));
  const [unidade] = await db.select().from(e.unidade_uorg).limit(1);
  const [cargo] = await db.select().from(e.cargo).limit(1);
  const [item] = await db
    .insert(e.epi_item)
    .values({
      nome: "Luva de proteção química nitrílica",
      categoria_id: categoria!.id,
      fabricante: "Fabricante Exemplo Ltda",
      marca: "Nitri",
      modelo: "NX-200",
      exige_ca: true,
      numero_ca: "41234",
      validade_ca: DAQUI_A_UM_ANO,
      unidade_medida: "PAR",
      tamanhos: "P\nM\nG",
      vida_util_meses: opcoes.vida_util_meses === undefined ? 6 : opcoes.vida_util_meses,
      quantidade_padrao: 2,
    })
    .returning();
  const [servidor] = await db
    .insert(e.servidor)
    .values({ siape: "7654321", nome: "Joana Ribeiro de Almeida", cargo_id: cargo!.id, unidade_uorg_id: unidade!.id })
    .returning();
  return { item: item!.id, servidor: servidor!.id };
}

function _lote(c: Cliente, cenario: Cenario, troca: Record<string, string> = {}): Promise<Resposta> {
  const dados: Record<string, string> = {
    item_id: String(cenario.item),
    quantidade_recebida: "10",
    data_entrada: HOJE,
    tamanho: "M",
    pregao: "90012/2025",
    item_pregao: "7",
    empenho: "2026NE000123",
    nota_fiscal: "4471",
    quantidade_empenhada: "12",
    valor_unitario: "12,50",
    fornecedor_nome: "Distribuidora de EPI Ltda",
    fornecedor_cnpj: "12345678000199",
    fornecedor_contato: "vendas@distribuidora.com.br",
    lote: "L-2026-08",
    numero_ca: "41234",
    validade_ca: DAQUI_A_UM_ANO,
    data_fabricacao: "",
    observacao: "",
    ...troca,
  };
  return c.post(ESTOQUE, dados, { seguir: false });
}

function _entradas() {
  return db.select().from(e.epi_entrada_estoque).orderBy(asc(e.epi_entrada_estoque.id));
}

function _movimentos(entrada_id: number) {
  return db
    .select()
    .from(e.epi_movimento_estoque)
    .where(eq(e.epi_movimento_estoque.entrada_id, entrada_id))
    .orderBy(asc(e.epi_movimento_estoque.id));
}

function _saldo(entrada_id: number): Promise<number> {
  return epi_estoque.saldo_fisico(db, entrada_id);
}

function _entregar(c: Cliente, cenario: Cenario, entrada_id: number, quantidade = 3): Promise<Resposta> {
  return c.post(
    ENTREGAS,
    {
      servidor_id: String(cenario.servidor),
      item_id: String(cenario.item),
      quantidade: String(quantidade),
      entrada_id: String(entrada_id),
      tamanho: "M",
      data_evento: HOJE,
      observacao: "",
      justificativa_excecao: "",
    },
    { seguir: false },
  );
}

function _registros() {
  return db.select().from(e.epi_ficha_registro).orderBy(asc(e.epi_ficha_registro.id));
}

/** O que o sistema respondeu, venha por redirect ou pela tela redesenhada. */
function _recado(r: Resposta): string {
  const destino = r.location;
  return destino ? decodeURIComponent(destino) : r.text;
}

async function _um_evento(tipo: string) {
  const eventos = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, tipo));
  expect(eventos.length).toBe(1);
  return eventos[0]!;
}

async function _pendencias_de_ca() {
  return db.select().from(e.pendencia).where(eq(e.pendencia.tipo, "CA_A_VENCER"));
}

// =====================================================================
// 1. A entrada do lote
// =====================================================================
describe("a entrada do lote", () => {
  it("grava a compra pública e o primeiro movimento", async () => {
    const cenario = await _cenario();
    await entrar(cliente, "coordenador_csso");
    expect((await _lote(cliente, cenario)).status).toBe(303);

    const entrada = (await _entradas())[0]!;
    expect(entrada.pregao).toBe("90012/2025");
    expect(entrada.item_pregao).toBe("7");
    expect(entrada.empenho).toBe("2026NE000123");
    expect(entrada.nota_fiscal).toBe("4471");
    expect(entrada.fornecedor_nome).toBe("Distribuidora de EPI Ltda");
    expect(entrada.fornecedor_cnpj).toBe("12345678000199");
    expect(entrada.fornecedor_contato).toBe("vendas@distribuidora.com.br");
    expect(entrada.quantidade_empenhada).toBe(12);
    expect(entrada.quantidade_recebida).toBe(10);
    // dinheiro é decimal, e "12,50" é como se digita em português
    expect(Number(entrada.valor_unitario)).toBe(12.5);
    expect(entrada.numero_ca).toBe("41234");
    expect(entrada.validade_ca).toBe(DAQUI_A_UM_ANO);

    const movimentos = await _movimentos(entrada.id);
    expect(movimentos.length).toBe(1);
    expect(movimentos[0]!.tipo).toBe("ENTRADA");
    expect(movimentos[0]!.quantidade).toBe(10);
    expect(await _saldo(entrada.id)).toBe(10);
  });

  it("o lote vai para a trilha com número e dinheiro de verdade", async () => {
    const cenario = await _cenario();
    await entrar(cliente, "coordenador_csso");
    await _lote(cliente, cenario);
    const evento = await _um_evento("EPI_LOTE_REGISTRADO");
    const valor = evento.valor_novo as Record<string, unknown>;
    expect(valor.quantidade_recebida).toBe(10);
    expect(valor.empenho).toBe("2026NE000123");
    // o decimal sobrevive à ida e à volta pela coluna como texto; float não
    expect(valor.valor_unitario).toBe("12.50");
    expect(await cadeia_integra(db)).toEqual([true, null]);
  });

  it("receber mais do que o empenho é recusado", async () => {
    const cenario = await _cenario();
    await entrar(cliente, "coordenador_csso");
    const r = await _lote(cliente, cenario, { quantidade_empenhada: "5", quantidade_recebida: "10" });
    expect(_recado(r)).toContain("empenho é de 5");
    expect(await _entradas()).toEqual([]);
  });

  it("entrada com data futura é recusada", async () => {
    const cenario = await _cenario();
    await entrar(cliente, "coordenador_csso");
    const r = await _lote(cliente, cenario, { data_entrada: somar_dias(HOJE, 1) });
    expect(_recado(r)).toContain("não pode ser futura");
    expect(await _entradas()).toEqual([]);
  });

  it("valor em branco não vira zero", async () => {
    const cenario = await _cenario();
    await entrar(cliente, "coordenador_csso");
    await _lote(cliente, cenario, { valor_unitario: "" });
    expect((await _entradas())[0]!.valor_unitario).toBeNull();
  });
});

// =====================================================================
// 2. RN-25 — o lote vencido entra, aparece e não sai
// =====================================================================
describe("RN-25: o lote vencido", () => {
  it("entra no estoque e avisa", async () => {
    const cenario = await _cenario();
    await entrar(cliente, "coordenador_csso");
    const r = await _lote(cliente, cenario, { validade_ca: ONTEM });
    expect(r.status).toBe(303);
    expect(_recado(r)).toContain("não pode ser entregue");
    expect((await _entradas()).length).toBe(1);
  });

  it("fica visível e marcado no estoque", async () => {
    const cenario = await _cenario();
    await entrar(cliente, "coordenador_csso");
    await _lote(cliente, cenario, { validade_ca: ONTEM });
    const corpo = (await cliente.get(ESTOQUE)).text;
    expect(corpo).toContain(`/epis/estoque/${(await _entradas())[0]!.id}/movimentos`);
    expect(corpo).toContain("venceu em");
    expect(corpo).toContain("não pode ser entregue");
    expect(corpo).toContain("10 unidade(s) em 1 lote(s)");
  });

  it("não sai, e o saldo não se move", async () => {
    const cenario = await _cenario();
    await entrar(cliente, "coordenador_csso");
    await _lote(cliente, cenario, { validade_ca: ONTEM });
    const entrada = (await _entradas())[0]!;
    const r = await _entregar(cliente, cenario, entrada.id);
    expect(_recado(r)).toContain("CA vencido");
    expect(await _saldo(entrada.id)).toBe(10);
  });
});

// =====================================================================
// 3. O saldo em cada passo
// =====================================================================
describe("o saldo em cada passo", () => {
  it("bate em cada passo da vida do lote", async () => {
    const cenario = await _cenario();
    await entrar(cliente, "coordenador_csso");
    await _lote(cliente, cenario, { quantidade_recebida: "10", quantidade_empenhada: "10" });
    const entrada = (await _entradas())[0]!;
    expect(await _saldo(entrada.id)).toBe(10);

    expect((await _entregar(cliente, cenario, entrada.id, 3)).status).toBe(303);
    expect(await _saldo(entrada.id)).toBe(7);

    const registro = (await _registros())[0]!;
    const devolucao = await cliente.post(
      `${FICHAS}/registros/${registro.id}/devolucao`,
      { quantidade: "2", motivo: "troca por desgaste", data_evento: "" },
      { seguir: false },
    );
    expect(devolucao.status).toBe(303);
    expect(await _saldo(entrada.id)).toBe(9);

    const descarte = await cliente.post(
      `${ESTOQUE}/${entrada.id}/descarte`,
      { quantidade: "1", motivo: "par rasgado na conferência" },
      { seguir: false },
    );
    expect(descarte.status).toBe(303);
    expect(await _saldo(entrada.id)).toBe(8);

    const ajuste = await cliente.post(
      `${ESTOQUE}/${entrada.id}/ajuste`,
      { contagem: "6", motivo: "contagem do inventário anual" },
      { seguir: false },
    );
    expect(ajuste.status).toBe(303);
    expect(await _saldo(entrada.id)).toBe(6);

    expect((await _movimentos(entrada.id)).map((m) => [m.tipo, m.quantidade])).toEqual([
      ["ENTRADA", 10],
      ["SAIDA", -3],
      ["DEVOLUCAO", 2],
      ["DESCARTE", -1],
      ["AJUSTE", -2],
    ]);
    const corpo = (await cliente.get(`${ESTOQUE}/${entrada.id}/movimentos`)).text;
    for (const esperado of ["entrada", "saída", "devolução", "descarte", "ajuste"]) expect(corpo).toContain(esperado);
    expect(corpo).toContain("contagem física 6");
  });

  it("o extrato acumula o saldo na ordem em que os fatos foram gravados", async () => {
    const cenario = await _cenario();
    await entrar(cliente, "coordenador_csso");
    await _lote(cliente, cenario, { quantidade_recebida: "10", quantidade_empenhada: "10" });
    const entrada = (await _entradas())[0]!;
    await _entregar(cliente, cenario, entrada.id, 4);
    const linhas = await epi_estoque.extrato(db, entrada.id);
    expect(linhas.map((l) => l.saldo_depois)).toEqual([10, 6]);
    expect(linhas[linhas.length - 1]!.saldo_depois).toBe(await epi_estoque.saldo_fisico(db, entrada.id));
  });
});

// =====================================================================
// 4. Devolução × estorno
// =====================================================================
describe("devolução não é estorno", () => {
  it("devolução repõe saldo e estorno não", async () => {
    const cenario = await _cenario();
    await entrar(cliente, "coordenador_csso");
    await _lote(cliente, cenario, { quantidade_recebida: "10", quantidade_empenhada: "10" });
    const entrada = (await _entradas())[0]!;

    await _entregar(cliente, cenario, entrada.id, 4);
    expect(await _saldo(entrada.id)).toBe(6);
    const primeira = (await _registros())[0]!;

    await cliente.post(`${FICHAS}/registros/${primeira.id}/estorno`, { motivo: "servidor errado" });
    expect(await _saldo(entrada.id)).toBe(6);

    await _entregar(cliente, cenario, entrada.id, 2);
    expect(await _saldo(entrada.id)).toBe(4);
    const regs = await _registros();
    const segunda = regs[regs.length - 1]!;
    await cliente.post(`${FICHAS}/registros/${segunda.id}/devolucao`, { quantidade: "2", motivo: "desligamento do servidor" });
    expect(await _saldo(entrada.id)).toBe(6);

    expect((await _movimentos(entrada.id)).map((m) => m.tipo)).toEqual(["ENTRADA", "SAIDA", "SAIDA", "DEVOLUCAO"]);
  });

  it("a devolução vira linha na ficha sem desfazer a entrega", async () => {
    const cenario = await _cenario();
    await entrar(cliente, "coordenador_csso");
    await _lote(cliente, cenario, { quantidade_recebida: "10", quantidade_empenhada: "10" });
    const entrada = (await _entradas())[0]!;
    await _entregar(cliente, cenario, entrada.id, 3);
    const entrega = (await _registros())[0]!;

    await cliente.post(`${FICHAS}/registros/${entrega.id}/devolucao`, { quantidade: "1", motivo: "luva furada" });
    const registros = await _registros();
    expect(registros.length).toBe(2);
    const devolucao = registros[1]!;
    expect(devolucao.tipo).toBe("DEVOLUCAO");
    expect(devolucao.quantidade).toBe(1);
    expect(devolucao.nome_epi_snapshot).toBe(entrega.nome_epi_snapshot);
    expect(devolucao.numero_ca_snapshot).toBe(entrega.numero_ca_snapshot);
    expect(devolucao.lote_snapshot).toBe(entrega.lote_snapshot);
    expect(devolucao.registro_estornado_id).toBeNull();
    expect((devolucao.contexto_congelado as Record<string, unknown>).registro_devolvido).toBe(entrega.id);

    const corpo = (await cliente.get(`${FICHAS}/${cenario.servidor}`)).text;
    expect(corpo).toContain("devolução");
    expect(corpo).not.toContain("estornado pelo");
  });

  it("não se devolve mais do que a pessoa recebeu", async () => {
    const cenario = await _cenario();
    await entrar(cliente, "coordenador_csso");
    await _lote(cliente, cenario, { quantidade_recebida: "10", quantidade_empenhada: "10" });
    const entrada = (await _entradas())[0]!;
    await _entregar(cliente, cenario, entrada.id, 2);
    const entrega = (await _registros())[0]!;
    const r = await cliente.post(
      `${FICHAS}/registros/${entrega.id}/devolucao`,
      { quantidade: "5", motivo: "devolveu tudo" },
      { seguir: false },
    );
    expect(_recado(r)).toContain("está com 2");
    expect(await _saldo(entrada.id)).toBe(8);
  });

  it("devolução sem motivo é recusada", async () => {
    const cenario = await _cenario();
    await entrar(cliente, "coordenador_csso");
    await _lote(cliente, cenario, { quantidade_recebida: "10", quantidade_empenhada: "10" });
    const entrada = (await _entradas())[0]!;
    await _entregar(cliente, cenario, entrada.id, 2);
    const entrega = (await _registros())[0]!;
    const r = await cliente.post(`${FICHAS}/registros/${entrega.id}/devolucao`, { quantidade: "1", motivo: "   " }, { seguir: false });
    expect(_recado(r)).toContain("por que o equipamento voltou");
    expect(await _saldo(entrada.id)).toBe(8);
  });

  it("estornar entrega já devolvida é recusado", async () => {
    const cenario = await _cenario();
    await entrar(cliente, "coordenador_csso");
    await _lote(cliente, cenario, { quantidade_recebida: "10", quantidade_empenhada: "10" });
    const entrada = (await _entradas())[0]!;
    await _entregar(cliente, cenario, entrada.id, 3);
    const entrega = (await _registros())[0]!;
    await cliente.post(`${FICHAS}/registros/${entrega.id}/devolucao`, { quantidade: "3", motivo: "trocou de posto" });
    const r = await cliente.post(`${FICHAS}/registros/${entrega.id}/estorno`, { motivo: "quantidade errada" }, { seguir: false });
    expect(_recado(r)).toContain("já teve 3 devolvido");
    expect(await _saldo(entrada.id)).toBe(10);
  });

  it("devolução de entrega estornada é recusada", async () => {
    const cenario = await _cenario();
    await entrar(cliente, "coordenador_csso");
    await _lote(cliente, cenario, { quantidade_recebida: "10", quantidade_empenhada: "10" });
    const entrada = (await _entradas())[0]!;
    await _entregar(cliente, cenario, entrada.id, 3);
    const entrega = (await _registros())[0]!;
    await cliente.post(`${FICHAS}/registros/${entrega.id}/estorno`, { motivo: "servidor errado" });
    const r = await cliente.post(`${FICHAS}/registros/${entrega.id}/devolucao`, { quantidade: "1", motivo: "voltou" }, { seguir: false });
    expect(_recado(r)).toContain("foi estornado");
    expect(await _saldo(entrada.id)).toBe(7);
  });
});

// =====================================================================
// 5. Ajuste de inventário
// =====================================================================
describe("ajuste de inventário", () => {
  it("registra a contagem, o motivo e quem contou", async () => {
    const cenario = await _cenario();
    await entrar(cliente, "coordenador_csso");
    await _lote(cliente, cenario);
    const entrada = (await _entradas())[0]!;
    await cliente.post(`${ESTOQUE}/${entrada.id}/ajuste`, { contagem: "7", motivo: "inventário de agosto" });
    const movs = await _movimentos(entrada.id);
    const ajuste = movs[movs.length - 1]!;
    expect(ajuste.tipo).toBe("AJUSTE");
    expect(ajuste.quantidade).toBe(-3);
    expect(ajuste.motivo).toContain("contagem física 7");
    expect(ajuste.motivo).toContain("saldo do sistema 10");
    expect(ajuste.motivo).toContain("inventário de agosto");
    expect(ajuste.registrado_por).not.toBeNull();
    expect(ajuste.ocorrido_em).not.toBeNull();

    const evento = await _um_evento("EPI_ESTOQUE_AJUSTADO");
    expect(evento.valor_anterior).toBe(10);
    expect(evento.valor_novo).toBe(7);
    expect(evento.usuario_nome).toBe("Coordenador de Teste");
  });

  it("ajuste sem motivo é recusado", async () => {
    const cenario = await _cenario();
    await entrar(cliente, "coordenador_csso");
    await _lote(cliente, cenario);
    const entrada = (await _entradas())[0]!;
    const r = await cliente.post(`${ESTOQUE}/${entrada.id}/ajuste`, { contagem: "7", motivo: "  " }, { seguir: false });
    expect(_recado(r)).toContain("é obrigatório");
    expect(await _saldo(entrada.id)).toBe(10);
  });

  it("ajuste que confere com o saldo não grava nada", async () => {
    const cenario = await _cenario();
    await entrar(cliente, "coordenador_csso");
    await _lote(cliente, cenario);
    const entrada = (await _entradas())[0]!;
    const r = await cliente.post(`${ESTOQUE}/${entrada.id}/ajuste`, { contagem: "10", motivo: "conferência de rotina" }, { seguir: false });
    expect(_recado(r)).toContain("confere com o saldo do sistema");
    expect((await _movimentos(entrada.id)).length).toBe(1);
  });

  it("ajuste para cima também é movimento", async () => {
    const cenario = await _cenario();
    await entrar(cliente, "coordenador_csso");
    await _lote(cliente, cenario);
    const entrada = (await _entradas())[0]!;
    await cliente.post(`${ESTOQUE}/${entrada.id}/ajuste`, { contagem: "13", motivo: "caixa encontrada no armário 2" });
    expect(await _saldo(entrada.id)).toBe(13);
    const movs = await _movimentos(entrada.id);
    expect(movs[movs.length - 1]!.quantidade).toBe(3);
  });
});

// =====================================================================
// 6. Descarte
// =====================================================================
describe("descarte", () => {
  it("descartar mais do que há é recusado", async () => {
    const cenario = await _cenario();
    await entrar(cliente, "coordenador_csso");
    await _lote(cliente, cenario);
    const entrada = (await _entradas())[0]!;
    const r = await cliente.post(`${ESTOQUE}/${entrada.id}/descarte`, { quantidade: "11", motivo: "tudo vencido" }, { seguir: false });
    expect(_recado(r)).toContain("saldo não fica negativo");
    expect(await _saldo(entrada.id)).toBe(10);
  });

  it("descarte sem motivo é recusado", async () => {
    const cenario = await _cenario();
    await entrar(cliente, "coordenador_csso");
    await _lote(cliente, cenario);
    const entrada = (await _entradas())[0]!;
    const r = await cliente.post(`${ESTOQUE}/${entrada.id}/descarte`, { quantidade: "1", motivo: "" }, { seguir: false });
    expect(_recado(r)).toContain("é obrigatório");
    expect(await _saldo(entrada.id)).toBe(10);
  });

  it("descartar o lote vencido é como ele sai do estoque", async () => {
    const cenario = await _cenario();
    await entrar(cliente, "coordenador_csso");
    await _lote(cliente, cenario, { validade_ca: ONTEM });
    const entrada = (await _entradas())[0]!;
    await cliente.post(`${ESTOQUE}/${entrada.id}/descarte`, {
      quantidade: "10",
      motivo: "CA vencido, sem renovação pelo fabricante",
    });
    expect(await _saldo(entrada.id)).toBe(0);
    const evento = await _um_evento("EPI_ESTOQUE_DESCARTADO");
    expect(evento.valor_anterior).toBe(10);
    expect(evento.valor_novo).toBe(0);
    expect((await cliente.get(ESTOQUE)).text).toContain(`/epis/estoque/${entrada.id}/movimentos`);
  });
});

// =====================================================================
// 7. O que não se edita
// =====================================================================
describe("o que não se edita", () => {
  it("a quantidade não muda pela edição do lote", async () => {
    const cenario = await _cenario();
    await entrar(cliente, "coordenador_csso");
    await _lote(cliente, cenario);
    const entrada = (await _entradas())[0]!;
    await cliente.post(
      `${ESTOQUE}/${entrada.id}`,
      {
        nota_fiscal: "4472",
        fornecedor_contato: "(38) 3532-1200",
        observacao: "caixa com etiqueta rasurada",
        ativo: "1",
        motivo_inativacao: "",
        // o formulário da tela nem tem estes campos; se um dia tiver, este teste percebe
        quantidade_recebida: "999",
        quantidade_empenhada: "999",
      },
      { seguir: false },
    );
    const depois = (await _entradas())[0]!;
    expect(depois.nota_fiscal).toBe("4472");
    expect(depois.fornecedor_contato).toBe("(38) 3532-1200");
    expect(depois.quantidade_recebida).toBe(10);
    expect(depois.quantidade_empenhada).toBe(12);
    expect(await _saldo(entrada.id)).toBe(10);
  });

  it("inativar lote exige motivo", async () => {
    const cenario = await _cenario();
    await entrar(cliente, "coordenador_csso");
    await _lote(cliente, cenario);
    const entrada = (await _entradas())[0]!;
    const r = await cliente.post(
      `${ESTOQUE}/${entrada.id}`,
      { nota_fiscal: "4471", fornecedor_contato: "", observacao: "", ativo: "", motivo_inativacao: "" },
      { seguir: false },
    );
    expect(_recado(r)).toContain("exige o motivo");
    expect((await _entradas())[0]!.ativo).toBe(true);
  });

  it("lote inativado sai da entrega e fica no estoque", async () => {
    const cenario = await _cenario();
    await entrar(cliente, "coordenador_csso");
    await _lote(cliente, cenario);
    const entrada = (await _entradas())[0]!;
    await cliente.post(`${ESTOQUE}/${entrada.id}`, {
      nota_fiscal: "",
      fornecedor_contato: "",
      observacao: "",
      ativo: "",
      motivo_inativacao: "recolhido pelo fabricante por defeito de lote",
    });
    expect((await _entradas())[0]!.ativo).toBe(false);
    const r = await _entregar(cliente, cenario, entrada.id, 1);
    expect(_recado(r)).toContain("lote inativado");
    expect(await _saldo(entrada.id)).toBe(10);
    expect((await cliente.get(ESTOQUE)).text).toContain(`/epis/estoque/${entrada.id}/movimentos`);
  });

  it("o lote não guarda saldo materializado", () => {
    const colunas = Object.values(getTableColumns(e.epi_entrada_estoque)).map((c) => c.name);
    const suspeitas = colunas.filter((c) => c.includes("saldo") || c.split("_").includes("estoque"));
    expect(suspeitas).toEqual([]);
    expect(colunas).toContain("quantidade_recebida");
    expect(colunas).toContain("quantidade_empenhada");
  });
});

// =====================================================================
// 8. A pendência do CA a vencer (RN-25)
// =====================================================================
describe("a pendência do CA a vencer", () => {
  it("lote a vencer abre pendência com prazo na validade", async () => {
    const cenario = await _cenario();
    await entrar(cliente, "coordenador_csso");
    await _lote(cliente, cenario, { validade_ca: DAQUI_A_UM_MES });
    const entrada = (await _entradas())[0]!;
    const pendencias = await _pendencias_de_ca();
    expect(pendencias.length).toBe(1);
    const pendencia = pendencias[0]!;
    expect(pendencia.chave).toBe(epi_estoque.chave_da_pendencia_de_ca(entrada.id));
    expect(pendencia.prazo).toBe(DAQUI_A_UM_MES);
    expect(pendencia.entidade).toBe("epi_entrada_estoque");
    expect(pendencia.descricao).toContain("ainda tem saldo em estoque");
    // o saldo do momento NÃO entra no texto (a data sai antes da procura)
    expect(pendencia.descricao.replace(numerica(DAQUI_A_UM_MES), "")).not.toContain("10");
  });

  it("lote com validade distante não abre pendência", async () => {
    const cenario = await _cenario();
    await entrar(cliente, "coordenador_csso");
    await _lote(cliente, cenario, { validade_ca: DAQUI_A_UM_ANO });
    expect(await _pendencias_de_ca()).toEqual([]);
  });

  it("descartar o saldo fecha a pendência do CA", async () => {
    const cenario = await _cenario();
    await entrar(cliente, "coordenador_csso");
    await _lote(cliente, cenario, { validade_ca: DAQUI_A_UM_MES });
    const entrada = (await _entradas())[0]!;
    await cliente.post(`${ESTOQUE}/${entrada.id}/descarte`, { quantidade: "10", motivo: "CA a vencer sem previsão de renovação" });
    const pendencias = await _pendencias_de_ca();
    expect(pendencias.length).toBe(1);
    expect(pendencias[0]!.concluida).toBe(true);
  });
});

// =====================================================================
// 9. A tela
// =====================================================================
describe("a tela", () => {
  it("mostra físico, reservado e disponível", async () => {
    const cenario = await _cenario();
    await entrar(cliente, "coordenador_csso");
    await _lote(cliente, cenario, { quantidade_recebida: "10", quantidade_empenhada: "10" });
    const entrada = (await _entradas())[0]!;
    await _entregar(cliente, cenario, entrada.id, 4);
    const corpo = (await cliente.get(ESTOQUE)).text;
    for (const t of ["Físico", "Reservado", "Disponível", "2026NE000123", "Distribuidora de EPI Ltda", "pode sair"]) {
      expect(corpo).toContain(t);
    }
  });

  it("a busca encontra o lote pelo empenho", async () => {
    const cenario = await _cenario();
    await entrar(cliente, "coordenador_csso");
    await _lote(cliente, cenario);
    const entrada = (await _entradas())[0]!;
    const achou = (await cliente.get(`${ESTOQUE}?q=2026NE000123`)).text;
    expect(achou).toContain(`/epis/estoque/${entrada.id}/movimentos`);
    const vazia = (await cliente.get(`${ESTOQUE}?q=2027NE999999`)).text;
    expect(vazia).not.toContain(`/epis/estoque/${entrada.id}/movimentos`);
    expect(vazia).toContain("Nenhum lote em estoque");
  });

  it("o extrato liga a saída à linha da ficha", async () => {
    const cenario = await _cenario();
    await entrar(cliente, "coordenador_csso");
    await _lote(cliente, cenario, { quantidade_recebida: "10", quantidade_empenhada: "10" });
    const entrada = (await _entradas())[0]!;
    await _entregar(cliente, cenario, entrada.id, 2);
    const registro = (await _registros())[0]!;
    const corpo = (await cliente.get(`${ESTOQUE}/${entrada.id}/movimentos`)).text;
    expect(corpo).toContain(`href="/epis/fichas/registros/${registro.id}"`);
    expect(corpo).toContain("Coordenador de Teste");
  });

  it("o razão recusa alteração mesmo por SQL", async () => {
    const [categoria] = await db.select().from(e.epi_categoria).limit(1);
    const [item] = await db
      .insert(e.epi_item)
      .values({ nome: "Capacete de teste", categoria_id: categoria!.id, exige_ca: false, quantidade_padrao: 1 })
      .returning();
    const [entrada] = await db
      .insert(e.epi_entrada_estoque)
      .values({ epi_item_id: item!.id, data_entrada: HOJE, quantidade_recebida: 5 })
      .returning();
    const [movimento] = await db
      .insert(e.epi_movimento_estoque)
      .values({ entrada_id: entrada!.id, tipo: "ENTRADA", quantidade: 5 })
      .returning();
    const falha = async (p: Promise<unknown>) => {
      let erro: unknown = null;
      try {
        await p;
      } catch (x) {
        erro = x;
      }
      const texto = String((erro as Error)?.message) + String((erro as { cause?: Error })?.cause?.message);
      expect(texto).toContain("append-only");
    };
    await falha(db.execute(sql`UPDATE epi_movimento_estoque SET quantidade = 99 WHERE id = ${movimento!.id}`));
    await falha(db.execute(sql`DELETE FROM epi_movimento_estoque WHERE id = ${movimento!.id}`));
    expect(await epi_estoque.saldo_fisico(db, entrada!.id)).toBe(5);
  });
});

// =====================================================================
// 10. Permissões e o perfil novo
// =====================================================================
describe("permissões", () => {
  it.each([
    ["coordenador_csso", 200, 303],
    ["tecnico_seguranca", 200, 303],
    ["almoxarife_sesmt", 200, 303],
    ["engenheiro_seguranca", 200, 403],
    ["medico_trabalho", 200, 403],
    ["secretaria_csso", 200, 403],
    ["consulta_progep", 200, 403],
    ["auditor_interno", 200, 403],
    ["servidor_consulta", 200, 403],
    ["admin_ti", 403, 403],
  ] as const)("estoque: %s vê %i e escreve %i", async (perfil, ver, escrever) => {
    const cenario = await _cenario();
    await entrar(cliente, perfil);
    expect((await cliente.get(ESTOQUE)).status).toBe(ver);
    expect((await _lote(cliente, cenario)).status).toBe(escrever);
  });

  it("o almoxarife opera o estoque e não toca no resto", async () => {
    const cenario = await _cenario();
    await entrar(cliente, "almoxarife_sesmt");
    expect((await _lote(cliente, cenario)).status).toBe(303);
    const entrada = (await _entradas())[0]!;
    expect((await cliente.get(`${ESTOQUE}/${entrada.id}/movimentos`)).status).toBe(200);
    expect((await _entregar(cliente, cenario, entrada.id, 2)).status).toBe(303);
    expect(await _saldo(entrada.id)).toBe(8);

    expect((await cliente.get("/epis/catalogo")).status).toBe(200);
    expect((await cliente.get("/epis/catalogo")).text).toContain("somente leitura");
  });

  // TODO(porte): `/processos`, `/laudos` e `/auditoria` ainda são esqueletos
  // (agentes Processos e Base) e respondem 404. Religar quando existirem.
  it.skip("o almoxarife não abre processo, laudo nem auditoria", async () => {
    await entrar(cliente, "almoxarife_sesmt");
    expect((await cliente.get("/processos")).status).toBe(403);
    expect((await cliente.get("/laudos")).status).toBe(403);
    expect((await cliente.get("/auditoria")).status).toBe(403);
  });

  it("o almoxarife fecha a própria pendência de comprovante", async () => {
    const cenario = await _cenario();
    await entrar(cliente, "almoxarife_sesmt");
    await _lote(cliente, cenario, { quantidade_recebida: "10", quantidade_empenhada: "10" });
    const entrada = (await _entradas())[0]!;
    await _entregar(cliente, cenario, entrada.id, 2);
    const registro = (await _registros())[0]!;

    // TODO(porte): `/pendencias` (agente Base) ainda não tem rota; religar
    // `expect((await cliente.get("/pendencias")).status).toBe(200)` quando existir.
    const salto = await cliente.get(`${FICHAS}/registros/${registro.id}`, { seguir: false });
    expect(salto.status).toBe(303);
    expect((await cliente.get(`${FICHAS}/${cenario.servidor}`)).status).toBe(200);
    const anexo = await cliente.post(
      `${FICHAS}/registros/${registro.id}/comprovante`,
      { arquivo: new File([new TextEncoder().encode("%PDF-1.4 x")], "assinado.pdf", { type: "application/pdf" }) },
      { seguir: false },
    );
    expect(anexo.status).toBe(303);
    expect(_recado(anexo)).toContain("SHA-256");
  });
});

// =====================================================================
// O CNPJ que truncava em silêncio
// =====================================================================
describe("o CNPJ do fornecedor", () => {
  it("entra pontuado e é gravado só em dígito", async () => {
    const cenario = await _cenario();
    await entrar(cliente, "almoxarife_sesmt");
    expect((await _lote(cliente, cenario, { fornecedor_cnpj: "12.345.678/0001-90" })).status).toBe(303);
    const entradas = await _entradas();
    expect(entradas[entradas.length - 1]!.fornecedor_cnpj).toBe("12345678000190");
  });

  it("com contagem errada é recusado por escrito, e nada grava", async () => {
    const cenario = await _cenario();
    await entrar(cliente, "almoxarife_sesmt");
    const r = await _lote(cliente, cenario, { fornecedor_cnpj: "12345678901" });
    expect(r.status).toBe(200);
    expect(r.text).toContain("11 dígito(s)");
    expect(r.text).toContain("o CNPJ tem 14");
    expect(r.text).toContain("12345678901");
    expect(r.text).toContain('name="empenho"');
    expect(r.text).toContain("2026NE000123");
    expect(await _entradas()).toEqual([]);
  });

  it("o campo de CNPJ não tem mais maxlength", async () => {
    await entrar(cliente, "almoxarife_sesmt");
    const corpo = (await cliente.get("/epis/estoque/nova-entrada")).text;
    const i = corpo.indexOf('id="fornecedor_cnpj"');
    const campo = corpo.slice(i, i + 300);
    expect(campo).not.toContain("maxlength");
    expect(campo).toContain('inputmode="numeric"');
    expect(campo).toContain("12.345.678/0001-90");
  });

  it("o filtro `cnpj` pontua na saída", () => {
    expect(epi_estoque.formatar_cnpj("12345678000190")).toBe("12.345.678/0001-90");
    expect(epi_estoque.formatar_cnpj("123")).toBe("123");
    expect(epi_estoque.formatar_cnpj(null)).toBe("");
  });
});
