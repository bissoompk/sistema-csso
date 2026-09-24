/**
 * Cenário da ficha de EPI: um servidor, um item e um lote com saldo — direto
 * no banco. O `_cenario` de `test_epi_ficha.py`, usado também por
 * `registro_de_leitura_epi.test.ts` e `epi_adicional.test.ts`.
 */
import { asc, eq } from "drizzle-orm";
import type { Executor } from "../src/db/cliente.js";
import * as e from "../src/db/esquema/index.js";
import * as datas_br from "../src/servicos/datas_br.js";
import { bancoLimpo, type AmbienteDeTeste, type Cliente, type Resposta } from "./ajuda.js";

export const FICHAS = "/epis/fichas";
export const ENTREGAS = "/epis/entregas";
export const NOVA = "/epis/entregas/nova";

export const HOJE = datas_br.hoje();
export const ONTEM = datas_br.somar_dias(HOJE, -1);
export const DAQUI_A_UM_ANO = datas_br.somar_dias(HOJE, 365);

export interface OpcoesCenario {
  validade_ca_catalogo?: string | null;
  validade_ca_lote?: string | null;
  recebido?: number;
  quantidade_maxima?: number | null;
  periodo_maximo_meses?: number | null;
  vida_util_meses?: number | null;
  siape?: string;
  nome?: string;
}

export interface Cenario {
  servidor: number;
  item: number;
  entrada: number;
}

export async function cenario(db: Executor, o: OpcoesCenario = {}): Promise<Cenario> {
  const [categoria] = await db
    .select()
    .from(e.epi_categoria)
    .where(eq(e.epi_categoria.codigo, "PROT_MEMBROS_SUPERIORES"));
  const [unidade] = await db.select().from(e.unidade_uorg).orderBy(asc(e.unidade_uorg.id)).limit(1);
  const [cargo] = await db.select().from(e.cargo).orderBy(asc(e.cargo.id)).limit(1);
  const [servidor] = await db
    .insert(e.servidor)
    .values({
      siape: o.siape ?? "7654321",
      nome: o.nome ?? "Joana Ribeiro de Almeida",
      cargo_id: cargo!.id,
      unidade_uorg_id: unidade!.id,
    })
    .returning();
  const [item] = await db
    .insert(e.epi_item)
    .values({
      nome: "Luva de proteção química nitrílica",
      categoria_id: categoria!.id,
      fabricante: "Fabricante Exemplo Ltda",
      marca: "Nitri",
      modelo: "NX-200",
      normas: "ABNT NBR 13697",
      exige_ca: true,
      numero_ca: "41234",
      validade_ca: o.validade_ca_catalogo === undefined ? DAQUI_A_UM_ANO : o.validade_ca_catalogo,
      unidade_medida: "PAR",
      tamanhos: "P\nM\nG",
      vida_util_meses: o.vida_util_meses === undefined ? 6 : o.vida_util_meses,
      quantidade_padrao: 2,
      quantidade_maxima: o.quantidade_maxima ?? null,
      periodo_maximo_meses: o.periodo_maximo_meses ?? null,
    })
    .returning();
  const recebido = o.recebido ?? 10;
  const [entrada] = await db
    .insert(e.epi_entrada_estoque)
    .values({
      epi_item_id: item!.id,
      tamanho: "M",
      pregao: "90012/2025",
      item_pregao: "7",
      empenho: "2026NE000123",
      nota_fiscal: "4471",
      fornecedor_nome: "Distribuidora de EPI Ltda",
      data_entrada: datas_br.somar_dias(HOJE, -30),
      quantidade_recebida: recebido,
      lote: "L-2026-08",
      numero_ca: "41234",
      validade_ca: o.validade_ca_lote === undefined ? DAQUI_A_UM_ANO : o.validade_ca_lote,
    })
    .returning();
  // o lote entra no razão: saldo é soma de movimentos, nunca célula
  await db.insert(e.epi_movimento_estoque).values({ entrada_id: entrada!.id, tipo: "ENTRADA", quantidade: recebido });
  return { servidor: servidor!.id, item: item!.id, entrada: entrada!.id };
}

export function entregar(cliente: Cliente, c: Cenario, troca: Record<string, string | number> = {}): Promise<Resposta> {
  const dados: Record<string, string> = {
    servidor_id: String(c.servidor),
    item_id: String(c.item),
    quantidade: "2",
    entrada_id: String(c.entrada),
    tamanho: "M",
    data_evento: HOJE,
    observacao: "",
    justificativa_excecao: "",
  };
  for (const [k, v] of Object.entries(troca)) dados[k] = String(v);
  return cliente.post(ENTREGAS, dados, { seguir: false });
}

export async function registros(db: Executor) {
  return db.select().from(e.epi_ficha_registro).orderBy(asc(e.epi_ficha_registro.id));
}

export async function movimentos_do_lote(db: Executor, c: Cenario) {
  return db
    .select()
    .from(e.epi_movimento_estoque)
    .where(eq(e.epi_movimento_estoque.entrada_id, c.entrada))
    .orderBy(asc(e.epi_movimento_estoque.id));
}

/** O que o sistema respondeu, venha por redirect ou pela tela redesenhada. */
export function recado(r: Resposta): string {
  const destino = r.location;
  return destino ? decodeURIComponent(destino) : r.text;
}

/** Amarra a conta ao servidor (a conta que opera vira a titular). */
export async function virar_o_titular(db: Executor, servidor_id: number, login = "coordenador_csso"): Promise<void> {
  await db.update(e.usuario).set({ servidor_id }).where(eq(e.usuario.login, login));
}

/**
 * Banco virgem por teste (o do arquivo, restaurado no lugar — `testes/ajuda.ts`).
 */
export async function bancoPorTeste(): Promise<AmbienteDeTeste> {
  return bancoLimpo();
}
