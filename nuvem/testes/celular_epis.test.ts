/**
 * EPIs no celular (lote D do plano de celular).
 *
 * - /epis/fichas e as listas do painel viram cartões (`table.empilhavel`): a
 *   célula-título sem rótulo, as outras com `data-coluna`, a ação em
 *   `td.acao-linha` (P7, P15);
 * - as tabelas de números (relatórios e o extrato de movimentos) rolam de lado
 *   com a primeira coluna parada (`table.coluna-fixa`, P8);
 * - o valor unitário abre o teclado com vírgula (`inputmode="decimal"`, P13).
 *
 * P19 (`label.marca-linha`) não se aplica a /epis/requisicoes: a lista não tem
 * seleção em lote, e o teste trava que ela continue sem checkbox solto.
 */
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import * as e from "../src/db/esquema/index.js";
import { hoje, somar_dias } from "../src/servicos/datas_br.js";
import { bancoLimpo, contas, entrar, type AmbienteDeTeste, type Cliente } from "./ajuda";

const HOJE = hoje();
let amb: AmbienteDeTeste;
let cliente: Cliente;
let entradaId = 0;

/** As `<table ...>` de um HTML, cada uma com a abertura e o miolo. */
function tabelas(html: string): { abre: string; corpo: string }[] {
  return [...html.matchAll(/<table\b([^>]*)>([\s\S]*?)<\/table>/g)].map((m) => ({ abre: m[1]!, corpo: m[2]! }));
}

/** Os `<td>` de cada `<tr>` do corpo (fora do `<thead>`). */
function linhas(corpo: string): string[][] {
  const semCabeca = corpo.replace(/<thead>[\s\S]*?<\/thead>/, "");
  return [...semCabeca.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((m) =>
    [...m[1]!.matchAll(/<td\b([^>]*)>/g)].map((t) => t[1]!));
}

/** Contrato do cartão empilhado: fora da célula-título, todo `td` tem rótulo ou é a ação. */
function confereEmpilhavel(corpo: string) {
  const ls = linhas(corpo).filter((tds) => !(tds.length === 1 && /colspan/.test(tds[0]!)));
  expect(ls.length, "a lista veio vazia: o teste não conferiu nenhuma linha").toBeGreaterThan(0);
  for (const tds of ls) {
    expect(tds[0]).not.toMatch(/data-coluna/);
    for (const td of tds.slice(1)) {
      expect(td, `td sem rótulo: <td${td}>`).toMatch(/data-coluna="[^"]+"|class="[^"]*\bacao-linha\b/);
    }
  }
}

beforeAll(async () => {
  amb = await bancoLimpo();
  const db = amb.db;
  await contas(db);
  cliente = await entrar(amb.cliente, "coordenador_csso");

  const [categoria] = await db.select().from(e.epi_categoria).where(eq(e.epi_categoria.codigo, "PROT_MEMBROS_SUPERIORES"));
  const [unidade] = await db.select().from(e.unidade_uorg).limit(1);
  const [cargo] = await db.select().from(e.cargo).limit(1);
  const [item] = await db.insert(e.epi_item).values({
    nome: "Luva nitrílica", categoria_id: categoria!.id, fabricante: "Fab", marca: "M", modelo: "X",
    exige_ca: true, numero_ca: "41234", validade_ca: somar_dias(HOJE, 365), unidade_medida: "PAR",
    tamanhos: "M", vida_util_meses: 6, quantidade_padrao: 1,
  }).returning();
  const [servidor] = await db.insert(e.servidor).values({
    siape: "7654321", nome: "Joana Ribeiro de Almeida", cargo_id: cargo!.id, unidade_uorg_id: unidade!.id,
  }).returning();

  const r = await cliente.post("/epis/estoque", {
    item_id: String(item!.id), quantidade_recebida: "10", data_entrada: HOJE, tamanho: "M",
    pregao: "90012/2025", item_pregao: "7", empenho: "2026NE000123", nota_fiscal: "4471",
    quantidade_empenhada: "12", valor_unitario: "12,50", fornecedor_nome: "Distribuidora",
    fornecedor_cnpj: "12345678000195", fornecedor_contato: "", lote: "L-1", numero_ca: "41234",
    validade_ca: somar_dias(HOJE, 365), data_fabricacao: "", observacao: "",
  }, { seguir: false });
  expect(r.status).toBe(303);
  const [entrada] = await db.select().from(e.epi_entrada_estoque).limit(1);
  entradaId = entrada!.id;

  const ent = await cliente.post("/epis/entregas", {
    servidor_id: String(servidor!.id), item_id: String(item!.id), quantidade: "1",
    entrada_id: String(entradaId), tamanho: "M", data_evento: HOJE, observacao: "", justificativa_excecao: "",
  }, { seguir: false });
  expect(ent.status).toBe(303);
});

describe("EPIs no celular (lote D)", () => {
  it("/epis/fichas é cartão empilhado, com Servidor como título (P7)", async () => {
    const html = (await cliente.get("/epis/fichas")).text;
    const [t] = tabelas(html);
    expect(t!.abre).toMatch(/class="empilhavel"/);
    confereEmpilhavel(t!.corpo);
    expect(t!.corpo).toMatch(/class="acao-linha"/);
    expect(t!.corpo).toMatch(/class="[^"]*\bcurta\b/);
  });

  it("as listas do painel são cartões empilhados", async () => {
    const html = (await cliente.get("/epis")).text;
    const ts = tabelas(html);
    expect(ts.length).toBeGreaterThan(0);
    for (const t of ts) expect(t.abre).toMatch(/class="empilhavel"/);
  });

  it("/epis/requisicoes é cartão empilhado e não tem checkbox sem rótulo (P19)", async () => {
    const html = (await cliente.get("/epis/requisicoes")).text;
    const [t] = tabelas(html);
    expect(t!.abre).toMatch(/class="empilhavel"/);
    // se a lista ganhar seleção em lote, o checkbox entra num `label.marca-linha`
    const soltos = [...t!.corpo.matchAll(/<input[^>]*type="checkbox"/g)].length;
    const rotulados = [...t!.corpo.matchAll(/<label class="marca-linha">\s*<input[^>]*type="checkbox"/g)].length;
    expect(soltos).toBe(rotulados);
  });

  it("/epis/relatorios tem a primeira coluna fixa nas tabelas (P8)", async () => {
    const r = await cliente.get("/epis/relatorios");
    expect(r.status).toBe(200);
    const ts = tabelas(r.text);
    expect(ts.length).toBe(2);
    for (const t of ts) expect(t.abre).toMatch(/class="coluna-fixa"/);
  });

  it("o extrato de movimentos tem a primeira coluna fixa (P8)", async () => {
    const r = await cliente.get(`/epis/estoque/${entradaId}/movimentos`);
    expect(r.status).toBe(200);
    const [t] = tabelas(r.text);
    expect(t!.abre).toMatch(/class="coluna-fixa"/);
  });

  it("o valor unitário abre o teclado decimal (P13)", async () => {
    const html = (await cliente.get("/epis/estoque/nova-entrada")).text;
    expect(html).toMatch(/<input id="valor_unitario"[^>]*inputmode="decimal"/);
  });
});
