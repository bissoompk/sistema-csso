/**
 * Os números do módulo de EPI: o painel de `/epis` e os indicadores da §9.
 * Porte de `app/servicos/epi_indicadores.py`.
 *
 * Fatia 7 do desenho (`entrada/integrasst/desenho_epi.md`). Aqui não nasce fato
 * nenhum: tudo o que este arquivo faz é **ler** o que as fatias 1 a 6 gravaram e
 * somar. Por isso não há `usuario.exigir` em função nenhuma — a permissão é da
 * rota, que é quem sabe se a tela é `epi.ver` (o painel) ou `indicador.ver` (o
 * relatório).
 *
 * Duas decisões governam o arquivo inteiro, e as duas são sobre reidentificação:
 *
 * 1. **A célula conta SERVIDORES DISTINTOS, nunca unidades entregues.** É a
 *    diferença entre um indicador e um dossiê. "12 pares de luva na Odontologia"
 *    passa por qualquer limiar e pode ser uma pessoa só. O limiar de cinco da
 *    RN-19 é sobre **gente**, então a contagem tem de ser sobre gente. A
 *    quantidade entregue continua na tela, mas atrelada à célula: onde a célula
 *    é suprimida, ela some junto.
 * 2. **Campus e unidade saem da MESMA leitura** — a lotação na data da entrega,
 *    a mesma fonte de que o snapshot nasceu (`epi_ficha._posto_e_unidade`) —, e
 *    é isso que faz o total do campus ser de fato a soma das unidades dele.
 *
 * **Dinheiro sem ponto flutuante.** No Python o custo por empenho é `Decimal`
 * exato. Aqui o `numeric(12,4)` chega do driver como texto e a soma é feita em
 * `bigint` na escala de 10⁻⁴ — `valor × quantidade` com quantidade inteira não
 * perde casa nenhuma nessa escala. O texto com duas casas sai com o mesmo
 * arredondamento do `f"{Decimal:.2f}"` do Python (meio-para-o-par).
 */
import { and, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  campus as tabela_campus,
  epi_entrada_estoque,
  epi_ficha_registro,
  epi_item,
  epi_requisicao as tabela_requisicao,
  historico_evento,
  servidor as tabela_servidor,
  unidade_uorg,
} from "../db/esquema/index.js";
import { EPI_REQUISICAO_ENCERRADA } from "../dominio/estados.js";
import { EpiRequisicao as RequisicaoDominio, EpiRequisicaoItem as ItemDominio } from "../dominio/epi.js";
import * as datas_br from "./datas_br.js";
import { hoje } from "./datas_br.js";
import * as epi_estoque from "./epi_estoque.js";
import * as epi_ficha from "./epi_ficha.js";
import * as epi_requisicao from "./epi_requisicao.js";
import * as servidores from "./servidores.js";

export type EpiFichaRegistro = typeof epi_ficha_registro.$inferSelect;
export type EpiEntradaEstoque = typeof epi_entrada_estoque.$inferSelect;
type EpiItem = typeof epi_item.$inferSelect;

export const SEM_UNIDADE = "(sem unidade)";
export const SEM_CAMPUS = "(sem campus)";
export const SEM_EMPENHO = "(sem empenho)";

// Os dois eventos que registram uma negativa de EPI, e é preciso somar os dois.
// `EPI_ITEM_RECUSADO` é a recusa de item de requisição (fatia 4);
// `EPI_ENTREGA_RECUSADA` é a recusa de balcão (fatia 2), que existe justamente
// para o caso da decisão 3 — pedido de terceirizado, que não vira requisição.
// Contar só o primeiro deixaria de fora exatamente a recusa que a RN-27 quer
// contável. (Os literais, e não `epi_requisicao.EPI_ITEM_RECUSADO`: a
// constante do outro módulo seria lida no carregamento, e a ordem de avaliação
// de um ciclo de importação ESM não garante que ela já exista.)
export const EVENTOS_DE_RECUSA: readonly string[] = ["EPI_ITEM_RECUSADO", "EPI_ENTREGA_RECUSADA"];

/** `(fim - inicio).days` sobre 'AAAA-MM-DD', sem passar por fuso (RN-18). */
function dias_entre_datas(inicio: string, fim: string): number {
  const dia = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return Math.round((dia(fim) - dia(inicio)) / 86_400_000);
}

// =====================================================================
// O painel de `/epis`
// =====================================================================
export class LoteAVencer {
  constructor(
    readonly entrada: EpiEntradaEstoque & { item: EpiItem },
    readonly saldo: number,
    readonly dias: number,
  ) {
    Object.freeze(this);
  }
  get vencido(): boolean {
    return this.dias < 0;
  }
}

/** A linha de `itens_esperando_estoque`, com o que a tela lê dela. */
export type LinhaEsperando = Record<string, any> & {
  id: number;
  requisicao_id: number;
  requisicao: Record<string, any> & { identificacao: string };
  item: EpiItem;
  quantidade_devida: number;
};

/** As cinco medidas que o §9 pede, calculadas agora e nunca gravadas. */
export class Painel {
  constructor(
    readonly quando: string,
    readonly requisicoes_por_estado: Record<string, number>,
    readonly esperando_estoque: LinhaEsperando[],
    readonly lotes_a_vencer: LoteAVencer[],
    readonly entregas_do_mes: EpiFichaRegistro[],
    readonly trocas_devidas: EpiFichaRegistro[],
  ) {
    Object.freeze(this);
  }

  /**
   * O que ainda dá trabalho: fora do rascunho e dos três terminais. A lista
   * dos terminais vem de `EPI_REQUISICAO_ENCERRADA`, e não repetida aqui.
   * Rascunho sai porque ainda é do requerente e não protocolou nada.
   */
  get requisicoes_abertas(): number {
    let total = 0;
    for (const [estado, n] of Object.entries(this.requisicoes_por_estado)) {
      if (estado !== "RASCUNHO" && !EPI_REQUISICAO_ENCERRADA.has(estado)) total += n;
    }
    return total;
  }

  get lotes_vencidos(): number {
    return this.lotes_a_vencer.filter((lote) => lote.vencido).length;
  }

  /** `p.requisicoes_por_estado.values()|sum` do template Jinja. */
  get total_por_estado(): number {
    return Object.values(this.requisicoes_por_estado).reduce((a, b) => a + b, 0);
  }
}

/**
 * As cinco medidas de `/epis`, cada uma da fonte que já a produzia. Nenhuma é
 * recontada aqui: um segundo cálculo seria um segundo número — e o painel
 * existe para ser conferido contra as telas, não para discordar delas.
 */
export async function painel(tx: Executor, quando: string | null = null): Promise<Painel> {
  const dia = quando ?? hoje();
  return new Painel(
    dia,
    await epi_requisicao.resumo_de_estados(tx),
    await _com_o_que_a_tela_le(tx, await epi_requisicao.itens_esperando_estoque(tx)),
    await lotes_a_vencer(tx, dia),
    await entregas_do_mes(tx, dia),
    await epi_ficha.trocas_devidas(tx, { quando: dia }),
  );
}

/**
 * A fila de falta com a requisição e o item carregados — o `lazy="selectin"`
 * do SQLAlchemy, feito aqui porque o Nunjucks não consulta o banco. As duas
 * `@property` do Python (`identificacao`, `quantidade_devida`) viram campo.
 */
async function _com_o_que_a_tela_le(tx: Executor, linhas: readonly any[]): Promise<LinhaEsperando[]> {
  if (!linhas.length) return [];
  const ids_req = [...new Set(linhas.map((l) => l.requisicao_id as number))];
  const ids_item = [...new Set(linhas.map((l) => l.epi_item_id as number))];
  const reqs = new Map(
    (await tx.select().from(tabela_requisicao).where(inArray(tabela_requisicao.id, ids_req))).map((r) => [r.id, r]),
  );
  const itens = new Map(
    (await tx.select().from(epi_item).where(inArray(epi_item.id, ids_item))).map((i) => [i.id, i]),
  );
  return linhas.map((l) => {
    const req = reqs.get(l.requisicao_id)!;
    return {
      ...l,
      requisicao: { ...req, identificacao: RequisicaoDominio.identificacao(req) },
      item: itens.get(l.epi_item_id)!,
      quantidade_devida: ItemDominio.quantidade_devida(l),
    };
  });
}

/**
 * Lotes ativos, com saldo, cujo CA vence dentro da janela da RN-25. O vencido
 * entra junto, e no topo: ele continua sendo patrimônio que alguém tem de
 * descartar ou renovar.
 */
export async function lotes_a_vencer(tx: Executor, quando: string | null = null): Promise<LoteAVencer[]> {
  const dia = quando ?? hoje();
  const saldos = await epi_estoque.saldos_de_todos(tx);
  const limite = datas_br.somar_dias(dia, epi_estoque.DIAS_AVISO_CA);
  const entradas = await tx.query.epi_entrada_estoque.findMany({
    where: and(eq(epi_entrada_estoque.ativo, true), isNotNull(epi_entrada_estoque.validade_ca)),
    with: { item: true },
  });
  const linhas: LoteAVencer[] = [];
  for (const entrada of entradas) {
    if (entrada.validade_ca! > limite) continue;
    const saldo = saldos.get(entrada.id) ?? 0;
    if (saldo <= 0) continue;
    linhas.push(new LoteAVencer(entrada as EpiEntradaEstoque & { item: EpiItem }, saldo, dias_entre_datas(dia, entrada.validade_ca!)));
  }
  return linhas.sort((a, b) => a.dias - b.dias || a.entrada.id - b.entrada.id);
}

/**
 * As entregas do mês corrente, sem as estornadas: o estorno declara que aquela
 * entrega não aconteceu — contá-la mediria digitação, e não entrega.
 */
export async function entregas_do_mes(tx: Executor, quando: string | null = null): Promise<EpiFichaRegistro[]> {
  const dia = quando ?? hoje();
  return _entregas_validas(tx, `${dia.slice(0, 8)}01`, dia);
}

async function _entregas_validas(tx: Executor, inicio: string, fim: string): Promise<EpiFichaRegistro[]> {
  const registros = await tx
    .select()
    .from(epi_ficha_registro)
    .where(and(gte(epi_ficha_registro.data_evento, inicio), lte(epi_ficha_registro.data_evento, fim)));
  // os estornos podem estar fora da janela e ainda assim anular uma entrega
  // dentro dela: por isso a lista de estornados vem da tabela inteira
  const estornados = new Set(
    (
      await tx
        .select({ id: epi_ficha_registro.registro_estornado_id })
        .from(epi_ficha_registro)
        .where(and(eq(epi_ficha_registro.tipo, "ESTORNO"), isNotNull(epi_ficha_registro.registro_estornado_id)))
    ).map((r) => r.id),
  );
  return registros.filter((r) => r.tipo === "ENTREGA" && !estornados.has(r.id));
}

// =====================================================================
// `/epis/relatorios` — as células, já como células
// =====================================================================
/**
 * Uma dimensão do relatório: quem foi atendido, e quanto saiu. `servidores` é o
 * que a RN-19 mede e o que a supressão protege; `quantidade` só pode aparecer
 * onde a célula de servidores sobreviveu.
 */
export interface Celulas {
  servidores: Record<string, number>;
  quantidade: Record<string, number>;
}

/** Soma exata de dinheiro: bigint na escala de 10⁻⁴ (a do `numeric(12,4)`). */
const ESCALA = 10_000n;

function _para_escala(texto: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d{0,4})\d*)?$/.exec(texto.trim());
  if (!m) throw new Error(`valor decimal inválido: ${texto}`);
  const inteiro = BigInt(m[2]!) * ESCALA + BigInt((m[3] ?? "").padEnd(4, "0") || "0");
  return m[1] ? -inteiro : inteiro;
}

function _texto_da_escala(v: bigint, casas: number): string {
  // meio-para-o-par, como o `format(Decimal, '.Nf')` do Python
  const negativo = v < 0n;
  let a = negativo ? -v : v;
  const corte = 10n ** BigInt(4 - casas);
  let q = a / corte;
  const r = a % corte;
  if (r * 2n > corte || (r * 2n === corte && q % 2n === 1n)) q += 1n;
  a = q;
  const base = 10n ** BigInt(casas);
  const inteira = (a / base).toString();
  const frac = casas ? "." + (a % base).toString().padStart(casas, "0") : "";
  return `${negativo && a !== 0n ? "-" : ""}${inteira}${frac}`;
}

export class LinhaEmpenho {
  constructor(
    readonly empenho: string,
    readonly lotes: number,
    readonly recebido: number,
    /** texto com 4 casas (o `Decimal` do Python), ou `null` quando nenhum lote tem valor */
    readonly custo: string | null,
    readonly sem_valor: number,
  ) {
    Object.freeze(this);
  }
  /**
   * Há lote sem valor unitário — o custo é piso, não total. Zero seria mentira
   * barata: "não sei quanto custou" e "custou nada" são coisas diferentes.
   */
  get incompleto(): boolean {
    return this.sem_valor > 0;
  }
  /** `f"{custo:.2f}"` — o que a tela e o CSV imprimem. */
  get custo_texto(): string | null {
    return this.custo === null ? null : _texto_da_escala(_para_escala(this.custo), 2);
  }
}

export interface Relatorio {
  inicio: string;
  fim: string;
  por_categoria: Celulas;
  /**
   * `{campus: {unidade: servidores}}` — a hierarquia inteira, porque o total do
   * campus é a MARGEM das unidades dele e as duas têm de ser suprimidas juntas.
   */
  por_campus: Record<string, Record<string, number>>;
  empenhos: LinhaEmpenho[];
  recusas_por_motivo: Record<string, number>;
  recusas_por_unidade: Record<string, number>;
  total_recusas: number;
}

/** `sorted(d.items())` do Python, de volta a dicionário (a ordem de inserção é a da chave). */
function _ordenado<T>(d: Map<string, T> | Record<string, T>): Record<string, T> {
  const pares = d instanceof Map ? [...d.entries()] : Object.entries(d);
  pares.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(pares);
}

/**
 * Tudo o que `/epis/relatorios` mostra, numa leitura só. A janela é o exercício
 * corrente por padrão: indicador sem recorte de tempo envelhece para cima.
 */
export async function relatorio(
  tx: Executor,
  opcoes: { inicio?: string | null; fim?: string | null } = {},
): Promise<Relatorio> {
  const fim = opcoes.fim ?? hoje();
  const inicio = opcoes.inicio ?? `${fim.slice(0, 4)}-01-01`;

  const entregas = await _entregas_validas(tx, inicio, fim);
  const por_categoria = _celulas(entregas, (r) => r.categoria_snapshot || "(sem categoria)");

  const onde = await _lotacoes(tx, entregas);
  const por_campus = new Map<string, Map<string, Set<number>>>();
  for (const registro of entregas) {
    const [campus, unidade] = onde.get(registro.id)!;
    if (!por_campus.has(campus)) por_campus.set(campus, new Map());
    const unidades = por_campus.get(campus)!;
    if (!unidades.has(unidade)) unidades.set(unidade, new Set());
    unidades.get(unidade)!.add(registro.servidor_id);
  }

  const [recusas_motivo, recusas_unidade, total] = await _recusas(tx, inicio, fim);
  const campus_ordenado: Record<string, Record<string, number>> = {};
  for (const [campus, unidades] of Object.entries(_ordenado(por_campus))) {
    const contagem = new Map<string, number>();
    for (const [unidade, pessoas] of unidades) contagem.set(unidade, pessoas.size);
    campus_ordenado[campus] = _ordenado(contagem);
  }
  return {
    inicio,
    fim,
    por_categoria,
    por_campus: campus_ordenado,
    empenhos: await custo_por_empenho(tx, inicio, fim),
    recusas_por_motivo: recusas_motivo,
    recusas_por_unidade: recusas_unidade,
    total_recusas: total,
  };
}

function _celulas(entregas: EpiFichaRegistro[], chave: (r: EpiFichaRegistro) => string): Celulas {
  const pessoas = new Map<string, Set<number>>();
  const quantidade = new Map<string, number>();
  for (const registro of entregas) {
    const rotulo = chave(registro);
    if (!pessoas.has(rotulo)) pessoas.set(rotulo, new Set());
    pessoas.get(rotulo)!.add(registro.servidor_id);
    quantidade.set(rotulo, (quantidade.get(rotulo) ?? 0) + registro.quantidade);
  }
  const contagem = new Map<string, number>();
  for (const [k, v] of pessoas) contagem.set(k, v.size);
  return { servidores: _ordenado(contagem), quantidade: _ordenado(quantidade) };
}

/**
 * `{registro_id: [campus, unidade]}` — os dois da mesma leitura. A lotação é
 * consultada uma vez por par (servidor, data): a mesma pessoa costuma ter
 * várias entregas no mesmo dia.
 */
async function _lotacoes(tx: Executor, entregas: EpiFichaRegistro[]): Promise<Map<number, [string, string]>> {
  const cache = new Map<string, [string, string]>();
  const campi = new Map<number, string>();
  const saida = new Map<number, [string, string]>();
  const sigla_do_campus = async (campus_id: number | null): Promise<string | null> => {
    if (campus_id === null) return null;
    if (!campi.has(campus_id)) {
      const [c] = await tx.select().from(tabela_campus).where(eq(tabela_campus.id, campus_id));
      campi.set(campus_id, c ? c.sigla : "");
    }
    return campi.get(campus_id) || null;
  };
  for (const registro of entregas) {
    const chave = `${registro.servidor_id}|${registro.data_evento}`;
    if (!cache.has(chave)) {
      const lotacao = await servidores.lotacao_em(tx, registro.servidor_id, registro.data_evento);
      let unidade: { nome_extenso: string; campus_id: number | null } | null = lotacao?.unidade ?? null;
      if (unidade === null) {
        const [servidor] = await tx
          .select()
          .from(tabela_servidor)
          .where(eq(tabela_servidor.id, registro.servidor_id));
        if (servidor?.unidade_uorg_id != null) {
          const [u] = await tx.select().from(unidade_uorg).where(eq(unidade_uorg.id, servidor.unidade_uorg_id));
          unidade = u ?? null;
        }
      }
      const sigla = unidade ? await sigla_do_campus(unidade.campus_id) : null;
      cache.set(chave, [sigla ?? SEM_CAMPUS, unidade ? unidade.nome_extenso : SEM_UNIDADE]);
    }
    saida.set(registro.id, cache.get(chave)!);
  }
  return saida;
}

/**
 * O que cada empenho comprou, pela data de ENTRADA do lote. Não passa por
 * supressão, e é deliberado: empenho é execução orçamentária, público pela Lei
 * 12.527, e não nomeia servidor nenhum.
 */
export async function custo_por_empenho(tx: Executor, inicio: string, fim: string): Promise<LinhaEmpenho[]> {
  const agregado = new Map<string, [number, number, bigint, number]>();
  const entradas = await tx
    .select()
    .from(epi_entrada_estoque)
    .where(and(gte(epi_entrada_estoque.data_entrada, inicio), lte(epi_entrada_estoque.data_entrada, fim)));
  for (const entrada of entradas) {
    const chave = entrada.empenho || SEM_EMPENHO;
    if (!agregado.has(chave)) agregado.set(chave, [0, 0, 0n, 0]);
    const atual = agregado.get(chave)!;
    atual[0] += 1;
    atual[1] += entrada.quantidade_recebida;
    if (entrada.valor_unitario === null) atual[3] += 1;
    else atual[2] += _para_escala(entrada.valor_unitario) * BigInt(entrada.quantidade_recebida);
  }
  return Object.entries(_ordenado(agregado)).map(
    ([empenho, [lotes, recebido, custo, sem_valor]]) =>
      new LinhaEmpenho(empenho, lotes, recebido, lotes > sem_valor ? _texto_da_escala(custo, 4) : null, sem_valor),
  );
}

/**
 * RN-27: a contagem por motivo e por unidade sai da própria trilha — o código
 * do motivo vai em `valor_novo` para a contagem não depender de casar texto, e
 * a recusa de balcão não tem linha de requisição nenhuma. A célula conta
 * **recusas**, e não servidores: é a decisão que se conta.
 */
async function _recusas(
  tx: Executor,
  inicio: string,
  fim: string,
): Promise<[Record<string, number>, Record<string, number>, number]> {
  const por_motivo = new Map<string, number>();
  const por_unidade = new Map<string, number>();
  let total = 0;
  const eventos = await tx
    .select({ ocorrido_em: historico_evento.ocorrido_em, valor_novo: historico_evento.valor_novo })
    .from(historico_evento)
    .where(inArray(historico_evento.tipo_evento, [...EVENTOS_DE_RECUSA]));
  for (const evento of eventos) {
    // a data da recusa é a LOCAL, não a UTC gravada: uma negativa das 22h de
    // 31 de dezembro cairia no exercício seguinte
    const quando = datas_br.data_local(evento.ocorrido_em);
    if (quando === null || quando < inicio || quando > fim) continue;
    const bruto = evento.valor_novo;
    const valor =
      bruto && typeof bruto === "object" && !Array.isArray(bruto) ? (bruto as Record<string, unknown>) : {};
    const motivo = String(valor["rotulo"] || valor["motivo"] || "(sem motivo)");
    const unidade = String(valor["unidade"] || SEM_UNIDADE);
    por_motivo.set(motivo, (por_motivo.get(motivo) ?? 0) + 1);
    por_unidade.set(unidade, (por_unidade.get(unidade) ?? 0) + 1);
    total += 1;
  }
  return [_ordenado(por_motivo), _ordenado(por_unidade), total];
}
