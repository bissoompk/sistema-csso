/**
 * Consultas de processo. Toda função pública aplica o filtro de escopo.
 * Porte de `app/repositorios/processos.py`.
 *
 * Terceira camada da checagem de acesso (§6). O teste de repositório falha se
 * alguma função pública daqui deixar de invocar `aplicar_escopo`.
 *
 * **Relações.** Os templates leem `processo.servidor.nome`,
 * `processo.unidade.nome_extenso`, `processo.responsavel.nome`... — no Python o
 * SQLAlchemy carregava sob demanda; aqui toda consulta que devolve processo
 * para a tela devolve com `COM_PROCESSO` (Drizzle `with:`).
 */
import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  anexo,
  exposicao,
  laudo_tecnico,
  parecer_tecnico,
  processo as tabela_processo,
  servidor as tabela_servidor,
  tipo_processo,
  unidade_uorg,
} from "../db/esquema/index.js";
import { COLUNAS_KANBAN, ESTADO_PARA_COLUNA, coluna_de } from "../dominio/estados.js";
import { aplicar_escopo, type UsuarioAtual } from "../servicos/rbac.js";
import { pode_ver_nominal } from "../servicos/identificacao.js";
import { chave_busca } from "../servicos/textos.js";
import { declarar_porta } from "../servicos/anexo_acesso.js";
import * as datas_br from "../servicos/datas_br.js";
import { precisa_de_atencao, resumir, type Processo } from "../servicos/processo.js";

/** O que toda tela de processo lê da linha (o `lazy="selectin"` do Python). */
export const COM_PROCESSO = {
  tipo_processo: true,
  etapa: true,
  servidor: { with: { cargo: true } },
  unidade: true,
  responsavel: true,
} as const;

type Servidor = typeof tabela_servidor.$inferSelect;
type Unidade = typeof unidade_uorg.$inferSelect;

export type ProcessoCarregado = Processo & {
  tipo_processo: typeof tipo_processo.$inferSelect;
  etapa: { id: number; codigo: string; nome: string };
  servidor: (Servidor & { cargo: { id: number; nome: string } | null }) | null;
  unidade: Unidade | null;
  responsavel: { id: number; nome: string; login: string } | null;
};

export class Filtro {
  q: string | null = null;
  estado: string | null = null;
  coluna: string | null = null;
  tipo: string | null = null;
  exercicio: number | null = null;
  responsavel_id: number | null = null;
  unidade_id: number | null = null;
  atrasados = false;
  // a visão do cartão "Precisam de você hoje" do painel. Existe como filtro, e
  // não só como laço no painel, porque o número do cartão e o link dele têm de
  // levar à MESMA lista.
  precisam = false;
  sem_numero_sei = false;
  // `false` (o padrão) é o FLUXO; `true` é o cadastro histórico migrado; `null`
  // é "os dois", e existe para a busca global.
  repositorio: boolean | null = false;
  // visões salvas que precisam de consulta própria
  dias_parado: number | null = null;
  sem_percentual = false;
  reavaliacao_pendente = false;
  sem_parecer_assinado = false;
  agrupar: string | null = null;
  pagina = 1;
  por_pagina = 50;

  constructor(d: Partial<Filtro> = {}) {
    Object.assign(this, d);
  }

  como_query_string(troca: Record<string, unknown> = {}): string {
    const base: Record<string, unknown> = {
      q: this.q,
      estado: this.estado,
      tipo: this.tipo,
      exercicio: this.exercicio,
      responsavel_id: this.responsavel_id,
      unidade_id: this.unidade_id,
      atrasados: this.atrasados ? "1" : null,
      precisam: this.precisam ? "1" : null,
      sem_numero_sei: this.sem_numero_sei ? "1" : null,
      repositorio: this.repositorio ? "1" : null,
      dias: this.dias_parado,
      sem_percentual: this.sem_percentual ? "1" : null,
      reavaliacao_pendente: this.reavaliacao_pendente ? "1" : null,
      sem_parecer_assinado: this.sem_parecer_assinado ? "1" : null,
      agrupar: this.agrupar,
    };
    // o Nunjucks passa kwargs como último objeto marcado `__keywords`
    for (const [k, v] of Object.entries(troca)) if (k !== "__keywords") base[k] = v;
    return Object.entries(base)
      .filter(([, v]) => v !== null && v !== undefined && v !== "" && v !== false)
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
  }

  /** Filtros que dependem de dados derivados e rodam após a consulta. */
  get tem_pos_filtro(): boolean {
    return Boolean(
      this.atrasados ||
        this.precisam ||
        this.dias_parado ||
        this.sem_percentual ||
        this.reavaliacao_pendente ||
        this.sem_parecer_assinado,
    );
  }
}

/**
 * O `LIKE '%q%'` do Python. No SQLite o LIKE ignorava a caixa das letras ASCII;
 * no PostgreSQL ele a respeita — `ILIKE` devolve o comportamento que a tela
 * tinha (desvio registrado em DESVIOS.md: o ILIKE também ignora a caixa de
 * letra acentuada, o que o SQLite não fazia).
 */
function contem(coluna: Parameters<typeof ilike>[0], alvo: string): SQL {
  return ilike(coluna, alvo);
}

async function _condicoes(tx: Executor, filtro: Filtro, usuario: UsuarioAtual): Promise<SQL | undefined> {
  const partes: (SQL | undefined)[] = [aplicar_escopo(usuario, tabela_processo)];

  if (filtro.q) {
    const alvo = `%${filtro.q.trim()}%`;
    // RN-19 no FILTRO, e não só na exibição: casar por nome para quem não pode
    // ver o nome amarraria o nome ao `SRV-xxxx` da sessão — a ligação exata que
    // a supressão existe para impedir.
    const chave = chave_busca(filtro.q);
    const ids_servidor = (await tx.select({ id: tabela_servidor.id, nome: tabela_servidor.nome }).from(tabela_servidor))
      .filter((s) => chave_busca(s.nome).includes(chave) && pode_ver_nominal(usuario, s.id))
      .map((s) => s.id);
    const condicoes: SQL[] = [
      contem(tabela_processo.nup, alvo),
      contem(tabela_processo.observacoes, alvo),
      contem(tabela_processo.url_permanente, alvo),
    ];
    if (ids_servidor.length) condicoes.push(inArray(tabela_processo.servidor_id, ids_servidor));
    const laudos = (
      await tx.select({ id: laudo_tecnico.id }).from(laudo_tecnico).where(contem(laudo_tecnico.numero_siape, alvo))
    ).map((l) => l.id);
    if (laudos.length) {
      const ids = (
        await tx
          .select({ processo_id: parecer_tecnico.processo_id })
          .from(parecer_tecnico)
          .where(inArray(parecer_tecnico.laudo_id, laudos))
      )
        .map((p) => p.processo_id)
        .filter((p): p is number => Boolean(p));
      if (ids.length) condicoes.push(inArray(tabela_processo.id, ids));
    }
    partes.push(or(...condicoes));
  }

  if (filtro.estado) partes.push(eq(tabela_processo.estado_tecnico, filtro.estado));
  if (filtro.coluna) {
    const estados = Object.entries(ESTADO_PARA_COLUNA)
      .filter(([, c]) => c === filtro.coluna)
      .map(([e]) => e);
    partes.push(estados.length ? inArray(tabela_processo.estado_tecnico, estados) : sql`false`);
  }
  if (filtro.tipo) {
    const [tipo] = await tx.select({ id: tipo_processo.id }).from(tipo_processo).where(eq(tipo_processo.codigo, filtro.tipo));
    partes.push(eq(tabela_processo.tipo_processo_id, tipo ? tipo.id : -1));
  }
  if (filtro.exercicio) partes.push(eq(tabela_processo.ano_referencia, filtro.exercicio));
  if (filtro.responsavel_id) partes.push(eq(tabela_processo.responsavel_id, filtro.responsavel_id));
  if (filtro.unidade_id) partes.push(eq(tabela_processo.unidade_uorg_id, filtro.unidade_id));
  if (filtro.sem_numero_sei) {
    partes.push(or(isNull(tabela_processo.url_permanente), eq(tabela_processo.url_permanente, "")));
  }
  if (filtro.repositorio !== null) partes.push(eq(tabela_processo.origem_repositorio, filtro.repositorio));
  return and(...partes);
}

/** Visões que dependem de dado derivado (SLA, exposição, anexo). */
async function _passa_no_pos_filtro(tx: Executor, processo: Processo, filtro: Filtro): Promise<boolean> {
  if (filtro.atrasados || filtro.precisam || filtro.dias_parado) {
    const resumo = await resumir(tx, processo);
    if (filtro.atrasados && !resumo.atrasado) return false;
    // o critério mora em `servicos/processo`, e não aqui: é o mesmo que o
    // painel usa para montar o cartão
    if (filtro.precisam && !precisa_de_atencao(resumo)) return false;
    if (filtro.dias_parado && resumo.dias_no_estado < filtro.dias_parado) return false;
  }

  const pareceres = await tx.query.parecer_tecnico.findMany({
    where: eq(parecer_tecnico.processo_id, processo.id),
    with: { exposicoes: { with: { agente_nocivo: true } } },
  });

  if (filtro.sem_percentual) {
    // nenhum parecer com exposição que tenha percentual
    for (const p of pareceres) {
      const [linha] = await tx.select({ n: count() }).from(exposicao).where(eq(exposicao.parecer_id, p.id));
      if ((linha?.n ?? 0) > 0) return false;
    }
  }

  if (filtro.reavaliacao_pendente) {
    const pendente = pareceres.some((p) => p.exposicoes.some((e) => e.agente_nocivo.exige_reavaliacao_quantitativa));
    if (!pendente) return false;
  }

  if (filtro.sem_parecer_assinado) {
    if (!pareceres.length) return false;
    for (const p of pareceres) {
      const [linha] = await tx
        .select({ n: count() })
        .from(anexo)
        .where(
          and(
            eq(anexo.entidade, "parecer_tecnico"),
            eq(anexo.entidade_id, p.id),
            eq(anexo.categoria, "PARECER_ASSINADO"),
            eq(anexo.ativo, true),
          ),
        );
      if ((linha?.n ?? 0) > 0) return false;
    }
  }
  return true;
}

export async function listar(
  tx: Executor,
  usuario: UsuarioAtual,
  filtro: Filtro,
): Promise<[ProcessoCarregado[], number]> {
  const onde = await _condicoes(tx, filtro, usuario);
  const ordem = [asc(tabela_processo.entrou_na_etapa_em), asc(tabela_processo.id)];
  const deslocamento = (Math.max(filtro.pagina, 1) - 1) * filtro.por_pagina;

  if (filtro.tem_pos_filtro) {
    // o pós-filtro depende de dado derivado: filtra tudo e pagina depois,
    // senão o contador mente e a paginação pula registros
    const candidatos = (await tx.query.processo.findMany({
      where: onde,
      with: COM_PROCESSO,
      orderBy: ordem,
    })) as ProcessoCarregado[];
    const todos: ProcessoCarregado[] = [];
    for (const p of candidatos) if (await _passa_no_pos_filtro(tx, p, filtro)) todos.push(p);
    return [todos.slice(deslocamento, deslocamento + filtro.por_pagina), todos.length];
  }

  const [total] = await tx.select({ n: count() }).from(tabela_processo).where(onde);
  const pagina = (await tx.query.processo.findMany({
    where: onde,
    with: COM_PROCESSO,
    orderBy: ordem,
    limit: filtro.por_pagina,
    offset: deslocamento,
  })) as ProcessoCarregado[];
  return [pagina, total?.n ?? 0];
}

/**
 * O bloco de processo da busca global (`/buscar`). Devolve até `limite + 1`
 * linhas de propósito: a excedente é como a tela sabe dizer "há mais".
 */
export async function buscar(
  tx: Executor,
  usuario: UsuarioAtual,
  q: string,
  limite: number,
): Promise<ProcessoCarregado[]> {
  const onde = await _condicoes(tx, new Filtro({ q, repositorio: null }), usuario);
  return (await tx.query.processo.findMany({
    where: onde,
    with: COM_PROCESSO,
    orderBy: [desc(tabela_processo.entrou_na_etapa_em), desc(tabela_processo.id)],
    limit: limite + 1,
  })) as ProcessoCarregado[];
}

export async function por_id(tx: Executor, usuario: UsuarioAtual, processo_id: number): Promise<ProcessoCarregado | null> {
  const achado = await tx.query.processo.findFirst({
    where: and(eq(tabela_processo.id, processo_id), aplicar_escopo(usuario, tabela_processo)),
    with: COM_PROCESSO,
  });
  return (achado as ProcessoCarregado | undefined) ?? null;
}

export async function por_nup(tx: Executor, usuario: UsuarioAtual, nup: string): Promise<ProcessoCarregado | null> {
  const achado = await tx.query.processo.findFirst({
    where: and(eq(tabela_processo.nup, nup), aplicar_escopo(usuario, tabela_processo)),
    with: COM_PROCESSO,
  });
  return (achado as ProcessoCarregado | undefined) ?? null;
}

export async function kanban(
  tx: Executor,
  usuario: UsuarioAtual,
  filtro: Filtro,
): Promise<Record<string, ProcessoCarregado[]>> {
  const onde = await _condicoes(tx, filtro, usuario);
  const processos = (await tx.query.processo.findMany({
    where: onde,
    with: COM_PROCESSO,
    orderBy: [asc(tabela_processo.entrou_na_etapa_em), asc(tabela_processo.id)],
  })) as ProcessoCarregado[];
  const colunas: Record<string, ProcessoCarregado[]> = {};
  for (const [codigo] of COLUNAS_KANBAN) colunas[codigo] = [];
  for (const p of processos) (colunas[coluna_de(p.estado_tecnico)] ??= []).push(p);
  return colunas;
}

export async function contar_por_coluna(
  tx: Executor,
  usuario: UsuarioAtual,
  filtro: Filtro,
): Promise<Record<string, number>> {
  const onde = await _condicoes(tx, filtro, usuario);
  const contagem: Record<string, number> = {};
  for (const [codigo] of COLUNAS_KANBAN) contagem[codigo] = 0;
  const linhas = await tx
    .select({ estado: tabela_processo.estado_tecnico, n: count() })
    .from(tabela_processo)
    .where(onde)
    .groupBy(tabela_processo.estado_tecnico);
  for (const { estado, n } of linhas) {
    const coluna = coluna_de(estado);
    contagem[coluna] = (contagem[coluna] ?? 0) + n;
  }
  return contagem;
}

export interface Indicadores {
  em_andamento: number;
  aguardando: number;
  a_fazer: number;
  atrasados: number;
  concluidos_no_exercicio: number;
  total: number;
  [chave: string]: number | null;
}

/**
 * Indicadores do FLUXO. O repositório (cadastro histórico migrado) fica de
 * fora: contá-lo transforma 381 registros de arquivo em 381 "pendências" e o
 * painel deixa de significar alguma coisa.
 */
export async function indicadores(
  tx: Executor,
  usuario: UsuarioAtual,
  exercicio: number | null = null,
): Promise<Indicadores> {
  const processos = await tx
    .select()
    .from(tabela_processo)
    .where(and(aplicar_escopo(usuario, tabela_processo), eq(tabela_processo.origem_repositorio, false)));
  const ano = exercicio || Number(datas_br.hoje().slice(0, 4));

  const resumos = [];
  for (const p of processos) resumos.push(await resumir(tx, p));
  const concluidos = processos.filter(
    (p) => p.estado_tecnico === "CONCLUIDO" && p.data_conclusao && Number(p.data_conclusao.slice(0, 4)) === ano,
  );
  return {
    em_andamento: resumos.filter((r) => r.coluna === "EM_ANDAMENTO").length,
    aguardando: resumos.filter((r) => r.coluna === "AGUARDANDO").length,
    a_fazer: resumos.filter((r) => r.coluna === "A_FAZER").length,
    atrasados: resumos.filter((r) => r.atrasado).length,
    concluidos_no_exercicio: concluidos.length,
    total: processos.length,
  };
}

export async function unidades_com_processo(tx: Executor, usuario: UsuarioAtual): Promise<Unidade[]> {
  const linhas = await tx
    .select({ unidade_uorg_id: tabela_processo.unidade_uorg_id })
    .from(tabela_processo)
    .where(aplicar_escopo(usuario, tabela_processo));
  const ids = [...new Set(linhas.map((l) => l.unidade_uorg_id).filter((x): x is number => Boolean(x)))];
  if (!ids.length) return [];
  return tx.select().from(unidade_uorg).where(inArray(unidade_uorg.id, ids)).orderBy(asc(unidade_uorg.nome_extenso));
}

// O download do anexo do processo passa pela MESMA porta de `GET /processos/{id}`
// (DESVIOS.md: `anexo_acesso` recebe a regra de quem é dono).
declarar_porta("processo_por_id", por_id);
