/**
 * A vitrine pública de cursos (`/cursos`), sem conta e sem dado pessoal.
 * Especificação: `docs/especificacoes/portal-abho/vitrine-especificacao.md`.
 *
 * Só entra a turma com `divulgar_na_vitrine` e fora de CANCELADA. A regra de
 * "aberta" é uma só (`inscricao_aberta`) e reaproveita a do link por token
 * (`turma.aberta_a_pedido_proprio`), para não haver duas.
 *
 * O que sai daqui é um DTO (`CursoPublico`): sem id interno, sem instrutor e
 * sem nome de ninguém. Vaga é número, nunca lista.
 */
import { and, eq, ne } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import { turma as tabela_turma } from "../db/esquema/index.js";
import { Turma } from "../dominio/treinamento.js";
import * as auditoria from "./auditoria.js";
import { PermissaoNegada, type UsuarioAtual } from "./rbac.js";
import * as setor_equipe from "./setor_equipe.js";
import * as datas_br from "./datas_br.js";
import * as servico_turma from "./turma.js";
import { COM_TURMA, type TurmaCarregada } from "./turma.js";

export const PUBLICOS: Readonly<Record<string, string>> = {
  SERVIDOR: "Servidores",
  TERCEIRIZADO: "Terceirizados",
  DISCENTE: "Estudantes",
  COMUNIDADE: "Comunidade",
};
export const MODALIDADES: Readonly<Record<string, string>> = {
  PRESENCIAL: "Presencial",
  EAD: "Online",
  HIBRIDO: "Híbrido",
};

export type Aba = "abertas" | "breve" | "realizados";
export const ABAS: readonly { chave: Aba; rotulo: string }[] = [
  { chave: "abertas", rotulo: "Inscrições abertas" },
  { chave: "breve", rotulo: "Em breve" },
  { chave: "realizados", rotulo: "Realizados" },
];

/** Depois disto a turma encerrada deixa de ter ficha (410). */
export const DIAS_FICHA_ENCERRADA = 90;
/** "Realizados" lista o que terminou no último ano. */
export const DIAS_REALIZADOS = 365;
const DIA_MS = 86_400_000;

function _dias_entre(de: string, ate: string): number {
  return Math.round((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / DIA_MS);
}

/** Divulgada e recebendo pedido hoje: a única regra de "aberta" da vitrine. */
export function inscricao_aberta(turma: TurmaCarregada, hoje: string): boolean {
  return turma.divulgar_na_vitrine && servico_turma.aberta_a_pedido_proprio(turma, hoje) === "";
}

/** A aba em que a turma aparece, ou `null` quando só tem ficha. */
export function aba_da_turma(turma: TurmaCarregada, hoje: string): Aba | null {
  if (!turma.divulgar_na_vitrine || turma.situacao === "CANCELADA") return null;
  if (inscricao_aberta(turma, hoje)) return "abertas";
  if (turma.situacao === "PLANEJADA" && turma.data_inicio > hoje) return "breve";
  if (
    (turma.situacao === "CONCLUIDA" || turma.situacao === "EM_ANDAMENTO") &&
    _dias_entre(turma.data_fim, hoje) <= DIAS_REALIZADOS
  ) {
    return "realizados";
  }
  return null;
}

export interface Selo {
  texto: string;
  /** `alerta` chama atenção (pouco prazo, pouca vaga); `info` é a regra de sempre */
  tom: "alerta" | "info";
}

export interface CursoPublico {
  codigo: string;
  titulo: string;
  treinamento: string;
  norma: string | null;
  aba: Aba | null;
  aberta: boolean;
  cheia: boolean;
  setor: { sigla: string; nome: string; cor: string | null; icone: string | null } | null;
  campus: string | null;
  campus_sigla: string | null;
  modalidade: string;
  modalidade_rotulo: string;
  local: string | null;
  data_inicio: string;
  data_fim: string;
  hora_inicio: string | null;
  hora_fim: string | null;
  carga_horas: string | null;
  inscricao_ate: string | null;
  vagas_total: number | null;
  vagas_restantes: number | null;
  publico: string[];
  pre_requisito: string | null;
  descricao: string | null;
  conteudo: string[];
  validade_meses: number;
  aceita_comunidade_externa: boolean;
  selos: Selo[];
  /** a arte enviada (`v` troca o endereço quando a arte troca); `null` = capa gerada */
  arte: { alt: string; v: number } | null;
}

/** Os selos do cartão, calculados; nenhum guarda estado. */
export function selos(turma: TurmaCarregada, restantes: number | null, hoje: string): Selo[] {
  const saida: Selo[] = [];
  const aberta = inscricao_aberta(turma, hoje);
  if (aberta && turma.inscricao_aberta_ate !== null) {
    const faltam = _dias_entre(hoje, turma.inscricao_aberta_ate);
    if (faltam >= 0 && faltam <= 7) {
      saida.push({ texto: faltam === 0 ? "Encerra hoje" : `Encerra em ${faltam} dia${faltam > 1 ? "s" : ""}`, tom: "alerta" });
    }
  }
  if (aberta && restantes === 0) saida.push({ texto: "Turma cheia", tom: "alerta" });
  else if (aberta && restantes !== null && turma.vagas !== null && (restantes <= 5 || restantes / turma.vagas <= 0.2)) {
    saida.push({ texto: "Últimas vagas", tom: "alerta" });
  }
  saida.push({ texto: "Certificado incluso", tom: "info" });
  saida.push({ texto: "Gratuito", tom: "info" });
  if (turma.treinamento.validade_meses > 0) {
    const norma = turma.treinamento.norma_referencia;
    saida.push({ texto: norma ? `Vale como reciclagem ${norma}` : "Vale como reciclagem", tom: "info" });
  }
  return saida;
}

function _hhmm(h: string | null): string | null {
  return h ? h.slice(0, 5) : null;
}

async function _dto(tx: Executor, turma: TurmaCarregada, hoje: string): Promise<CursoPublico> {
  const restantes = await servico_turma.vagas_restantes(tx, turma);
  const u = turma.unidade_promotora;
  return {
    codigo: turma.codigo,
    titulo: turma.titulo_vitrine?.trim() || turma.treinamento.nome,
    treinamento: turma.treinamento.nome,
    norma: turma.treinamento.norma_referencia,
    aba: aba_da_turma(turma, hoje),
    aberta: inscricao_aberta(turma, hoje),
    cheia: restantes === 0,
    setor: u ? { sigla: u.sigla ?? u.nome_extenso, nome: u.nome_extenso, cor: u.cor_setor ?? null, icone: u.icone_setor ?? null } : null,
    campus: turma.campus?.nome ?? null,
    campus_sigla: turma.campus?.sigla ?? null,
    modalidade: turma.modalidade,
    modalidade_rotulo: MODALIDADES[turma.modalidade] ?? turma.modalidade,
    local: turma.local,
    data_inicio: turma.data_inicio,
    data_fim: turma.data_fim,
    hora_inicio: _hhmm(turma.hora_inicio),
    hora_fim: _hhmm(turma.hora_fim),
    carga_horas: Turma.carga_efetiva(turma),
    inscricao_ate: turma.inscricao_aberta_ate,
    vagas_total: turma.vagas,
    vagas_restantes: restantes,
    publico: turma.publico_alvo.filter((p) => p in PUBLICOS).map((p) => PUBLICOS[p]!),
    pre_requisito: turma.pre_requisito,
    descricao: turma.descricao,
    conteudo: (turma.treinamento.conteudo_programatico ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean),
    validade_meses: turma.treinamento.validade_meses,
    aceita_comunidade_externa: turma.aceita_comunidade_externa,
    selos: selos(turma, restantes, hoje),
    arte: turma.arte_anexo_id === null ? null : { alt: turma.arte_alt?.trim() || turma.titulo_vitrine?.trim() || turma.treinamento.nome, v: turma.arte_anexo_id },
  };
}

export interface Filtros {
  aba: Aba;
  setor: string;
  campus: string;
  modalidade: string;
}

export interface Listagem {
  itens: CursoPublico[];
  contagem: Record<Aba, number>;
  setores: { sigla: string; nome: string }[];
  campi: { sigla: string; nome: string }[];
}

function _ordem(aba: Aba, a: CursoPublico, b: CursoPublico): number {
  if (aba === "abertas") {
    // lotada no fim; depois o prazo mais próximo
    if (a.cheia !== b.cheia) return a.cheia ? 1 : -1;
    return (a.inscricao_ate ?? "9999").localeCompare(b.inscricao_ate ?? "9999") || a.data_inicio.localeCompare(b.data_inicio);
  }
  if (aba === "realizados") return b.data_fim.localeCompare(a.data_fim);
  return a.data_inicio.localeCompare(b.data_inicio);
}

async function _divulgadas(tx: Executor): Promise<TurmaCarregada[]> {
  return (await tx.query.turma.findMany({
    where: and(eq(tabela_turma.divulgar_na_vitrine, true), ne(tabela_turma.situacao, "CANCELADA")),
    with: COM_TURMA as never,
  })) as unknown as TurmaCarregada[];
}

export async function listar(tx: Executor, f: Filtros, hoje: string = datas_br.hoje()): Promise<Listagem> {
  const todas = await Promise.all((await _divulgadas(tx)).map((t) => _dto(tx, t, hoje)));
  const na_vitrine = todas.filter((c) => c.aba !== null);
  const contagem: Record<Aba, number> = { abertas: 0, breve: 0, realizados: 0 };
  const setores = new Map<string, string>();
  const campi = new Map<string, string>();
  for (const c of na_vitrine) {
    if (c.setor) setores.set(c.setor.sigla, c.setor.nome);
    if (c.campus) campi.set(c.campus_sigla ?? c.campus, c.campus);
  }
  const passa = (c: CursoPublico) =>
    (!f.setor || c.setor?.sigla === f.setor) &&
    (!f.campus || (c.campus_sigla ?? c.campus) === f.campus) &&
    (!f.modalidade || c.modalidade === f.modalidade);
  const filtradas = na_vitrine.filter(passa);
  for (const c of filtradas) contagem[c.aba!]++;
  const itens = filtradas.filter((c) => c.aba === f.aba).sort((a, b) => _ordem(f.aba, a, b));
  const ordenado = (m: Map<string, string>) => [...m].map(([sigla, nome]) => ({ sigla, nome })).sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  return { itens, contagem, setores: ordenado(setores), campi: ordenado(campi) };
}

export type Ficha =
  | { tipo: "ok"; turma: TurmaCarregada; curso: CursoPublico }
  | { tipo: "encerrada" }
  | { tipo: "inexistente" };

/** A ficha pública de uma turma já carregada (a vitrine, o início do servidor e o aviso de reciclagem usam o mesmo DTO). */
export const curso_publico = (tx: Executor, turma: TurmaCarregada, hoje: string = datas_br.hoje()): Promise<CursoPublico> =>
  _dto(tx, turma, hoje);

/** A turma de um código público: só a divulgada e não cancelada tem ficha. */
export async function ficha(tx: Executor, codigo: string, hoje: string = datas_br.hoje()): Promise<Ficha> {
  if (!/^[A-Z]{3}-\d{4}-\d{4}$/.test(codigo)) return { tipo: "inexistente" };
  const t = (await tx.query.turma.findFirst({
    where: and(eq(tabela_turma.codigo, codigo), eq(tabela_turma.divulgar_na_vitrine, true), ne(tabela_turma.situacao, "CANCELADA")),
    with: COM_TURMA as never,
  })) as unknown as TurmaCarregada | undefined;
  if (!t) return { tipo: "inexistente" };
  if (!["PLANEJADA", "INSCRICOES_ABERTAS"].includes(t.situacao) && _dias_entre(t.data_fim, hoje) > DIAS_FICHA_ENCERRADA) {
    return { tipo: "encerrada" };
  }
  return { tipo: "ok", turma: t, curso: await _dto(tx, t, hoje) };
}

// ---------------------------------------------------------------------
// A gestão (a ficha interna da turma)
// ---------------------------------------------------------------------
export class VitrineRecusada extends Error {}

/** O que falta para publicar; vazio quando está pronta. */
export function pendencias(turma: TurmaCarregada, publico: readonly string[] = turma.publico_alvo): string[] {
  const falta: string[] = [];
  if (turma.unidade_promotora_id === null) falta.push("Informe o setor promotor da turma.");
  if (turma.situacao === "INSCRICOES_ABERTAS" && turma.inscricao_aberta_ate === null) {
    falta.push("Informe até quando as inscrições ficam abertas.");
  }
  if (turma.modalidade !== "EAD" && !turma.local && turma.local_id === null) falta.push("Informe o local (ou marque a modalidade online).");
  if (!publico.some((p) => p in PUBLICOS)) falta.push("Marque ao menos um público.");
  if ((turma.descricao ?? "").trim().length < 40) falta.push("Escreva a descrição do curso (ao menos 40 caracteres).");
  return falta;
}

/** Quem publica: o escopo total, ou a equipe do setor promotor da turma. */
export function pode_divulgar(usuario: UsuarioAtual, turma: TurmaCarregada): boolean {
  if (!usuario.pode("turma.criar")) return false;
  if (setor_equipe.ve_todos(usuario)) return true;
  // turma sem setor promotor só é publicada por quem vê todos os setores
  return turma.unidade_promotora_id !== null && usuario.setores_promotores.includes(turma.unidade_promotora_id);
}

export interface DadosDaVitrine {
  divulgar: boolean;
  titulo: string;
  modalidade: string;
  publico: string[];
  pre_requisito: string;
}

export async function configurar(tx: Executor, usuario: UsuarioAtual, turma: TurmaCarregada, d: DadosDaVitrine): Promise<void> {
  if (!pode_divulgar(usuario, turma)) throw new PermissaoNegada("turma.criar");
  if (!(d.modalidade in MODALIDADES)) throw new VitrineRecusada("Modalidade inválida.");
  const publico = [...new Set(d.publico.filter((p) => p in PUBLICOS))];
  const titulo = d.titulo.trim().replace(/\s+/g, " ");
  if (titulo.length > 160) throw new VitrineRecusada("O título da vitrine passa de 160 caracteres.");
  const pre = d.pre_requisito.trim();
  if (pre.length > 300) throw new VitrineRecusada("O pré-requisito passa de 300 caracteres.");
  const proposta = { ...turma, modalidade: d.modalidade } as TurmaCarregada;
  if (d.divulgar) {
    if (turma.situacao === "CANCELADA") throw new VitrineRecusada("Turma cancelada não vai para a vitrine.");
    const falta = pendencias(proposta, publico);
    if (falta.length) throw new VitrineRecusada(`Falta para publicar: ${falta.join(" ")}`);
  }
  const primeira = d.divulgar && turma.divulgada_em === null;
  const mudou_a_publicacao = d.divulgar !== turma.divulgar_na_vitrine;
  const campos = {
    divulgar_na_vitrine: d.divulgar,
    titulo_vitrine: titulo || null,
    modalidade: d.modalidade,
    publico_alvo: publico,
    pre_requisito: pre || null,
    ...(primeira ? { divulgada_em: new Date() } : {}),
  };
  await tx.update(tabela_turma).set(campos).where(eq(tabela_turma.id, turma.id));
  Object.assign(turma, campos);
  if (mudou_a_publicacao) {
    await auditoria.registrar(tx, {
      entidade: "turma",
      entidade_id: turma.id,
      tipo_evento: d.divulgar ? "TURMA_VITRINE_PUBLICADA" : "TURMA_VITRINE_DESPUBLICADA",
      descricao: `${turma.codigo}: ${d.divulgar ? "publicada na" : "retirada da"} vitrine de cursos`,
      usuario,
    });
  }
}
