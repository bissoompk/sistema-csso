/**
 * Serviço do processo: transições de estado, kanban e SLA.
 * Porte de `app/servicos/processo.py`.
 *
 * No Python o serviço mexia no objeto do ORM e o `flush` gravava. Aqui o
 * processo é uma linha simples: `mover` grava com UPDATE e atualiza o mesmo
 * objeto em memória, para quem chamou continuar lendo o estado novo (o que o
 * objeto do SQLAlchemy fazia sozinho).
 */
import { and, count, eq, sql } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  anexo,
  checklist,
  checklist_item,
  fluxo_etapa,
  laudo_tecnico,
  parametro,
  processo as tabela_processo,
} from "../db/esquema/index.js";
import { agora_utc } from "../db/esquema/base.js";
import { ChecklistModelo } from "../dominio/dominios.js";
import {
  ATALHO_REUSO_LAUDO,
  INCISOS_ART11,
  ROTULO_ESTADO,
  ROTULO_ESTADO_TELA,
  TransicaoInvalida,
  coluna_de,
  exigir_transicao,
} from "../dominio/estados.js";
import { RegraViolada } from "../nucleo/erros.js";
import * as auditoria from "./auditoria.js";
import * as datas_br from "./datas_br.js";
import type { UsuarioAtual } from "./rbac.js";

export type Processo = typeof tabela_processo.$inferSelect;
type ChecklistModeloLinha = { id: number; nome: string; itens: string };

// RN-16 - SLA por coluna (dias). O padrão abaixo vale enquanto ninguém editar
// em /config; a partir daí, quem manda é a tabela `parametro`.
export const SLA_PADRAO: Readonly<Record<string, number>> = Object.freeze({
  NAO_INICIADO: 0,
  A_FAZER: 15,
  EM_ANDAMENTO: 30,
  AGUARDANDO: 20,
  CONCLUIDO: 0,
});

export const PREFIXO_SLA = "sla.";

/** `int(valor)` do Python: aceita espaços e sinal, recusa o resto. */
function inteiro_python(valor: unknown): number | null {
  const texto = String(valor ?? "").trim();
  return /^[+-]?\d+$/.test(texto) ? Number(texto) : null;
}

/** Lê os parâmetros e cai no padrão para o que não estiver configurado. */
export async function sla_vigente(tx: Executor): Promise<Record<string, number>> {
  const tabela: Record<string, number> = { ...SLA_PADRAO };
  for (const p of await tx.select().from(parametro)) {
    if (!p.chave.startsWith(PREFIXO_SLA)) continue;
    const coluna = p.chave.slice(PREFIXO_SLA.length);
    if (Object.hasOwn(tabela, coluna)) {
      const n = inteiro_python(p.valor);
      if (n === null) continue;
      tabela[coluna] = Math.max(0, n);
    }
  }
  return tabela;
}

export async function gravar_sla(
  tx: Executor,
  valores: Record<string, number>,
  usuario: UsuarioAtual,
): Promise<Record<string, number>> {
  usuario.exigir("catalogo.gerenciar");
  for (const [coluna, dias] of Object.entries(valores)) {
    if (!Object.hasOwn(SLA_PADRAO, coluna)) continue;
    const chave = `${PREFIXO_SLA}${coluna}`;
    const [existente] = await tx.select().from(parametro).where(eq(parametro.chave, chave));
    const anterior = existente ? existente.valor : String(SLA_PADRAO[coluna]);
    const novo = String(Math.trunc(dias));
    if (!existente) {
      await tx.insert(parametro).values({ chave, valor: novo, descricao: `SLA da coluna ${coluna} (dias)` });
    } else {
      await tx.update(parametro).set({ valor: novo }).where(eq(parametro.chave, chave));
    }
    if (anterior !== novo) {
      await auditoria.registrar(tx, {
        entidade: "parametro",
        entidade_id: 0,
        tipo_evento: "SLA_ALTERADO",
        descricao: `SLA de ${coluna}: ${anterior} -> ${novo} dias`,
        campo: chave,
        valor_anterior: anterior,
        valor_novo: novo,
        usuario,
      });
    }
  }
  return sla_vigente(tx);
}

/** Requisito de saída do estado não atendido (o `ValueError` com `motivos`). */
export class RequisitoDeSaidaNaoAtendido extends RegraViolada {
  constructor(public motivos: string[]) {
    super(motivos.join("; "));
  }
}

export interface ResumoCartao<P = Processo> {
  readonly processo: P;
  readonly coluna: string;
  readonly dias_no_estado: number;
  readonly sla: number;
  readonly atrasado: boolean;
  readonly anexos: number;
  readonly checklist_feitos: number;
  readonly checklist_total: number;
}

/**
 * "Precisa de você hoje": passou do SLA, ou ainda não saiu do "A fazer".
 *
 * Uma função, e não três critérios parecidos. O cartão do painel já escrevia
 * este critério inline, o contador ao lado dele contava outra coisa
 * (`atrasado`, sobre todos os processos) e o link "Ver todos" levava a uma
 * lista que aplicava um terceiro (`?atrasados=1`, só o SLA). Três definições de
 * um fato só, lado a lado, na tela de entrada — e a de menor número era a que
 * tinha o link.
 *
 * O critério inclui `A_FAZER` de propósito: processo recém-autuado não tem
 * dias no estado para estourar SLA nenhum, e mesmo assim é exatamente o que
 * ninguém pegou ainda.
 */
export function precisa_de_atencao(resumo: Pick<ResumoCartao<unknown>, "atrasado" | "coluna">): boolean {
  return resumo.atrasado || resumo.coluna === "A_FAZER";
}

// ---------------------------------------------------------------------
// Requisitos de saída (§4)
// ---------------------------------------------------------------------
export async function requisitos_de_saida(
  tx: Executor,
  processo: Pick<Processo, "id" | "estado_tecnico" | "observacoes" | "unidade_uorg_id">,
  destino: string,
): Promise<string[]> {
  const faltas: string[] = [];
  const origem = processo.estado_tecnico;

  if (origem === "EM_TRIAGEM" && destino !== "ARQUIVADO" && destino !== "SOBRESTADO") {
    const categorias = await _categorias_anexadas(tx, processo.id);
    if (!categorias.has("PORTARIA")) faltas.push("anexe a portaria de localização");
    if (!categorias.has("FORMULARIO")) {
      faltas.push("anexe o formulário assinado pelo servidor e pela chefia (art. 17)");
    }
  }

  if (origem === "AGUARDANDO_QUANTIFICACAO") {
    const categorias = await _categorias_anexadas(tx, processo.id);
    if (!categorias.has("RELATORIO_CAMPO") && !processo.observacoes) {
      faltas.push(
        "anexe o relatório de ensaio ou registre a justificativa formal de avaliação qualitativa",
      );
    }
  }

  if (origem === ATALHO_REUSO_LAUDO[0] && destino === ATALHO_REUSO_LAUDO[1]) {
    if (!(await _tem_laudo_vigente(tx, processo))) {
      faltas.push(
        "o atalho para elaboração de parecer exige um laudo VIGENTE do mesmo " +
          "posto vinculado (IN 15/2022, art. 10, §3º)",
      );
    }
  }
  return faltas;
}

async function _categorias_anexadas(tx: Executor, processo_id: number): Promise<Set<string>> {
  const linhas = await tx
    .select({ categoria: anexo.categoria })
    .from(anexo)
    .where(and(eq(anexo.entidade, "processo"), eq(anexo.entidade_id, processo_id), eq(anexo.ativo, true)));
  return new Set(linhas.map((l) => l.categoria));
}

async function _tem_laudo_vigente(tx: Executor, processo: Pick<Processo, "unidade_uorg_id">): Promise<boolean> {
  if (processo.unidade_uorg_id === null) return false;
  const [linha] = await tx
    .select({ n: count() })
    .from(laudo_tecnico)
    .where(and(eq(laudo_tecnico.unidade_uorg_id, processo.unidade_uorg_id), eq(laudo_tecnico.status, "VIGENTE")));
  return (linha?.n ?? 0) > 0;
}

// ---------------------------------------------------------------------
// Transição
// ---------------------------------------------------------------------
export interface OpcoesMover {
  comentario?: string | null;
  inciso_art11?: string | null;
  laudo_reusado?: { numero_siape: string } | null;
  forcar?: boolean;
}

export async function mover<P extends Processo>(
  tx: Executor,
  processo: P,
  destino: string,
  usuario: UsuarioAtual,
  opcoes: OpcoesMover = {},
): Promise<P> {
  usuario.exigir("processo.status");
  const origem = processo.estado_tecnico;
  if (origem === destino) return processo;

  exigir_transicao(origem, destino);

  if (!opcoes.forcar) {
    const faltas = await requisitos_de_saida(tx, processo, destino);
    if (faltas.length) throw new RequisitoDeSaidaNaoAtendido(faltas);
  }

  const inciso = opcoes.inciso_art11 ?? null;
  if (destino === "INDEFERIDO_TECNICAMENTE" && (inciso === null || !Object.hasOwn(INCISOS_ART11, inciso))) {
    throw new RequisitoDeSaidaNaoAtendido([
      "indeferimento técnico exige o inciso do art. 11: " +
        Object.entries(INCISOS_ART11)
          .map(([k, v]) => `${k} — ${v}`)
          .join("; "),
    ]);
  }

  let estado_anterior = processo.estado_anterior;
  if (destino === "SOBRESTADO") estado_anterior = origem;
  else if (origem === "SOBRESTADO") estado_anterior = null;

  const novos = {
    estado_anterior,
    estado_tecnico: destino,
    entrou_na_etapa_em: agora_utc(),
    etapa_id: await _etapa_da_coluna(tx, coluna_de(destino)),
    situacao: destino === "CONCLUIDO" ? "CONCLUIDO" : "EM_ANDAMENTO",
    data_conclusao: destino === "CONCLUIDO" ? datas_br.hoje() : null,
    versao: processo.versao + 1,
  };
  const [gravado] = await tx.update(tabela_processo).set(novos).where(eq(tabela_processo.id, processo.id)).returning();
  Object.assign(processo, gravado ?? novos);

  const comentario = opcoes.comentario || null;
  const rotulo = (e: string) => (Object.hasOwn(ROTULO_ESTADO, e) ? ROTULO_ESTADO[e]! : e);
  await auditoria.registrar(tx, {
    entidade: "processo",
    entidade_id: processo.id,
    processo_id: processo.id,
    tipo_evento: auditoria.ESTADO_ALTERADO,
    descricao: `${rotulo(origem)} -> ${rotulo(destino)}` + (comentario ? ` — ${comentario}` : ""),
    campo: "estado_tecnico",
    valor_anterior: origem,
    valor_novo: destino,
    comentario,
    usuario,
  });

  if (origem === ATALHO_REUSO_LAUDO[0] && destino === ATALHO_REUSO_LAUDO[1]) {
    await auditoria.registrar(tx, {
      entidade: "processo",
      entidade_id: processo.id,
      processo_id: processo.id,
      tipo_evento: auditoria.REUSO_DE_LAUDO,
      descricao:
        "Parecer em elaboração por reúso de laudo vigente " +
        `(${opcoes.laudo_reusado ? opcoes.laudo_reusado.numero_siape : "laudo do posto"}) ` +
        "— IN 15/2022, art. 10, §3º.",
      usuario,
    });
  }
  return processo;
}

export async function voltar_do_sobrestamento<P extends Processo>(
  tx: Executor,
  processo: P,
  usuario: UsuarioAtual,
): Promise<P> {
  if (processo.estado_tecnico !== "SOBRESTADO") throw new TransicaoInvalida("o processo não está sobrestado");
  const destino = processo.estado_anterior || "EM_TRIAGEM";
  return mover(tx, processo, destino, usuario, { forcar: true });
}

async function _etapa_da_coluna(tx: Executor, coluna: string): Promise<number> {
  let [etapa] = await tx.select({ id: fluxo_etapa.id }).from(fluxo_etapa).where(eq(fluxo_etapa.codigo, coluna));
  if (!etapa) {
    [etapa] = await tx.select({ id: fluxo_etapa.id }).from(fluxo_etapa).where(eq(fluxo_etapa.codigo, "A_FAZER"));
  }
  return etapa!.id;
}

// ---------------------------------------------------------------------
// Kanban / SLA
// ---------------------------------------------------------------------
export const CHAVES_AGRUPAMENTO: Readonly<Record<string, string>> = Object.freeze({
  estado: "Estado técnico",
  unidade: "Unidade",
  responsavel: "Responsável",
  tipo: "Tipo de processo",
});

type Agrupavel = Pick<Processo, "estado_tecnico"> & {
  unidade?: { nome_extenso: string } | null;
  responsavel?: { nome: string } | null;
  tipo_processo?: { nome: string } | null;
};

/**
 * Agrupa uma lista JÁ filtrada pelo repositório — não consulta nada, por isso
 * vive aqui e não em `repositorios/` (onde todo acesso passa pelo escopo). As
 * relações `unidade`, `responsavel` e `tipo_processo` têm de vir carregadas.
 */
export function agrupar<P extends Agrupavel>(processos: P[], chave: string): Map<string, P[]> {
  const rotulo = (p: P): string => {
    if (chave === "unidade") return p.unidade ? p.unidade.nome_extenso : "(sem unidade)";
    if (chave === "responsavel") return p.responsavel ? p.responsavel.nome : "(sem responsável)";
    if (chave === "tipo") return p.tipo_processo ? p.tipo_processo.nome : "(sem tipo)";
    // o rótulo do grupo é o <summary> que a pessoa lê em /processos, e não
    // texto de trilha: sai acentuado como o resto da tela
    return Object.hasOwn(ROTULO_ESTADO_TELA, p.estado_tecnico) ? ROTULO_ESTADO_TELA[p.estado_tecnico]! : p.estado_tecnico;
  };
  const grupos = new Map<string, P[]>();
  for (const p of processos) {
    const r = rotulo(p);
    if (!grupos.has(r)) grupos.set(r, []);
    grupos.get(r)!.push(p);
  }
  // `dict(sorted(grupos.items()))`: ordem por código de caractere, como o Python
  return new Map([...grupos.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Instancia um modelo de checklist no processo (catálogo /checklists-modelo). */
export async function aplicar_checklist_modelo(
  tx: Executor,
  processo: Pick<Processo, "id">,
  modelo: ChecklistModeloLinha,
  usuario: UsuarioAtual,
) {
  usuario.exigir("processo.editar");
  const [existente] = await tx
    .select()
    .from(checklist)
    .where(and(eq(checklist.processo_id, processo.id), eq(checklist.nome, modelo.nome)));
  if (existente) return existente;

  const [novo] = await tx.insert(checklist).values({ processo_id: processo.id, nome: modelo.nome }).returning();
  const itens = ChecklistModelo.lista_de_itens(modelo);
  let ordem = 1;
  for (const descricao of itens) {
    await tx.insert(checklist_item).values({ checklist_id: novo!.id, descricao, ordem: ordem++ });
  }
  await auditoria.registrar(tx, {
    entidade: "checklist",
    entidade_id: novo!.id,
    processo_id: processo.id,
    tipo_evento: "CHECKLIST_APLICADO",
    descricao: `Modelo '${modelo.nome}' aplicado (${itens.length} itens).`,
    usuario,
  });
  return novo!;
}

export async function resumir<P extends Pick<Processo, "id" | "estado_tecnico" | "entrou_na_etapa_em">>(
  tx: Executor,
  processo: P,
  sla: Record<string, number> | null = null,
): Promise<ResumoCartao<P>> {
  const tabela_sla = sla ?? (await sla_vigente(tx));
  const coluna = coluna_de(processo.estado_tecnico);
  const dias = datas_br.dias_desde(processo.entrou_na_etapa_em);
  const limite = tabela_sla[coluna] ?? 0;

  const [anexos] = await tx
    .select({ n: count() })
    .from(anexo)
    .where(and(eq(anexo.entidade, "processo"), eq(anexo.entidade_id, processo.id), eq(anexo.ativo, true)));

  const [contagem] = await tx
    .select({
      total: count(),
      feitos: sql<number>`count(*) filter (where ${checklist_item.concluido})`.mapWith(Number),
    })
    .from(checklist_item)
    .innerJoin(checklist, eq(checklist.id, checklist_item.checklist_id))
    .where(eq(checklist.processo_id, processo.id));

  return {
    processo,
    coluna,
    dias_no_estado: dias,
    sla: limite,
    atrasado: Boolean(limite) && dias > limite,
    anexos: anexos?.n ?? 0,
    checklist_feitos: contagem?.feitos ?? 0,
    checklist_total: contagem?.total ?? 0,
  };
}
