/**
 * Fatia G (paridade com o IntegraSST, `L:Core.js:656-686`): as contagens do que
 * espera a equipe de EPI — pedidos a analisar e comunicações do titular a tratar.
 *
 * Vão para o painel `/epis` e para o Início. NÃO vão para o menu: a contagem no
 * menu foi recusada (DESVIOS, "Menu de Certificados e Treinamentos em grupos",
 * 22/10/2026) — o menu é navegação, e número nele é consulta em toda tela.
 *
 * Só números, sem nome de ninguém (RN-19): quem quiser saber de quem é o pedido
 * abre a fila, que aplica a regra de identificação dela.
 */
import { and, count, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  epi_comunicacao_titular,
  epi_requisicao,
  servidor as tabela_servidor,
  unidade_uorg,
} from "../db/esquema/index.js";
import type { UsuarioAtual } from "./rbac.js";
import { _no_escopo } from "./epi_requisicao.js";
import { contar_abertas } from "./epi_comunicacao.js";

/** Os estados em que o pedido espera decisão de quem analisa. */
export const ESTADOS_A_ANALISAR = ["ENVIADA", "EM_ANALISE"] as const;

export interface PedidosAAnalisar {
  /** Chegaram e ninguém abriu a análise. */
  enviadas: number;
  /** A análise começou e não terminou. */
  em_analise: number;
  total: number;
}

/**
 * A mesma conta que a fila de `/epis/requisicoes` faz (escopo de `epi.ver`,
 * `_no_escopo`), recortada nos dois estados: o número que o cartão publica é o
 * que o link dele mostra. Quem já tem `resumo_de_estados` na mão (o painel
 * `/epis`) passa `opcoes.resumo` a `contagens` e não repete a consulta.
 */
export async function pedidos_a_analisar(tx: Executor, usuario: UsuarioAtual): Promise<PedidosAAnalisar> {
  const linhas = await tx
    .select({ estado: epi_requisicao.estado, quantas: count(epi_requisicao.id) })
    .from(epi_requisicao)
    .where(and(inArray(epi_requisicao.estado, [...ESTADOS_A_ANALISAR]), _no_escopo(usuario)))
    .groupBy(epi_requisicao.estado);
  const resumo: Record<string, number> = {};
  for (const { estado, quantas } of linhas) resumo[estado] = Number(quantas);
  return de_resumo(resumo);
}

/** `{estado: quantas}` (o de `resumo_de_estados`) → os pedidos a analisar. */
export function de_resumo(resumo: Record<string, number>): PedidosAAnalisar {
  const enviadas = resumo.ENVIADA ?? 0;
  const em_analise = resumo.EM_ANALISE ?? 0;
  return { enviadas, em_analise, total: enviadas + em_analise };
}

/** O endereço da fila já filtrada: os que nem começaram primeiro. */
export function link_da_fila(p: PedidosAAnalisar): string {
  return `/epis/requisicoes?estado=${p.enviadas || !p.em_analise ? "ENVIADA" : "EM_ANALISE"}`;
}

export interface ContagensEpi {
  /** `null`: a conta não tem `epi.analisar` — o cartão não aparece. */
  a_analisar: (PedidosAAnalisar & { link: string }) | null;
  /** `null`: a conta não tem `epi.entregar` — o cartão não aparece. */
  comunicacoes: { total: number; link: string } | null;
}

/** Para onde leva o número de comunicações: a lista de fichas tem o aviso. */
export function link_das_comunicacoes(usuario: UsuarioAtual): string {
  return usuario.pode("epi.ficha") ? "/epis/fichas" : "/pendencias";
}

/**
 * As duas contagens, cada uma só para quem tem a permissão do ato (sem ela,
 * nenhuma consulta). Consultas em paralelo: o Início é medido em idas ao banco.
 */
export async function contagens(
  tx: Executor,
  usuario: UsuarioAtual,
  opcoes: { resumo?: Record<string, number> | Promise<Record<string, number>> } = {},
): Promise<ContagensEpi> {
  const analisa = usuario.pode("epi.analisar");
  const entrega = usuario.pode("epi.entregar");
  const [pedidos, abertas] = await Promise.all([
    analisa
      ? opcoes.resumo
        ? Promise.resolve(opcoes.resumo).then(de_resumo)
        : pedidos_a_analisar(tx, usuario)
      : null,
    entrega ? contar_abertas(tx, usuario) : null,
  ]);
  return {
    a_analisar: pedidos ? { ...pedidos, link: link_da_fila(pedidos) } : null,
    comunicacoes: abertas === null ? null : { total: abertas, link: link_das_comunicacoes(usuario) },
  };
}

// =====================================================================
// O Início: as duas contagens numa ida ao banco
// =====================================================================
/**
 * A mesma conta de `contar_abertas` (`epi_comunicacao.ts`), mas em SQL e como
 * subconsulta: o Início é medido em idas ao banco (`testes/idas_ao_banco`, teto
 * de 30, e ele já fazia 28), e as duas contagens precisam caber numa. A regra é
 * a de lá — alcance de EQUIPE de `epi.entregar`; total ou unidade sem campus
 * contam tudo; com campus, a lotação de hoje do servidor, e sem lotação
 * conhecida a permissão basta —, e o teste da fatia G confere que os dois
 * números são o mesmo.
 */
function _comunicacoes_abertas(tx: Executor, usuario: UsuarioAtual) {
  const alcance = usuario.alcance_da_equipe("epi.entregar");
  if (!alcance.total && !alcance.unidade && !alcance.campi.length) return null;
  const no_campus: SQL | undefined =
    alcance.total || alcance.unidade
      ? undefined
      : or(isNull(unidade_uorg.campus_id), inArray(unidade_uorg.campus_id, [...alcance.campi]));
  return tx
    .select({ n: sql<number>`count(${epi_comunicacao_titular.id})`.as("n") })
    .from(epi_comunicacao_titular)
    .innerJoin(tabela_servidor, eq(tabela_servidor.id, epi_comunicacao_titular.servidor_id))
    .leftJoin(unidade_uorg, eq(unidade_uorg.id, tabela_servidor.unidade_uorg_id))
    .where(and(isNull(epi_comunicacao_titular.retirada_em), isNull(epi_comunicacao_titular.tratada_em), no_campus));
}

function _pedidos(tx: Executor, usuario: UsuarioAtual) {
  return tx
    .select({
      enviadas: sql<number>`count(*) filter (where ${epi_requisicao.estado} = 'ENVIADA')`.as("enviadas"),
      em_analise: sql<number>`count(*) filter (where ${epi_requisicao.estado} = 'EM_ANALISE')`.as("em_analise"),
    })
    .from(epi_requisicao)
    .where(and(inArray(epi_requisicao.estado, [...ESTADOS_A_ANALISAR]), _no_escopo(usuario)));
}

/**
 * `contagens` numa consulta só (ou nenhuma, sem as permissões). Para o Início;
 * o painel `/epis` usa `contagens`, que reaproveita o resumo que ele já tem.
 */
export async function contagens_numa_ida(tx: Executor, usuario: UsuarioAtual): Promise<ContagensEpi> {
  const pedidos = usuario.pode("epi.analisar") ? _pedidos(tx, usuario) : null;
  const abertas = usuario.pode("epi.entregar") ? _comunicacoes_abertas(tx, usuario) : null;
  // `epi.entregar` sem alcance de equipe (só a do titular): zero, como lá
  const com_entregar = usuario.pode("epi.entregar");
  if (!pedidos && !abertas) {
    return { a_analisar: null, comunicacoes: com_entregar ? { total: 0, link: link_das_comunicacoes(usuario) } : null };
  }
  const colunas: SQL[] = [];
  if (pedidos) colunas.push(sql`p.enviadas, p.em_analise`);
  if (abertas) colunas.push(sql`c.n AS comunicacoes`);
  const fontes: SQL[] = [];
  if (pedidos) fontes.push(sql`(${pedidos}) p`);
  if (abertas) fontes.push(sql`(${abertas}) c`);
  const linhas = (await tx.execute(
    sql`SELECT ${sql.join(colunas, sql`, `)} FROM ${sql.join(fontes, sql` CROSS JOIN `)}`,
  )) as unknown as { enviadas?: unknown; em_analise?: unknown; comunicacoes?: unknown }[];
  const linha = linhas[0] ?? {};
  const a_analisar = pedidos ? de_resumo({ ENVIADA: Number(linha.enviadas ?? 0), EM_ANALISE: Number(linha.em_analise ?? 0) }) : null;
  return {
    a_analisar: a_analisar ? { ...a_analisar, link: link_da_fila(a_analisar) } : null,
    comunicacoes: com_entregar
      ? { total: abertas ? Number(linha.comunicacoes ?? 0) : 0, link: link_das_comunicacoes(usuario) }
      : null,
  };
}
