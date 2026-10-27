/**
 * O plano de ação do acidente (fatia F5): as medidas de prevenção, cada uma
 * com responsável, prazo e prioridade, acompanhadas até o fim.
 *
 * - **Cada ação tem número estável** dentro do caso (`numero`, sequencial) e uma
 *   pendência própria (`ACIDENTE_ACAO_PRAZO`, prazo da ação). No legado o plano
 *   se apagava e regravava a cada salvamento; aqui a ação **nunca se apaga**
 *   (trigger): ou conclui, ou se cancela com motivo.
 * - **Máquina de estado** (`TRANSICOES_ACAO`): PENDENTE → EM_ANDAMENTO →
 *   CONCLUIDA; PENDENTE ou EM_ANDAMENTO → CANCELADA. Concluir exige o texto do
 *   que foi feito (e aceita um anexo de evidência); cancelar exige o motivo.
 * - **Quando se mexe.** Criar vale até o caso ser cancelado; o plano continua
 *   depois do relatório (a prevenção acompanha o que foi emitido). Alterar,
 *   iniciar, concluir e cancelar só enquanto a ação não terminou.
 * - **Controle otimista** (`versao`) na edição, com diff por campo na trilha.
 * - **Texto.** Achado, ação, conclusão e motivo falam do trabalho, não do corpo:
 *   passam pelo filtro de saúde (nexo ocupacional) e recusam CPF.
 * - Permissão única: `acidente.investigar`. A leitura é a da ficha.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  acidente_acao,
  acidente_ocorrencia,
  anexo as tabela_anexo,
  pendencia as tabela_pendencia,
  unidade_uorg,
  usuario as tabela_usuario,
} from "../db/esquema/index.js";
import { PRIORIDADES, TIPOS_ACAO, TRANSICOES_ACAO } from "../dominio/acidente.js";
import { hoje_iso } from "../dominio/datas.js";
import { RegraViolada } from "../nucleo/erros.js";
import type { Ocorrencia } from "./acidente_comunicacao.js";
import { tipo_da_evidencia, type Arquivo } from "./acidente_entrevista.js";
import * as anexos from "./anexos.js";
import * as auditoria from "./auditoria.js";
import * as pendencias from "./pendencias.js";
import type { UsuarioAtual } from "./rbac.js";
import * as textos from "./textos.js";

export type Acao = typeof acidente_acao.$inferSelect;

export class AcaoRecusada extends RegraViolada {}
/** Outra pessoa mexeu na ação depois que a tela foi aberta. */
export class AcaoAlterada extends AcaoRecusada {}
/** A ação não existe neste caso. */
export class AcaoInexistente extends RegraViolada {}

export const ESTADOS_ABERTOS: readonly string[] = ["PENDENTE", "EM_ANDAMENTO"];

export interface DadosAcao {
  achado: string | null;
  acao: string;
  tipo_acao: string;
  /** conta responsável; vazio = quem conduz o caso */
  responsavel_usuario_id: number | null;
  responsavel_unidade_uorg_id: number | null;
  responsavel_texto: string | null;
  /** "AAAA-MM-DD" */
  prazo: string | null;
  prioridade: string;
}

const CHAVE = (acao_id: number) => `ACIDENTE_ACAO_PRAZO:${acao_id}`;

function _texto(valor: string | null | undefined, rotulo: string, max: number, obrigatorio: boolean): string | null {
  const v = (valor ?? "").trim();
  if (!v) {
    if (obrigatorio) throw new AcaoRecusada(`Informe ${rotulo}.`);
    return null;
  }
  if (v.length > max) throw new AcaoRecusada(`${rotulo[0]!.toUpperCase()}${rotulo.slice(1)}: no máximo ${max} caracteres.`);
  if (/(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)/.test(v)) {
    throw new AcaoRecusada(`${rotulo[0]!.toUpperCase()}${rotulo.slice(1)} tem um número com formato de CPF. CPF não entra no plano.`);
  }
  try {
    textos.exigir_texto_limpo(v, rotulo, textos.CONTEXTO_NEXO_OCUPACIONAL);
  } catch (erro) {
    if (!(erro instanceof textos.TextoProibido)) throw erro;
    throw new AcaoRecusada(
      `${rotulo[0]!.toUpperCase()}${rotulo.slice(1)} tem termo de saúde ou dado sensível. O plano fala do trabalho e da prevenção; ` +
        "o que for de saúde fica com o médico do trabalho.",
    );
  }
  return v;
}

function _exigir(usuario: UsuarioAtual): void {
  usuario.exigir("acidente.investigar");
}

async function _normalizar(tx: Executor, d: DadosAcao, criando: boolean): Promise<DadosAcao> {
  if (!(TIPOS_ACAO as readonly string[]).includes(d.tipo_acao)) throw new AcaoRecusada("Escolha o tipo da ação.");
  if (!(PRIORIDADES as readonly string[]).includes(d.prioridade)) throw new AcaoRecusada("Escolha a prioridade.");
  const prazo = d.prazo && d.prazo !== "" ? d.prazo : null;
  if (prazo !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(prazo) || Number.isNaN(Date.parse(`${prazo}T00:00:00Z`))) throw new AcaoRecusada("Prazo: data inválida.");
    if (criando && prazo < hoje_iso()) throw new AcaoRecusada("O prazo de uma ação nova não pode ser no passado.");
  }
  if (d.responsavel_usuario_id !== null) {
    const [u] = await tx
      .select({ id: tabela_usuario.id })
      .from(tabela_usuario)
      .where(and(eq(tabela_usuario.id, d.responsavel_usuario_id), eq(tabela_usuario.ativo, true)));
    if (!u) throw new AcaoRecusada("A conta responsável não existe ou está inativa.");
  }
  if (d.responsavel_unidade_uorg_id !== null) {
    const [u] = await tx.select({ id: unidade_uorg.id }).from(unidade_uorg).where(eq(unidade_uorg.id, d.responsavel_unidade_uorg_id));
    if (!u) throw new AcaoRecusada("Unidade responsável desconhecida.");
  }
  return {
    achado: _texto(d.achado, "o achado", 2000, false),
    acao: _texto(d.acao, "a ação", 2000, true)!,
    tipo_acao: d.tipo_acao,
    responsavel_usuario_id: d.responsavel_usuario_id,
    responsavel_unidade_uorg_id: d.responsavel_unidade_uorg_id,
    responsavel_texto: _texto(d.responsavel_texto, "o responsável", 160, false),
    prazo,
    prioridade: d.prioridade,
  };
}

async function _da_ocorrencia(tx: Executor, ocorrencia: Ocorrencia, acao_id: number): Promise<Acao> {
  const [a] = await tx
    .select()
    .from(acidente_acao)
    .where(and(eq(acidente_acao.id, acao_id), eq(acidente_acao.ocorrencia_id, ocorrencia.id)));
  if (!a) throw new AcaoInexistente("Ação não encontrada neste caso.");
  return a;
}

async function _pendencia(tx: Executor, acao_id: number) {
  const [p] = await tx
    .select()
    .from(tabela_pendencia)
    .where(and(eq(tabela_pendencia.chave, CHAVE(acao_id)), eq(tabela_pendencia.concluida, false)));
  return p ?? null;
}

const _protocolo_numero = (oc: Ocorrencia, a: { numero: number }) => `${oc.protocolo}, ação nº ${a.numero}`;

/** Cria a ação, com a sua pendência (prazo da ação; responsável da ação ou do caso). */
export async function criar(tx: Executor, usuario: UsuarioAtual, ocorrencia: Ocorrencia, bruto: DadosAcao): Promise<Acao> {
  _exigir(usuario);
  if (ocorrencia.estado === "CANCELADA") throw new AcaoRecusada(`${ocorrencia.protocolo} foi cancelada: não recebe ação nova.`);
  const d = await _normalizar(tx, bruto, true);
  const [{ maior }] = await tx
    .select({ maior: sql<number>`coalesce(max(${acidente_acao.numero}), 0)::int` })
    .from(acidente_acao)
    .where(eq(acidente_acao.ocorrencia_id, ocorrencia.id));
  const [acao] = await tx
    .insert(acidente_acao)
    .values({ ...d, ocorrencia_id: ocorrencia.id, numero: maior! + 1, criada_por: usuario.id })
    .returning();
  await pendencias.abrir(tx, {
    tipo: "ACIDENTE_ACAO_PRAZO",
    chave: CHAVE(acao!.id),
    descricao: `Cumprir a ação nº ${acao!.numero} de ${ocorrencia.protocolo}`,
    entidade: "acidente_ocorrencia",
    entidade_id: ocorrencia.id,
    responsavel_id: d.responsavel_usuario_id ?? ocorrencia.responsavel_id ?? usuario.id,
    ...(d.prazo ? { prazo: d.prazo } : {}),
    usuario,
  });
  await auditoria.registrar(tx, {
    entidade: "acidente_ocorrencia",
    entidade_id: ocorrencia.id,
    tipo_evento: auditoria.ACIDENTE_ACAO_CRIADA,
    descricao: `${_protocolo_numero(ocorrencia, acao!)} criada (${d.tipo_acao}, prioridade ${d.prioridade}${d.prazo ? `, prazo ${d.prazo}` : ", sem prazo"}).`,
    usuario,
  });
  return acao!;
}

/** Edita uma ação em aberto; a versão é a que a tela leu. O diff vai por campo para a trilha. */
export async function alterar(
  tx: Executor,
  usuario: UsuarioAtual,
  ocorrencia: Ocorrencia,
  acao_id: number,
  bruto: DadosAcao,
  versao: number,
): Promise<Acao> {
  _exigir(usuario);
  const atual = await _da_ocorrencia(tx, ocorrencia, acao_id);
  if (!ESTADOS_ABERTOS.includes(atual.estado)) throw new AcaoRecusada("A ação já terminou: não se altera.");
  if (atual.versao !== versao) throw new AcaoAlterada("Outra pessoa alterou esta ação enquanto a tela estava aberta. Abra de novo e refaça a alteração.");
  const d = await _normalizar(tx, bruto, false);
  const campos = ["achado", "acao", "tipo_acao", "responsavel_usuario_id", "responsavel_unidade_uorg_id", "responsavel_texto", "prazo", "prioridade"] as const;
  const antes: Record<string, unknown> = {};
  const depois: Record<string, unknown> = {};
  for (const c of campos) {
    antes[c] = atual[c];
    depois[c] = d[c];
  }
  const [nova] = await tx
    .update(acidente_acao)
    .set({ ...d, versao: atual.versao + 1 })
    .where(eq(acidente_acao.id, atual.id))
    .returning();
  await auditoria.registrar_diferencas(tx, {
    entidade: "acidente_ocorrencia",
    entidade_id: ocorrencia.id,
    antes,
    depois,
    usuario,
    tipo_evento: auditoria.ACIDENTE_ACAO_ALTERADA,
  });
  // o prazo e o responsável da ação são os da pendência
  const p = await _pendencia(tx, atual.id);
  if (p) {
    await tx
      .update(tabela_pendencia)
      .set({
        ...(d.prazo ? { prazo: d.prazo } : {}),
        responsavel_id: d.responsavel_usuario_id ?? ocorrencia.responsavel_id ?? p.responsavel_id,
      })
      .where(eq(tabela_pendencia.id, p.id));
  }
  return nova!;
}

function _transitar(atual: Acao, para: string): void {
  if (!TRANSICOES_ACAO[atual.estado]?.has(para)) {
    throw new AcaoRecusada(`Uma ação ${atual.estado === "CONCLUIDA" ? "concluída" : atual.estado === "CANCELADA" ? "cancelada" : "nesse estado"} não pode ir para esse estado.`);
  }
}

async function _fechar(tx: Executor, acao_id: number, usuario: UsuarioAtual): Promise<void> {
  const p = await _pendencia(tx, acao_id);
  if (p) await pendencias.concluir(tx, p, usuario);
}

/** PENDENTE → EM_ANDAMENTO. */
export async function iniciar(tx: Executor, usuario: UsuarioAtual, ocorrencia: Ocorrencia, acao_id: number, versao: number): Promise<Acao> {
  _exigir(usuario);
  const atual = await _da_ocorrencia(tx, ocorrencia, acao_id);
  _transitar(atual, "EM_ANDAMENTO");
  if (atual.versao !== versao) throw new AcaoAlterada("Outra pessoa alterou esta ação enquanto a tela estava aberta. Abra de novo.");
  const [nova] = await tx
    .update(acidente_acao)
    .set({ estado: "EM_ANDAMENTO", versao: atual.versao + 1 })
    .where(eq(acidente_acao.id, atual.id))
    .returning();
  await auditoria.registrar(tx, {
    entidade: "acidente_ocorrencia",
    entidade_id: ocorrencia.id,
    tipo_evento: auditoria.ACIDENTE_ACAO_ALTERADA,
    descricao: `${_protocolo_numero(ocorrencia, atual)}: PENDENTE -> EM_ANDAMENTO.`,
    usuario,
  });
  return nova!;
}

/** EM_ANDAMENTO → CONCLUIDA, com o que foi feito (obrigatório) e uma evidência opcional. */
export async function concluir(
  tx: Executor,
  usuario: UsuarioAtual,
  ocorrencia: Ocorrencia,
  acao_id: number,
  texto: string | null,
  evidencia: Arquivo | null,
  versao: number,
): Promise<Acao> {
  _exigir(usuario);
  const atual = await _da_ocorrencia(tx, ocorrencia, acao_id);
  _transitar(atual, "CONCLUIDA");
  if (atual.versao !== versao) throw new AcaoAlterada("Outra pessoa alterou esta ação enquanto a tela estava aberta. Abra de novo.");
  const feito = _texto(texto, "o que foi feito", 4000, true)!;
  let anexo_id: number | null = null;
  if (evidencia) {
    if (!evidencia.conteudo.byteLength) throw new AcaoRecusada("O arquivo veio vazio.");
    if (evidencia.conteudo.byteLength > anexos.LIMITE_BYTES) throw new anexos.AnexoGrandeDemais(evidencia.conteudo.byteLength);
    const mime = tipo_da_evidencia(evidencia.conteudo);
    if (!mime) throw new AcaoRecusada("A evidência vai em PDF ou imagem (PNG, JPEG, GIF, WebP).");
    const r = await anexos.guardar(tx, {
      entidade: "acidente_ocorrencia",
      entidade_id: ocorrencia.id,
      nome_original: evidencia.nome || "evidencia",
      conteudo: evidencia.conteudo,
      mime_type: mime,
      categoria: "EVIDENCIA_ACIDENTE",
      usuario,
    });
    anexo_id = r.anexo.id;
  }
  const [nova] = await tx
    .update(acidente_acao)
    .set({ estado: "CONCLUIDA", conclusao_texto: feito, conclusao_anexo_id: anexo_id, concluida_em: new Date(), versao: atual.versao + 1 })
    .where(eq(acidente_acao.id, atual.id))
    .returning();
  await _fechar(tx, atual.id, usuario);
  await auditoria.registrar(tx, {
    entidade: "acidente_ocorrencia",
    entidade_id: ocorrencia.id,
    tipo_evento: auditoria.ACIDENTE_ACAO_CONCLUIDA,
    descricao: `${_protocolo_numero(ocorrencia, atual)} concluída${anexo_id ? " (com evidência)" : ""}.`,
    usuario,
  });
  return nova!;
}

/** PENDENTE ou EM_ANDAMENTO → CANCELADA, com motivo. A ação fica no plano, riscada. */
export async function cancelar(
  tx: Executor,
  usuario: UsuarioAtual,
  ocorrencia: Ocorrencia,
  acao_id: number,
  motivo: string | null,
  versao: number,
): Promise<Acao> {
  _exigir(usuario);
  const atual = await _da_ocorrencia(tx, ocorrencia, acao_id);
  _transitar(atual, "CANCELADA");
  if (atual.versao !== versao) throw new AcaoAlterada("Outra pessoa alterou esta ação enquanto a tela estava aberta. Abra de novo.");
  const porque = _texto(motivo, "o motivo do cancelamento", 2000, true)!;
  const [nova] = await tx
    .update(acidente_acao)
    .set({ estado: "CANCELADA", cancelamento_motivo: porque, versao: atual.versao + 1 })
    .where(eq(acidente_acao.id, atual.id))
    .returning();
  await _fechar(tx, atual.id, usuario);
  await auditoria.registrar(tx, {
    entidade: "acidente_ocorrencia",
    entidade_id: ocorrencia.id,
    tipo_evento: auditoria.ACIDENTE_ACAO_CANCELADA,
    descricao: `${_protocolo_numero(ocorrencia, atual)} cancelada: ${porque}`,
    usuario,
  });
  return nova!;
}

// ---------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------
export interface LinhaAcao extends Acao {
  responsavel_nome: string | null;
  unidade_nome: string | null;
  anexo_nome: string | null;
  /** aberta e com o prazo já passado */
  vencida: boolean;
}

/** As ações de um caso, na ordem do número. */
export async function do_caso(tx: Executor, ocorrencia_id: number): Promise<LinhaAcao[]> {
  const linhas = await tx.select().from(acidente_acao).where(eq(acidente_acao.ocorrencia_id, ocorrencia_id)).orderBy(asc(acidente_acao.numero));
  return _enriquecer(tx, linhas);
}

async function _enriquecer(tx: Executor, linhas: Acao[]): Promise<LinhaAcao[]> {
  const usuarios = [...new Set(linhas.map((l) => l.responsavel_usuario_id).filter((v): v is number => v !== null))];
  const unidades = [...new Set(linhas.map((l) => l.responsavel_unidade_uorg_id).filter((v): v is number => v !== null))];
  const anexos_ids = [...new Set(linhas.map((l) => l.conclusao_anexo_id).filter((v): v is number => v !== null))];
  const nome_usuario = new Map(
    usuarios.length ? (await tx.select({ id: tabela_usuario.id, nome: tabela_usuario.nome }).from(tabela_usuario).where(inArray(tabela_usuario.id, usuarios))).map((u) => [u.id, u.nome]) : [],
  );
  const nome_unidade = new Map(
    unidades.length ? (await tx.select({ id: unidade_uorg.id, nome: unidade_uorg.nome_extenso }).from(unidade_uorg).where(inArray(unidade_uorg.id, unidades))).map((u) => [u.id, u.nome]) : [],
  );
  const nome_anexo = new Map(
    anexos_ids.length ? (await tx.select({ id: tabela_anexo.id, nome: tabela_anexo.nome_original }).from(tabela_anexo).where(inArray(tabela_anexo.id, anexos_ids))).map((a) => [a.id, a.nome]) : [],
  );
  const hoje = hoje_iso();
  return linhas.map((l) => ({
    ...l,
    responsavel_nome: l.responsavel_usuario_id ? (nome_usuario.get(l.responsavel_usuario_id) ?? null) : null,
    unidade_nome: l.responsavel_unidade_uorg_id ? (nome_unidade.get(l.responsavel_unidade_uorg_id) ?? null) : null,
    anexo_nome: l.conclusao_anexo_id ? (nome_anexo.get(l.conclusao_anexo_id) ?? null) : null,
    vencida: ESTADOS_ABERTOS.includes(l.estado) && l.prazo !== null && l.prazo < hoje,
  }));
}

export async function unidades(tx: Executor) {
  return tx.select({ id: unidade_uorg.id, nome: unidade_uorg.nome_extenso }).from(unidade_uorg).orderBy(asc(unidade_uorg.nome_extenso));
}

/**
 * O plano de todos os casos no alcance de quem pede (a lista da tela
 * `/acidentes/acoes`). `onde` é o recorte de escopo e de ocorrência restrita
 * da rota; `filtro` é "abertas" (padrão), "vencidas" ou "todas".
 */
export async function lista_geral(tx: Executor, onde: import("drizzle-orm").SQL | undefined, filtro: string) {
  const condicoes = [onde];
  if (filtro === "abertas" || filtro === "vencidas") condicoes.push(inArray(acidente_acao.estado, [...ESTADOS_ABERTOS]));
  if (filtro === "vencidas") condicoes.push(sql`${acidente_acao.prazo} < ${hoje_iso()}`);
  const filtros = condicoes.filter((c): c is import("drizzle-orm").SQL => !!c);
  const linhas = await tx
    .select({ acao: acidente_acao, protocolo: acidente_ocorrencia.protocolo, ocorrencia_id: acidente_ocorrencia.id })
    .from(acidente_acao)
    .innerJoin(acidente_ocorrencia, eq(acidente_ocorrencia.id, acidente_acao.ocorrencia_id))
    .where(filtros.length ? and(...filtros) : undefined)
    .orderBy(sql`${acidente_acao.prazo} asc nulls last`, desc(acidente_acao.id))
    .limit(500);
  const ricas = await _enriquecer(tx, linhas.map((l) => l.acao));
  return ricas.map((a, i) => ({ ...a, protocolo: linhas[i]!.protocolo }));
}
