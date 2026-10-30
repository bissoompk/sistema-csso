/**
 * O estoque de EPI: o lote, o livro razão e o saldo que sai da soma dele.
 * Porte de `app/servicos/epi_estoque.py` (fatia 3 do módulo Gestão de EPI).
 *
 * A REGRA da devolução não mora aqui, e sim em `epi_ficha.registrar_devolucao`:
 * devolver é fato de uma pessoa que recebeu. Aqui fica só o lançamento no razão.
 *
 * **Saldo é soma, nunca célula.** `saldo_fisico(entrada) =
 * SUM(epi_movimento_estoque.quantidade)`, sobre uma tabela que o banco recusa
 * alterar (`travas.sql`). Não há saldo materializado em lugar nenhum: uma coluna
 * de saldo seria uma segunda fonte para o mesmo número.
 *
 * **Reserva não é movimento**, e por isso `disponivel` não é o físico: a reserva
 * mora em `epi_requisicao_item.quantidade_reservada`, nunca no razão — se
 * entrasse, o físico deixaria de bater com a contagem da prateleira.
 *
 * **O lote vencido não some.** Sai da lista de entrega (`lotes_de` o marca com
 * impedimento) e continua no estoque, etiquetado. Tirá-lo da prateleira é
 * `DESCARTE` com motivo.
 *
 * **Correção é movimento novo** (`AJUSTE`), nunca `UPDATE` no razão.
 *
 * O filtro de template `cnpj` é registrado AQUI (e não em `web.ts`): `web.ts`
 * importar este módulo fecharia o ciclo web → epi_estoque → pendencias → web,
 * e `pendencias.ts` usa `ganchos` de `web.ts` já no carregamento.
 */
import { JANELA_A_VENCER_DIAS } from "../dominio/treinamento.js";
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  epi_entrada_estoque,
  epi_item,
  epi_movimento_estoque,
  epi_requisicao_item,
  pendencia as tabela_pendencia,
} from "../db/esquema/index.js";
import { RegraViolada } from "../nucleo/erros.js";
import { EpiItem as EpiItemDominio } from "../dominio/epi.js";
import { filtro } from "../web.js";
import * as auditoria from "./auditoria.js";
import * as datas_br from "./datas_br.js";
import * as pendencias from "./pendencias.js";
import * as textos from "./textos.js";
import type { UsuarioAtual } from "./rbac.js";
// ciclo aceito: o uso é só em tempo de chamada (no Python eram imports locais)
import * as epi_requisicao from "./epi_requisicao.js";

export type EpiItem = typeof epi_item.$inferSelect;
export type EpiEntradaEstoque = typeof epi_entrada_estoque.$inferSelect;
export type EpiMovimentoEstoque = typeof epi_movimento_estoque.$inferSelect;

export const ENTRADA = "ENTRADA";
export const SAIDA = "SAIDA";
export const DEVOLUCAO = "DEVOLUCAO";
export const DESCARTE = "DESCARTE";
export const AJUSTE = "AJUSTE";

export const EPI_LOTE_REGISTRADO = "EPI_LOTE_REGISTRADO";
export const EPI_LOTE_ALTERADO = "EPI_LOTE_ALTERADO";
export const EPI_ESTOQUE_DESCARTADO = "EPI_ESTOQUE_DESCARTADO";
export const EPI_ESTOQUE_AJUSTADO = "EPI_ESTOQUE_AJUSTADO";

export const TIPO_PENDENCIA_CA = "CA_A_VENCER";

// RN-25: a pendência do CA abre 60 dias antes do vencimento — o mesmo horizonte
// de `EpiItem.ca_a_vencer_em` no catálogo.
export const DIAS_AVISO_CA = JANELA_A_VENCER_DIAS;

/** O que impede este movimento, tudo de uma vez (lista, e não primeiro-erro). */
export class EstoqueBloqueado extends RegraViolada {
  /**
   * `campo`: o `name` do campo do formulário que produziu a PRIMEIRA recusa,
   * quando há um só culpado — a tela o marca e põe o foco nele. Vazio quando o
   * motivo cruza campos.
   */
  constructor(
    public motivos: string[],
    public campo: string | null = null,
  ) {
    super("Movimento recusado: " + motivos.join("; "));
  }
}

// =====================================================================
// Saldo — a soma do razão
// =====================================================================
/** O que está na prateleira, pela soma do razão. */
export async function saldo_fisico(tx: Executor, entrada_id: number): Promise<number> {
  const [linha] = await tx
    .select({ soma: sql<string>`coalesce(sum(${epi_movimento_estoque.quantidade}), 0)` })
    .from(epi_movimento_estoque)
    .where(eq(epi_movimento_estoque.entrada_id, entrada_id));
  return Number(linha?.soma ?? 0);
}

/** `{entrada_id: saldo}` numa consulta só — o mesmo `SUM`, com `GROUP BY`. */
export async function saldos_de_todos(tx: Executor): Promise<Map<number, number>> {
  const linhas = await tx
    .select({
      entrada_id: epi_movimento_estoque.entrada_id,
      soma: sql<string>`coalesce(sum(${epi_movimento_estoque.quantidade}), 0)`,
    })
    .from(epi_movimento_estoque)
    .groupBy(epi_movimento_estoque.entrada_id);
  return new Map(linhas.map((l) => [Number(l.entrada_id), Number(l.soma)]));
}

/**
 * O que este lote já prometeu a pedidos abertos: a soma de
 * `quantidade_reservada` dos itens EM `RESERVADO` que apontam para ele. O filtro
 * por estado não é redundante com a coluna: os dois juntos impedem que um
 * esquecimento de um lado vire promessa fantasma do outro.
 */
export async function reservado(tx: Executor, entrada_id: number): Promise<number> {
  const [linha] = await tx
    .select({ soma: sql<string>`coalesce(sum(${epi_requisicao_item.quantidade_reservada}), 0)` })
    .from(epi_requisicao_item)
    .where(and(eq(epi_requisicao_item.entrada_id, entrada_id), eq(epi_requisicao_item.estado, "RESERVADO")));
  return Number(linha?.soma ?? 0);
}

/** `{entrada_id: reservado}` numa consulta só — o par agregado de `saldos_de_todos`. */
export async function reservas_de_todos(tx: Executor): Promise<Map<number, number>> {
  const linhas = await tx
    .select({
      entrada_id: epi_requisicao_item.entrada_id,
      soma: sql<string>`coalesce(sum(${epi_requisicao_item.quantidade_reservada}), 0)`,
    })
    .from(epi_requisicao_item)
    .where(and(isNotNull(epi_requisicao_item.entrada_id), eq(epi_requisicao_item.estado, "RESERVADO")))
    .groupBy(epi_requisicao_item.entrada_id);
  return new Map(linhas.map((l) => [Number(l.entrada_id), Number(l.soma)]));
}

/** RN-24 lê daqui: físico menos o que já foi prometido a outro pedido. */
export async function disponivel(tx: Executor, entrada_id: number): Promise<number> {
  return (await saldo_fisico(tx, entrada_id)) - (await reservado(tx, entrada_id));
}

/**
 * Um lote na tela da entrega. `impedimento` é texto, e não booleano, porque a
 * tela precisa dizer POR QUÊ o botão está desabilitado.
 */
export class LoteDisponivel {
  constructor(
    public readonly entrada: EpiEntradaEstoque,
    public readonly saldo: number,
    public readonly impedimento: string = "",
  ) {
    Object.freeze(this);
  }

  get pode_sair(): boolean {
    return !this.impedimento && this.saldo > 0;
  }

  get rotulo(): string {
    const partes = [this.entrada.lote ? `Lote ${this.entrada.lote}` : "Lote sem número"];
    if (this.entrada.tamanho) partes.push(`tam. ${this.entrada.tamanho}`);
    // o mesmo lote pode chegar em duas compras: a nota é o que as separa
    if (this.entrada.nota_fiscal) partes.push(`NF ${this.entrada.nota_fiscal}`);
    partes.push(`CA ${this.entrada.numero_ca || "—"}`);
    partes.push(`${this.saldo} em estoque`);
    return partes.join(" · ");
  }
}

/**
 * RN-25 — o CA que governa a entrega é o DO LOTE, não o do catálogo. "Não sei"
 * não é "está válido": lote sem validade de CA, num item que exige CA, não sai.
 */
export function impedimento_do_lote(
  entrada: Pick<EpiEntradaEstoque, "ativo" | "motivo_inativacao" | "numero_ca" | "validade_ca">,
  item: Pick<EpiItem, "exige_ca">,
  quando: string,
): string {
  if (!entrada.ativo) return `lote inativado: ${entrada.motivo_inativacao || "sem motivo registrado"}`;
  if (!item.exige_ca) return "";
  if (!entrada.numero_ca) return "o lote não tem número de CA registrado";
  if (entrada.validade_ca === null || entrada.validade_ca === undefined) {
    return "o lote não tem validade de CA registrada — “não sei” não é “está válido”";
  }
  if (entrada.validade_ca < quando) {
    // dd/mm/aaaa: este texto vai para a tela e para a mensagem de recusa
    return `o CA ${entrada.numero_ca} do lote venceu em ${datas_br.numerica(entrada.validade_ca)}`;
  }
  return "";
}

/** Os lotes do item, com saldo e impedimento — INCLUSIVE os impedidos. */
export async function lotes_de(
  tx: Executor,
  item: Pick<EpiItem, "id" | "exige_ca">,
  opcoes: { quando?: string | null; tamanho?: string | null } = {},
): Promise<LoteDisponivel[]> {
  const quando = opcoes.quando || datas_br.hoje();
  const condicoes = [eq(epi_entrada_estoque.epi_item_id, item.id)];
  if (opcoes.tamanho) condicoes.push(eq(epi_entrada_estoque.tamanho, opcoes.tamanho));
  const entradas = await tx
    .select()
    .from(epi_entrada_estoque)
    .where(and(...condicoes))
    // `order_by(data_entrada)` do Python; o id desempata como o SQLite fazia
    .orderBy(asc(epi_entrada_estoque.data_entrada), asc(epi_entrada_estoque.id));
  const saida: LoteDisponivel[] = [];
  for (const entrada of entradas) {
    saida.push(new LoteDisponivel(entrada, await disponivel(tx, entrada.id), impedimento_do_lote(entrada, item, quando)));
  }
  return saida;
}

// =====================================================================
// A tela do estoque: saldo por item e por lote
// =====================================================================
/** `Decimal * int` do Python sobre o texto do `numeric`, sem passar por float. */
function multiplicar_decimal(valor: string, fator: number): string {
  const negativo = valor.trim().startsWith("-");
  const [inteira = "0", fracao = ""] = valor.trim().replace(/^[-+]/, "").split(".");
  const escala = fracao.length;
  const produto = BigInt(inteira + fracao) * BigInt(fator);
  let texto = (produto < 0n ? -produto : produto).toString().padStart(escala + 1, "0");
  if (escala) texto = `${texto.slice(0, -escala)}.${texto.slice(-escala)}`;
  const sinal = (negativo ? produto > 0n : produto < 0n) ? "-" : "";
  return sinal + texto;
}

/** Um lote na tela do estoque: físico, reservado e disponível lado a lado. */
export class LinhaDeLote {
  constructor(
    public readonly entrada: EpiEntradaEstoque,
    public readonly fisico: number,
    public readonly reservado: number,
    public readonly impedimento: string,
  ) {
    Object.freeze(this);
  }
  get disponivel(): number {
    return this.fisico - this.reservado;
  }
  get impedido(): boolean {
    return Boolean(this.impedimento);
  }
  /** Quanto o que sobrou custou; `null` quando o lote não trouxe valor (≠ zero). */
  get valor_em_estoque(): string | null {
    if (this.entrada.valor_unitario === null) return null;
    return multiplicar_decimal(this.entrada.valor_unitario, this.fisico);
  }
}

/** Um item do catálogo com os lotes dele. O agrupamento é o da prateleira. */
export class LinhaDeItem {
  constructor(
    public readonly item: EpiItem,
    public readonly lotes: LinhaDeLote[],
  ) {
    Object.freeze(this);
  }
  get fisico(): number {
    return this.lotes.reduce((s, l) => s + l.fisico, 0);
  }
  /** O que pode sair hoje: sem os lotes impedidos. */
  get disponivel(): number {
    return this.lotes.filter((l) => !l.impedimento).reduce((s, l) => s + l.disponivel, 0);
  }
  /** Saldo que existe e não pode sair — o número que pede decisão. */
  get preso_em_lote_vencido(): number {
    return this.lotes.filter((l) => l.impedimento).reduce((s, l) => s + l.fisico, 0);
  }
}

/**
 * O estoque inteiro, por item e por lote — inclusive o que não pode sair.
 * Itens sem lote nenhum ficam de fora: catálogo sem entrada não é estoque zerado.
 */
export async function panorama(
  tx: Executor,
  opcoes: { quando?: string | null; busca?: string } = {},
): Promise<LinhaDeItem[]> {
  const quando = opcoes.quando || datas_br.hoje();
  const busca = opcoes.busca ?? "";
  const alvo = busca.trim() ? textos.chave_busca(busca) : "";
  const entradas = await tx
    .select()
    .from(epi_entrada_estoque)
    .orderBy(asc(epi_entrada_estoque.data_entrada), asc(epi_entrada_estoque.id));
  const saldos = await saldos_de_todos(tx);
  const reservas = await reservas_de_todos(tx);
  const ids = [...new Set(entradas.map((e) => e.epi_item_id))];
  const itens_por_id = new Map<number, EpiItem>(
    ids.length ? (await tx.select().from(epi_item).where(inArray(epi_item.id, ids))).map((i) => [i.id, i]) : [],
  );

  const por_item = new Map<number, LinhaDeLote[]>();
  for (const entrada of entradas) {
    const item = itens_por_id.get(entrada.epi_item_id)!;
    if (alvo && !_casa_a_busca(entrada, item, alvo)) continue;
    let lista = por_item.get(item.id);
    if (!lista) por_item.set(item.id, (lista = []));
    lista.push(
      new LinhaDeLote(
        entrada,
        saldos.get(entrada.id) ?? 0,
        reservas.get(entrada.id) ?? 0,
        impedimento_do_lote(entrada, item, quando),
      ),
    );
  }
  const linhas = [...por_item].map(([item_id, lotes]) => new LinhaDeItem(itens_por_id.get(item_id)!, lotes));
  const chave = (l: LinhaDeItem) => textos.chave_busca(l.item.nome);
  return linhas.sort((a, b) => (chave(a) < chave(b) ? -1 : chave(a) > chave(b) ? 1 : 0));
}

/** Nome do item, modelo, lote, empenho, pregão, CA e fornecedor. */
function _casa_a_busca(entrada: EpiEntradaEstoque, item: EpiItem, alvo: string): boolean {
  const campos = [
    item.nome,
    item.modelo || "",
    entrada.lote || "",
    entrada.empenho || "",
    entrada.pregao || "",
    entrada.numero_ca || "",
    entrada.fornecedor_nome || "",
  ];
  return campos.some((campo) => textos.chave_busca(campo).includes(alvo));
}

/** Um movimento com o saldo que ele deixou. O extrato é do lote. */
export class LinhaDoExtrato {
  constructor(
    public readonly movimento: EpiMovimentoEstoque,
    public readonly saldo_depois: number,
  ) {
    Object.freeze(this);
  }
}

/** O razão do lote, em ordem de `id` (a ordem em que os fatos foram gravados). */
export async function extrato(tx: Executor, entrada_id: number): Promise<LinhaDoExtrato[]> {
  const movimentos = await tx
    .select()
    .from(epi_movimento_estoque)
    .where(eq(epi_movimento_estoque.entrada_id, entrada_id))
    .orderBy(asc(epi_movimento_estoque.id));
  let acumulado = 0;
  return movimentos.map((m) => {
    acumulado += m.quantidade;
    return new LinhaDoExtrato(m, acumulado);
  });
}

// =====================================================================
// Os movimentos
// =====================================================================
async function _nome_do_item(tx: Executor, entrada: Pick<EpiEntradaEstoque, "epi_item_id">): Promise<string> {
  const [item] = await tx.select({ nome: epi_item.nome }).from(epi_item).where(eq(epi_item.id, entrada.epi_item_id));
  return item?.nome ?? "";
}

/**
 * A única porta de escrita no razão. Porta única porque o sinal do movimento é
 * o que faz `SUM(quantidade)` ser um saldo.
 */
async function _movimentar(
  tx: Executor,
  d: {
    entrada: EpiEntradaEstoque;
    tipo: string;
    quantidade: number;
    usuario: UsuarioAtual;
    motivo?: string | null;
    ficha_registro_id?: number | null;
    requisicao_item_id?: number | null;
  },
): Promise<EpiMovimentoEstoque> {
  const [movimento] = await tx
    .insert(epi_movimento_estoque)
    .values({
      entrada_id: d.entrada.id,
      tipo: d.tipo,
      quantidade: d.quantidade,
      ficha_registro_id: d.ficha_registro_id ?? null,
      requisicao_item_id: d.requisicao_item_id ?? null,
      motivo: d.motivo ?? null,
      registrado_por: d.usuario.id,
    })
    .returning();
  await sincronizar_pendencia_de_ca(tx, d.entrada, d.usuario);
  return movimento!;
}

/**
 * Uma linha `SAIDA` no razão, amarrada à linha da ficha. A conferência de saldo
 * (RN-24) mora em quem chama; e não há evento de auditoria próprio — a saída É
 * a entrega, que já entra na trilha.
 */
export function baixar(
  tx: Executor,
  d: {
    entrada: EpiEntradaEstoque;
    quantidade: number;
    ficha_registro_id: number;
    usuario: UsuarioAtual;
    motivo?: string | null;
    requisicao_item_id?: number | null;
  },
): Promise<EpiMovimentoEstoque> {
  return _movimentar(tx, {
    entrada: d.entrada,
    tipo: SAIDA,
    quantidade: -Math.abs(d.quantidade),
    usuario: d.usuario,
    motivo: d.motivo ?? null,
    ficha_registro_id: d.ficha_registro_id,
    requisicao_item_id: d.requisicao_item_id ?? null,
  });
}

/**
 * `DEVOLUCAO`: o equipamento voltou para a prateleira. Positiva. Devolução não
 * é estorno: o estorno diz que o REGISTRO estava errado e não devolve saldo.
 * Quem chama é `epi_ficha.registrar_devolucao`.
 */
export function devolver(
  tx: Executor,
  d: {
    entrada: EpiEntradaEstoque;
    quantidade: number;
    usuario: UsuarioAtual;
    ficha_registro_id?: number | null;
    motivo?: string | null;
  },
): Promise<EpiMovimentoEstoque> {
  return _movimentar(tx, {
    entrada: d.entrada,
    tipo: DEVOLUCAO,
    quantidade: Math.abs(d.quantidade),
    usuario: d.usuario,
    motivo: d.motivo ?? null,
    ficha_registro_id: d.ficha_registro_id ?? null,
  });
}

/**
 * `DESCARTE`: o lote sai da prateleira por decisão, com motivo. A reserva que o
 * descarte deixou sem lastro é solta aqui, e não descoberta no balcão.
 */
export async function descartar(
  tx: Executor,
  usuario: UsuarioAtual,
  d: { entrada: EpiEntradaEstoque; quantidade: number; motivo: string },
): Promise<EpiMovimentoEstoque> {
  usuario.exigir("epi.estoque");
  const { entrada, quantidade } = d;
  const limpo = _motivo_obrigatorio(d.motivo, "motivo do descarte");
  const saldo = await saldo_fisico(tx, entrada.id);
  if (quantidade <= 0) throw new EstoqueBloqueado(["a quantidade a descartar tem de ser maior que zero"]);
  if (quantidade > saldo) {
    throw new EstoqueBloqueado([
      `o lote tem ${saldo} em estoque e o descarte pede ${quantidade}: ` +
        "saldo não fica negativo. Se a prateleira discorda do " +
        "sistema, o caminho é o ajuste de inventário",
    ]);
  }
  const movimento = await _movimentar(tx, {
    entrada,
    tipo: DESCARTE,
    quantidade: -Math.abs(quantidade),
    usuario,
    motivo: limpo,
  });
  await auditoria.registrar(tx, {
    entidade: "epi_entrada_estoque",
    entidade_id: entrada.id,
    tipo_evento: EPI_ESTOQUE_DESCARTADO,
    descricao:
      `${quantidade} × ${await _nome_do_item(tx, entrada)} descartado(s) do lote ` +
      `${entrada.lote || "—"} (CA ${entrada.numero_ca || "—"}): ${limpo}`,
    campo: "saldo",
    // inteiros de verdade: "12" não é 12
    valor_anterior: saldo,
    valor_novo: saldo - quantidade,
    comentario: limpo,
    usuario,
  });
  await _soltar_reservas_sem_lastro(tx, entrada, usuario, {
    motivo: `${quantidade} unidade(s) do lote ${entrada.lote || "—"} foram descartadas: ${limpo}`,
  });
  return movimento;
}

/** Solta o que o lote prometeu e já não tem — a transição é do PEDIDO. */
function _soltar_reservas_sem_lastro(
  tx: Executor,
  entrada: EpiEntradaEstoque,
  usuario: UsuarioAtual,
  d: { motivo: string },
): Promise<number> {
  return epi_requisicao.soltar_reservas_do_lote(tx, usuario, entrada, { motivo: d.motivo });
}

/** `+3` / `-3` / `+0` — o `{:+d}` do Python. */
function com_sinal(n: number): string {
  return n >= 0 ? `+${n}` : String(n);
}

/**
 * `AJUSTE`: o saldo do sistema encontra a contagem física, com motivo. Recebe O
 * QUE FOI CONTADO, e não a diferença.
 */
export async function ajustar(
  tx: Executor,
  usuario: UsuarioAtual,
  d: { entrada: EpiEntradaEstoque; contagem: number; motivo: string },
): Promise<EpiMovimentoEstoque> {
  usuario.exigir("epi.estoque");
  const { entrada, contagem } = d;
  const limpo = _motivo_obrigatorio(d.motivo, "motivo do ajuste de inventário");
  if (contagem < 0) throw new EstoqueBloqueado(["a contagem física não pode ser negativa"]);
  const saldo = await saldo_fisico(tx, entrada.id);
  const diferenca = contagem - saldo;
  if (diferenca === 0) {
    throw new EstoqueBloqueado([
      `a contagem física (${contagem}) confere com o saldo do sistema: ` +
        "não há ajuste a registrar. Movimento de quantidade zero o banco " +
        "recusa, e com razão — ele não diria nada",
    ]);
  }
  const registro_do_motivo =
    `Inventário: contagem física ${contagem}, saldo do sistema ${saldo} ` + `(${com_sinal(diferenca)}). ${limpo}`;
  const movimento = await _movimentar(tx, {
    entrada,
    tipo: AJUSTE,
    quantidade: diferenca,
    usuario,
    motivo: registro_do_motivo,
  });
  await auditoria.registrar(tx, {
    entidade: "epi_entrada_estoque",
    entidade_id: entrada.id,
    tipo_evento: EPI_ESTOQUE_AJUSTADO,
    descricao:
      `Ajuste de inventário no lote ${entrada.lote || "—"} de ` +
      `${await _nome_do_item(tx, entrada)}: ${saldo} → ${contagem} (${com_sinal(diferenca)}). ${limpo}`,
    campo: "saldo",
    valor_anterior: saldo,
    valor_novo: contagem,
    comentario: limpo,
    usuario,
  });
  // inventário para menos também tira lastro de reserva
  if (diferenca < 0) {
    await _soltar_reservas_sem_lastro(tx, entrada, usuario, {
      motivo:
        `a contagem física do lote ${entrada.lote || "—"} encontrou ` +
        `${contagem} onde o sistema dizia ${saldo}: ${limpo}`,
    });
  }
  return movimento;
}

/** Texto limpo e não vazio. RN-30: passa pelo filtro da RN-21 antes de gravar. */
function _motivo_obrigatorio(motivo: string | null | undefined, campo: string): string {
  const limpo = textos.exigir_texto_limpo((motivo || "").trim(), campo);
  if (!limpo) {
    throw new EstoqueBloqueado([
      `${campo} é obrigatório: é o único registro que sobra para quem ` +
        "ler o extrato depois e perguntar por que o saldo mudou",
    ]);
  }
  return limpo;
}

// =====================================================================
// A entrada do lote
// =====================================================================
export interface DadosEntrada {
  item: Pick<EpiItem, "id" | "nome">;
  quantidade_recebida: number;
  data_entrada?: string | null;
  tamanho?: string;
  pregao?: string;
  item_pregao?: string;
  empenho?: string;
  nota_fiscal?: string;
  oficio?: string;
  fornecedor_nome?: string;
  fornecedor_cnpj?: string;
  fornecedor_contato?: string;
  quantidade_empenhada?: number | null;
  /** o `Decimal` do Python, em texto (`valor_decimal`) */
  valor_unitario?: string | null;
  lote?: string;
  numero_ca?: string;
  validade_ca?: string | null;
  data_fabricacao?: string | null;
  observacao?: string;
}

/**
 * O lote entra: a linha da compra e o primeiro movimento do razão, na mesma
 * transação. Lote com CA já vencido É aceito — existe e é patrimônio; o que ele
 * não pode é sair.
 */
export async function registrar_entrada(tx: Executor, usuario: UsuarioAtual, d: DadosEntrada): Promise<EpiEntradaEstoque> {
  usuario.exigir("epi.estoque");
  const hoje = datas_br.hoje();
  const quando = d.data_entrada || hoje;
  const limpo = textos.exigir_texto_limpo((d.observacao || "").trim(), "observação do lote");
  const quantidade_empenhada = d.quantidade_empenhada ?? null;
  const valor_unitario = d.valor_unitario ?? null;
  const validade_ca = d.validade_ca || null;
  const data_fabricacao = d.data_fabricacao || null;

  const problemas: string[] = [];
  // o primeiro campo culpado, para a tela marcar (ver `EstoqueBloqueado.campo`)
  let campo: string | null = null;
  const recusa = (nome: string, texto: string) => {
    problemas.push(texto);
    campo ??= nome;
  };
  if (d.quantidade_recebida <= 0) recusa("quantidade_recebida", "a quantidade recebida tem de ser maior que zero");
  if (quantidade_empenhada !== null && quantidade_empenhada < d.quantidade_recebida) {
    recusa(
      "quantidade_empenhada",
      `o empenho é de ${quantidade_empenhada} e a entrada registra ` +
        `${d.quantidade_recebida} recebidas: receber mais do que se empenhou é ` +
        "erro de digitação ou entrega fora do contrato",
    );
  }
  if (quando > hoje) recusa("data_entrada", "a data de entrada não pode ser futura");
  if (valor_unitario !== null && valor_unitario.trim().startsWith("-") && /[1-9]/.test(valor_unitario)) {
    recusa("valor_unitario", "o valor unitário não pode ser negativo");
  }
  if (data_fabricacao !== null && validade_ca !== null && data_fabricacao > validade_ca) {
    recusa("data_fabricacao", "a fabricação é posterior à validade do CA: confira as duas datas");
  }
  // O tamanho do lote é um dos tamanhos do ITEM: é por ele que a reserva e a
  // entrega acham o lote. Antes o campo era livre, e um lote "XGG" de um item
  // P/M/G nunca casava com pedido nenhum — ficava na prateleira sem saída.
  const tamanho = _ou_nada(d.tamanho);
  const [catalogo] = await tx
    .select({ tamanhos: epi_item.tamanhos })
    .from(epi_item)
    .where(eq(epi_item.id, d.item.id));
  const tamanhos = EpiItemDominio.lista_de_tamanhos({ tamanhos: catalogo?.tamanhos ?? null });
  if (tamanhos.length && !tamanho) {
    recusa("tamanho", `'${d.item.nome}' tem tamanhos no catálogo (${tamanhos.join(", ")}): escolha o tamanho deste lote`);
  } else if (tamanho && tamanhos.length && !tamanhos.includes(tamanho)) {
    recusa("tamanho", `'${tamanho}' não é um dos tamanhos de '${d.item.nome}' no catálogo: ${tamanhos.join(", ")}`);
  }
  // Lote repetido do mesmo item e tamanho: na reserva e na entrega apareciam
  // duas opções idênticas, impossíveis de distinguir. O mesmo número de lote
  // em OUTRO tamanho é legítimo (a caixa de P e a de M do mesmo lote de
  // fábrica), e em OUTRA nota fiscal também: é uma segunda compra, com empenho
  // e custo próprios — mandá-la para o ajuste de inventário apagaria essa
  // ligação. Só passa quando as DUAS entradas têm nota e as notas diferem; aí a
  // nota entra no rótulo do lote (`LoteDisponivel.rotulo`) e separa as opções.
  const lote = _ou_nada(d.lote);
  if (lote) {
    const nota = _ou_nada(d.nota_fiscal);
    const [repetido] = await tx
      .select({ id: epi_entrada_estoque.id })
      .from(epi_entrada_estoque)
      .where(
        and(
          eq(epi_entrada_estoque.epi_item_id, d.item.id),
          eq(epi_entrada_estoque.lote, lote),
          tamanho === null ? isNull(epi_entrada_estoque.tamanho) : eq(epi_entrada_estoque.tamanho, tamanho),
          nota === null
            ? undefined
            : or(isNull(epi_entrada_estoque.nota_fiscal), eq(epi_entrada_estoque.nota_fiscal, nota)),
        ),
      )
      .limit(1);
    if (repetido) {
      recusa(
        "lote",
        `o lote ${lote}${tamanho ? ` no tamanho ${tamanho}` : ""} já tem entrada para '${d.item.nome}'. ` +
          "Se chegou mais da mesma caixa, registre um ajuste de inventário nesse lote; " +
          "se é outra compra, informe a nota fiscal dela (diferente da primeira); se é outro lote, confira o número",
      );
    }
  }
  if (problemas.length) throw new EstoqueBloqueado(problemas, campo);

  const [entrada] = await tx
    .insert(epi_entrada_estoque)
    .values({
      epi_item_id: d.item.id,
      tamanho,
      pregao: _ou_nada(d.pregao),
      item_pregao: _ou_nada(d.item_pregao),
      empenho: _ou_nada(d.empenho),
      nota_fiscal: _ou_nada(d.nota_fiscal),
      oficio: _ou_nada(d.oficio),
      fornecedor_nome: _ou_nada(d.fornecedor_nome),
      // normalizado: o campo vem de nota fiscal impressa e chega pontuado
      fornecedor_cnpj: normalizar_cnpj(d.fornecedor_cnpj ?? ""),
      fornecedor_contato: _ou_nada(d.fornecedor_contato),
      data_entrada: quando,
      quantidade_empenhada,
      quantidade_recebida: d.quantidade_recebida,
      valor_unitario,
      lote: _ou_nada(d.lote),
      numero_ca: _ou_nada(d.numero_ca),
      validade_ca,
      data_fabricacao,
      observacao: limpo || null,
      registrado_por: usuario.id,
    })
    .returning();

  await _movimentar(tx, {
    entrada: entrada!,
    tipo: ENTRADA,
    quantidade: d.quantidade_recebida,
    usuario,
    motivo: `Entrada do lote ${entrada!.lote || "sem número"}` + (entrada!.empenho ? `, empenho ${entrada!.empenho}` : ""),
  });
  await auditoria.registrar(tx, {
    entidade: "epi_entrada_estoque",
    entidade_id: entrada!.id,
    tipo_evento: EPI_LOTE_REGISTRADO,
    descricao:
      `${d.quantidade_recebida} × ${d.item.nome} · lote ${entrada!.lote || "—"} · ` +
      `CA ${entrada!.numero_ca || "—"} · empenho ${entrada!.empenho || "—"} · ` +
      `${entrada!.fornecedor_nome || "fornecedor não informado"}`,
    campo: "entrada",
    // número é número e dinheiro é texto decimal (o `default=str` do Decimal)
    valor_novo: {
      quantidade_recebida: d.quantidade_recebida,
      quantidade_empenhada,
      valor_unitario,
      pregao: entrada!.pregao,
      item_pregao: entrada!.item_pregao,
      empenho: entrada!.empenho,
      nota_fiscal: entrada!.nota_fiscal,
      fornecedor: entrada!.fornecedor_nome,
      cnpj: entrada!.fornecedor_cnpj,
      lote: entrada!.lote,
      tamanho: entrada!.tamanho,
      numero_ca: entrada!.numero_ca,
      validade_ca,
      data_entrada: quando,
    },
    usuario,
  });
  return entrada!;
}

function _ou_nada(valor: string | null | undefined): string | null {
  return (valor || "").trim() || null;
}

/**
 * `12.345.678/0001-90` e `12345678000190` são o mesmo CNPJ. Vazio vira `null`.
 * Contagem errada é RECUSA ESCRITA, não corte silencioso (o `maxlength` cortava
 * no décimo quarto caractere sem avisar ninguém).
 *
 * O CNPJ alfanumérico da Receita (IN RFB 2.229/2024, emitido desde julho de
 * 2026) também entra: as 12 primeiras posições podem ser letras, os dois
 * dígitos verificadores continuam números. Letra minúscula vira maiúscula; a
 * pontuação é descartada como antes.
 */
export function normalizar_cnpj(bruto: string | null | undefined): string | null {
  const caracteres = (bruto || "").replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  if (!caracteres) return null;
  if (caracteres.length !== 14) {
    throw new EstoqueBloqueado([
      `CNPJ do fornecedor com ${caracteres.length} caractere(s): o CNPJ tem 14. ` +
        "Copie o número inteiro da nota — a pontuação pode vir junto, " +
        "ela é descartada na gravação",
    ]);
  }
  // Os dígitos verificadores: 14 dígitos quaisquer passavam, e
  // 11.111.111/1111-11 virava fornecedor de lote. A conta é a mesma do aviso
  // no navegador (`data-cnpj`, em `csso.js`), para os dois não discordarem.
  if (!cnpj_valido(caracteres)) {
    throw new EstoqueBloqueado([
      "CNPJ do fornecedor inválido: o dígito verificador não confere. " +
        "Confira o número na nota fiscal ou no cartão CNPJ",
    ]);
  }
  return caracteres;
}

/**
 * Módulo 11 da Receita, pesos 5..2 e 9..2 (e 6..2 e 9..2); todos iguais é
 * inválido. Cada posição vale o código ASCII menos 48 — o dígito vale ele
 * mesmo, e a letra do CNPJ alfanumérico vale A=17, B=18… —, que é a regra
 * única da Receita para os dois formatos.
 */
export function cnpj_valido(cnpj: string): boolean {
  if (!/^[0-9A-Z]{12}\d{2}$/.test(cnpj) || /^(.)\1{13}$/.test(cnpj)) return false;
  const dv = (base: string, pesos: number[]) => {
    const resto = [...base].reduce((soma, c, i) => soma + (c.charCodeAt(0) - 48) * pesos[i]!, 0) % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  const d1 = dv(cnpj.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = dv(cnpj.slice(0, 12) + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return cnpj.slice(12) === `${d1}${d2}`;
}

/** Os 14 caracteres guardados, de volta ao formato em que se conferem. */
export function formatar_cnpj(valor: string | null | undefined): string {
  const digitos = (valor || "").replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  if (digitos.length !== 14) return valor || "";
  return `${digitos.slice(0, 2)}.${digitos.slice(2, 5)}.${digitos.slice(5, 8)}/${digitos.slice(8, 12)}-${digitos.slice(12)}`;
}

filtro("cnpj", formatar_cnpj);

/**
 * `12.5` → `R$ 12,50`, com milhar: o dinheiro da tela. O `numeric` chega como
 * texto exato; arredonda a duas casas (meio para cima, como a nota fiscal).
 */
export function dinheiro(valor: string | number | null | undefined): string {
  if (valor === null || valor === undefined || valor === "") return "";
  const n = typeof valor === "number" ? valor : Number(valor);
  if (!Number.isFinite(n)) return String(valor);
  const [inteira, fracao] = Math.abs(n).toFixed(2).split(".") as [string, string];
  return `${n < 0 ? "-" : ""}R$ ${inteira.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${fracao}`;
}

filtro("dinheiro", dinheiro);

/** A recusa do valor unitário, numa grafia só (a rota marca o campo com ela). */
export const VALOR_INVALIDO = "Valor unitário inválido: use números, ex. 12,50.";

/**
 * Lê `12,50` e `12.50` como o mesmo número. Vazio vira `null` (≠ zero).
 * Devolve o texto decimal (o `str(Decimal)` do Python), que é o que o `numeric`
 * recebe e o que a trilha grava.
 */
export function valor_decimal(bruto: string | null | undefined): string | null {
  const limpo = (bruto || "").trim().replaceAll(".", "").replaceAll(",", ".");
  if (!limpo) return null;
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(limpo);
  if (!m || (!m[2] && !m[3])) {
    throw new EstoqueBloqueado([VALOR_INVALIDO], "valor_unitario");
  }
  // `Decimal('012.50')` -> '12.50'; `Decimal('.5')` -> '0.5'; `Decimal('5.')` -> '5'
  const inteira = (m[2] || "0").replace(/^0+(?=\d)/, "");
  const fracao = m[3] ?? "";
  return `${m[1] === "-" ? "-" : ""}${inteira}${fracao ? "." + fracao : ""}`;
}

/**
 * Edição do que é documento, nunca do que é quantidade. Lote não se exclui
 * (RN-31): inativa com motivo. Inativar solta TODA reserva do lote — reserva em
 * lote impedido é promessa que já se sabe que não vai ser cumprida.
 *
 * Como o `setattr` do Python, o objeto `entrada` recebido é atualizado também.
 */
export async function atualizar_lote(
  tx: Executor,
  usuario: UsuarioAtual,
  d: {
    entrada: EpiEntradaEstoque;
    nota_fiscal: string;
    oficio?: string;
    fornecedor_contato: string;
    observacao: string;
    ativo: boolean;
    motivo_inativacao: string;
    /** CA e validade do CA transcritos errados se corrigem (30/10/2026); `undefined` deixa como está */
    numero_ca?: string;
    validade_ca?: string;
  },
): Promise<void> {
  usuario.exigir("epi.estoque");
  const { entrada, ativo } = d;
  const limpa = textos.exigir_texto_limpo((d.observacao || "").trim(), "observação do lote");
  const motivo = textos.exigir_texto_limpo((d.motivo_inativacao || "").trim(), "motivo da inativação");
  if (!ativo && !motivo) {
    throw new EstoqueBloqueado([
      "inativar o lote exige o motivo: é ele que explica, para quem " +
        "olhar o saldo parado depois, por que aquelas unidades não saem",
    ]);
  }
  const numero_ca = d.numero_ca === undefined ? entrada.numero_ca : _ou_nada(d.numero_ca);
  const validade_ca = d.validade_ca === undefined ? entrada.validade_ca : d.validade_ca.trim() || null;
  if (validade_ca !== null && !/^\d{4}-\d{2}-\d{2}$/.test(validade_ca)) {
    throw new EstoqueBloqueado(["a validade do CA é uma data válida"], "validade_ca");
  }
  if (numero_ca !== null && numero_ca.length > 10) {
    throw new EstoqueBloqueado(["o número do CA tem no máximo 10 caracteres"], "numero_ca");
  }
  if (entrada.data_fabricacao && validade_ca !== null && entrada.data_fabricacao > validade_ca) {
    throw new EstoqueBloqueado(["a fabricação é posterior à validade do CA: confira as duas datas"], "validade_ca");
  }
  const [catalogo] = await tx.select({ exige_ca: epi_item.exige_ca }).from(epi_item).where(eq(epi_item.id, entrada.epi_item_id));
  if (catalogo?.exige_ca && numero_ca === null) {
    throw new EstoqueBloqueado(["este equipamento exige o número do CA no lote"], "numero_ca");
  }
  const campos = {
    nota_fiscal: _ou_nada(d.nota_fiscal),
    oficio: d.oficio === undefined ? entrada.oficio : _ou_nada(d.oficio),
    numero_ca,
    validade_ca,
    fornecedor_contato: _ou_nada(d.fornecedor_contato),
    observacao: limpa || null,
    ativo,
    motivo_inativacao: motivo || null,
  };
  const antes: Record<string, unknown> = {};
  for (const campo of Object.keys(campos) as (keyof typeof campos)[]) antes[campo] = entrada[campo];
  const inativou = Boolean(antes["ativo"]) && !ativo;
  await tx.update(epi_entrada_estoque).set(campos).where(eq(epi_entrada_estoque.id, entrada.id));
  Object.assign(entrada, campos);
  await auditoria.registrar_diferencas(tx, {
    entidade: "epi_entrada_estoque",
    entidade_id: entrada.id,
    antes,
    depois: { ...campos },
    usuario,
    tipo_evento: EPI_LOTE_ALTERADO,
  });
  await sincronizar_pendencia_de_ca(tx, entrada, usuario);
  if (inativou) {
    await epi_requisicao.soltar_reservas_do_lote(tx, usuario, entrada, {
      motivo: `o lote ${entrada.lote || "—"} foi inativado: ${motivo}`,
      tudo: true,
    });
  }
}

// =====================================================================
// RN-25 — a pendência do CA a vencer
// =====================================================================
export function chave_da_pendencia_de_ca(entrada_id: number): string {
  return `ca:entrada:${entrada_id}`;
}

/**
 * Abre a pendência do CA a vencer, ou a fecha quando ela perdeu o objeto.
 * Disparada por MOVIMENTO, não por relógio: o sistema não tem agendador. Um lote
 * parado atravessa a janela dos 60 dias sem abrir pendência (a tela o etiqueta
 * mesmo assim, porque calcula o estado na hora).
 */
export async function sincronizar_pendencia_de_ca(
  tx: Executor,
  entrada: EpiEntradaEstoque,
  usuario: UsuarioAtual | null = null,
): Promise<void> {
  if (entrada.validade_ca === null) return;
  const chave = chave_da_pendencia_de_ca(entrada.id);
  const saldo = await saldo_fisico(tx, entrada.id);
  const hoje = datas_br.hoje();
  const na_janela = entrada.validade_ca <= datas_br.somar_dias(hoje, DIAS_AVISO_CA);

  if (saldo <= 0 || !entrada.ativo || !na_janela) {
    await _fechar_pendencia_de_ca(tx, chave, usuario);
    return;
  }
  const vencido = entrada.validade_ca < hoje;
  await pendencias.abrir(tx, {
    tipo: TIPO_PENDENCIA_CA,
    chave,
    // sem o saldo do momento: `abrir` não reescreve o texto, e o número envelheceria
    descricao:
      `O CA ${entrada.numero_ca || "—"} do lote ${entrada.lote || "—"} de ` +
      `${await _nome_do_item(tx, entrada)} ` +
      (vencido ? "VENCEU em " : "vence em ") +
      `${datas_br.numerica(entrada.validade_ca)} e o lote ainda tem ` +
      "saldo em estoque. Pela NR-6 o equipamento deixa de ser EPI: renove " +
      "o CA junto ao fabricante ou registre o descarte com motivo.",
    entidade: "epi_entrada_estoque",
    entidade_id: entrada.id,
    // o prazo é a validade do CA: depois dela o lote já não pode sair
    prazo: entrada.validade_ca,
    usuario,
  });
}

async function _fechar_pendencia_de_ca(tx: Executor, chave: string, usuario: UsuarioAtual | null): Promise<void> {
  const [pendencia] = await tx.select().from(tabela_pendencia).where(eq(tabela_pendencia.chave, chave));
  if (!pendencia || pendencia.concluida) return;
  if (usuario === null) {
    // sem usuário é a varredura: fecha em nome da rotina, não de uma pessoa
    await pendencias.concluir_pela_rotina(tx, pendencia, "o lote saiu da janela do CA, zerou ou foi inativado");
    return;
  }
  await pendencias.concluir(tx, pendencia, usuario);
}
