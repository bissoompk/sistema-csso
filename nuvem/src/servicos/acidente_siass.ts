/**
 * O encaminhamento ao SIASS, a decisão da perícia e a conclusão do caso
 * (fatia F7): o que fecha o ciclo da ocorrência.
 *
 * - **Encaminhar** (RELATORIO_EMITIDO → ENCAMINHADA_SIASS): grava data, meio, NUP
 *   do SEI e a versão do relatório (completa) enviada. Fecha o prazo legal de
 *   comunicação (art. 214) e abre `ACIDENTE_AGUARDA_PERICIA` (60 dias). Já
 *   encaminhado, um novo encaminhamento (a correção) só acrescenta a linha:
 *   append-only, o estado não muda.
 * - **Decisão pericial**: append-only; a correção é uma linha nova que aponta a
 *   anterior (`substitui_id`). O número da CAT no SIASS tem campo próprio. A
 *   observação NÃO tem a dispensa da palavra «doença» (RN-21, contexto padrão):
 *   é do perito, não do nexo técnico da SST. Fecha a pendência de aguardar a
 *   perícia.
 * - **Concluir** (→ CONCLUIDA): de ENCAMINHADA_SIASS exige a decisão registrada OU
 *   o motivo de conclusão sem decisão; de RELATORIO_EMITIDO só para o caso que a
 *   investigação marcou como NÃO requer CAT no SIASS, com motivo. Fecha as
 *   pendências do caso. O plano de ação segue vivo depois (prevenção).
 * - Só `acidente.siass`. Nenhum texto daqui leva dado de saúde.
 */
import { and, asc, desc, eq } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  acidente_decisao_pericial,
  acidente_encaminhamento,
  acidente_ocorrencia,
  acidente_relatorio,
  pendencia as tabela_pendencia,
  usuario as tabela_usuario,
} from "../db/esquema/index.js";
import { MEIOS_ENCAMINHAMENTO, RESULTADOS_PERICIA, ROTULO_MEIO_ENCAMINHAMENTO, ROTULO_RESULTADO_PERICIA } from "../dominio/acidente.js";
import { hoje_iso } from "../dominio/datas.js";
import { exigir_transicao_acidente } from "../dominio/estados.js";
import { RegraViolada } from "../nucleo/erros.js";
import type { Ocorrencia } from "./acidente_comunicacao.js";
import * as investigacao from "./acidente_investigacao.js";
import * as auditoria from "./auditoria.js";
import * as nup from "./nup.js";
import * as pendencias from "./pendencias.js";
import type { UsuarioAtual } from "./rbac.js";
import * as textos from "./textos.js";

export class SiassRecusado extends RegraViolada {}

const ENTIDADE = "acidente_ocorrencia";

export interface DadosEncaminhamento {
  meio: string;
  nup_sei: string | null;
  /** "AAAA-MM-DD" */
  encaminhado_em: string;
  observacao: string | null;
}

export interface DadosDecisao {
  resultado: string;
  decidida_em: string;
  numero_cat_siass: string | null;
  observacao: string | null;
}

function _data(valor: string, rotulo: string): string {
  const v = (valor ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new SiassRecusado(`${rotulo}: data inválida.`);
  if (v > hoje_iso()) throw new SiassRecusado(`${rotulo} não pode ser no futuro.`);
  return v;
}

/** Texto livre: sem CPF e sem termo de saúde, inclusive «doença» (contexto padrão, RN-21). */
function _texto(valor: string | null | undefined, rotulo: string, max: number): string | null {
  const v = (valor ?? "").trim();
  if (!v) return null;
  if (v.length > max) throw new SiassRecusado(`${rotulo}: no máximo ${max} caracteres.`);
  if (/(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)/.test(v)) throw new SiassRecusado(`${rotulo} tem um número com formato de CPF.`);
  try {
    textos.exigir_texto_limpo(v, rotulo, textos.CONTEXTO_PADRAO);
  } catch (erro) {
    if (!(erro instanceof textos.TextoProibido)) throw erro;
    throw new SiassRecusado(
      `${rotulo[0]!.toUpperCase()}${rotulo.slice(1)} tem termo de saúde (como «doença»). Registre só o resultado e o número da CAT; o que é clínico fica com a perícia.`,
    );
  }
  return v;
}

async function _pendencia_aberta(tx: Executor, chave: string) {
  const [p] = await tx
    .select()
    .from(tabela_pendencia)
    .where(and(eq(tabela_pendencia.chave, chave), eq(tabela_pendencia.concluida, false)));
  return p ?? null;
}

async function _fechar(tx: Executor, chave: string, usuario: UsuarioAtual): Promise<void> {
  const p = await _pendencia_aberta(tx, chave);
  if (p) await pendencias.concluir(tx, p, usuario);
}

/** Muda o estado com a versão que a tela leu; versão velha recusa. */
async function _mudar_estado(
  tx: Executor,
  usuario: UsuarioAtual,
  ocorrencia: Ocorrencia,
  para: string,
  versao: number,
  extra: Partial<typeof acidente_ocorrencia.$inferInsert> = {},
): Promise<void> {
  const de = ocorrencia.estado;
  exigir_transicao_acidente(de, para);
  const [nova] = await tx
    .update(acidente_ocorrencia)
    .set({ estado: para, versao: versao + 1, ...extra })
    .where(and(eq(acidente_ocorrencia.id, ocorrencia.id), eq(acidente_ocorrencia.versao, versao)))
    .returning();
  if (!nova) throw new SiassRecusado(`${ocorrencia.protocolo} foi alterada por outra pessoa depois que você abriu a tela. Recarregue a ficha e refaça.`);
  Object.assign(ocorrencia, nova);
  await auditoria.registrar(tx, {
    entidade: ENTIDADE,
    entidade_id: ocorrencia.id,
    tipo_evento: auditoria.ACIDENTE_ESTADO_ALTERADO,
    descricao: `${ocorrencia.protocolo}: situação ${de} → ${para}.`,
    campo: "estado",
    valor_anterior: de,
    valor_novo: para,
    usuario,
  });
}

// ---------------------------------------------------------------------
// Encaminhar
// ---------------------------------------------------------------------
export async function encaminhar(
  tx: Executor,
  usuario: UsuarioAtual,
  ocorrencia: Ocorrencia,
  bruto: DadosEncaminhamento,
  versao: number,
) {
  usuario.exigir("acidente.siass");
  const primeiro = ocorrencia.estado === "RELATORIO_EMITIDO";
  if (!primeiro && ocorrencia.estado !== "ENCAMINHADA_SIASS") {
    throw new SiassRecusado(
      ocorrencia.estado === "CONCLUIDA" ? "O caso está concluído." : "Só se encaminha ao SIASS depois de emitido o relatório.",
    );
  }
  if (!(MEIOS_ENCAMINHAMENTO as readonly string[]).includes(bruto.meio)) throw new SiassRecusado("Escolha o meio do encaminhamento.");
  let nup_sei: string | null = null;
  if ((bruto.nup_sei ?? "").trim()) {
    try {
      nup_sei = nup.normalizar(bruto.nup_sei);
    } catch {
      throw new SiassRecusado("O NUP do SEI deve ter 17 dígitos (23086.000000/2026-00).");
    }
  } else if (bruto.meio === "SEI") {
    throw new SiassRecusado("Pelo SEI, informe o NUP do processo.");
  }
  const encaminhado_em = _data(bruto.encaminhado_em, "A data do encaminhamento");
  const observacao = _texto(bruto.observacao, "a observação", 1000);
  // a versão enviada é a vigente da variante completa (a que a perícia recebe)
  const [relatorio] = await tx
    .select()
    .from(acidente_relatorio)
    .where(and(eq(acidente_relatorio.ocorrencia_id, ocorrencia.id), eq(acidente_relatorio.variante, "COMPLETA")))
    .orderBy(desc(acidente_relatorio.versao))
    .limit(1);
  if (!relatorio) throw new SiassRecusado("Não há relatório emitido para encaminhar.");

  const [linha] = await tx
    .insert(acidente_encaminhamento)
    .values({ ocorrencia_id: ocorrencia.id, relatorio_id: relatorio.id, meio: bruto.meio, nup_sei, encaminhado_em, encaminhado_por: usuario.id, observacao })
    .returning();
  await auditoria.registrar(tx, {
    entidade: ENTIDADE,
    entidade_id: ocorrencia.id,
    tipo_evento: auditoria.ACIDENTE_ENCAMINHADO_SIASS,
    descricao: `${ocorrencia.protocolo}: ${primeiro ? "encaminhada" : "novo encaminhamento"} ao SIASS (${ROTULO_MEIO_ENCAMINHAMENTO[bruto.meio]}, relatório versão ${relatorio.versao}).`,
    usuario,
  });
  if (primeiro) {
    await _mudar_estado(tx, usuario, ocorrencia, "ENCAMINHADA_SIASS", versao);
    await _fechar(tx, `ACIDENTE_PRAZO_COMUNICACAO:${ocorrencia.id}`, usuario);
    await pendencias.abrir(tx, {
      tipo: "ACIDENTE_AGUARDA_PERICIA",
      chave: `ACIDENTE_AGUARDA_PERICIA:${ocorrencia.id}`,
      descricao: `Aguardar a decisão da perícia sobre ${ocorrencia.protocolo}`,
      entidade: ENTIDADE,
      entidade_id: ocorrencia.id,
      responsavel_id: ocorrencia.responsavel_id ?? usuario.id,
      usuario,
    });
  }
  return linha!;
}

// ---------------------------------------------------------------------
// Decisão da perícia
// ---------------------------------------------------------------------
export async function registrar_decisao(tx: Executor, usuario: UsuarioAtual, ocorrencia: Ocorrencia, bruto: DadosDecisao) {
  usuario.exigir("acidente.siass");
  if (ocorrencia.estado !== "ENCAMINHADA_SIASS") {
    throw new SiassRecusado(
      ocorrencia.estado === "CONCLUIDA" ? "O caso está concluído: a decisão não se corrige mais." : "A decisão da perícia se registra depois do encaminhamento ao SIASS.",
    );
  }
  if (!(RESULTADOS_PERICIA as readonly string[]).includes(bruto.resultado)) throw new SiassRecusado("Escolha o resultado da perícia.");
  const decidida_em = _data(bruto.decidida_em, "A data da decisão");
  const cat = (bruto.numero_cat_siass ?? "").trim();
  if (cat && (cat.length > 40 || !/^[A-Za-z0-9]+([./-][A-Za-z0-9]+)*$/.test(cat))) throw new SiassRecusado("O número da CAT no SIASS só leva letras, números, ponto, barra e hífen.");
  const observacao = _texto(bruto.observacao, "a observação pericial", 1000);
  const [vigente] = await tx
    .select()
    .from(acidente_decisao_pericial)
    .where(eq(acidente_decisao_pericial.ocorrencia_id, ocorrencia.id))
    .orderBy(desc(acidente_decisao_pericial.id))
    .limit(1);
  const [linha] = await tx
    .insert(acidente_decisao_pericial)
    .values({
      ocorrencia_id: ocorrencia.id,
      resultado: bruto.resultado,
      decidida_em,
      numero_cat_siass: cat || null,
      observacao,
      registrada_por: usuario.id,
      substitui_id: vigente?.id ?? null,
    })
    .returning();
  await _fechar(tx, `ACIDENTE_AGUARDA_PERICIA:${ocorrencia.id}`, usuario);
  await auditoria.registrar(tx, {
    entidade: ENTIDADE,
    entidade_id: ocorrencia.id,
    tipo_evento: auditoria.ACIDENTE_DECISAO_PERICIAL,
    descricao: `${ocorrencia.protocolo}: decisão da perícia ${vigente ? "corrigida" : "registrada"} (${ROTULO_RESULTADO_PERICIA[bruto.resultado]}).`,
    usuario,
  });
  return linha!;
}

// ---------------------------------------------------------------------
// Concluir
// ---------------------------------------------------------------------
export async function concluir(tx: Executor, usuario: UsuarioAtual, ocorrencia: Ocorrencia, motivo: string | null, versao: number) {
  usuario.exigir("acidente.siass");
  const de = ocorrencia.estado;
  if (de !== "ENCAMINHADA_SIASS" && de !== "RELATORIO_EMITIDO") {
    throw new SiassRecusado(de === "CONCLUIDA" ? "O caso já está concluído." : "O caso só se conclui depois de emitido o relatório.");
  }
  const porque = _texto(motivo, "o motivo da conclusão", 2000);
  const [decisao] = await tx
    .select({ id: acidente_decisao_pericial.id })
    .from(acidente_decisao_pericial)
    .where(eq(acidente_decisao_pericial.ocorrencia_id, ocorrencia.id))
    .limit(1);
  if (de === "ENCAMINHADA_SIASS") {
    if (!decisao && !porque) {
      throw new SiassRecusado("Registre a decisão da perícia ou diga o motivo de concluir sem ela.");
    }
  } else {
    const inv = await investigacao.obter(tx, ocorrencia);
    if (inv.requer_cat_siass !== "NAO") {
      throw new SiassRecusado("Sem encaminhar ao SIASS só se conclui o caso que a investigação marcou como «não requer CAT no SIASS».");
    }
    if (!porque) throw new SiassRecusado("Diga o motivo de concluir sem encaminhar ao SIASS.");
  }
  await _mudar_estado(tx, usuario, ocorrencia, "CONCLUIDA", versao, { concluida_em: new Date(), conclusao_motivo: porque });
  await _fechar(tx, `ACIDENTE_PRAZO_COMUNICACAO:${ocorrencia.id}`, usuario);
  await _fechar(tx, `ACIDENTE_AGUARDA_PERICIA:${ocorrencia.id}`, usuario);
  await auditoria.registrar(tx, {
    entidade: ENTIDADE,
    entidade_id: ocorrencia.id,
    tipo_evento: auditoria.ACIDENTE_CONCLUIDO,
    descricao: `${ocorrencia.protocolo}: ocorrência concluída${decisao ? " (com decisão pericial)" : " sem decisão pericial"}.`,
    usuario,
  });
}

// ---------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------
export async function situacao(tx: Executor, ocorrencia_id: number) {
  const encaminhamentos = await tx
    .select({
      id: acidente_encaminhamento.id,
      meio: acidente_encaminhamento.meio,
      nup_sei: acidente_encaminhamento.nup_sei,
      encaminhado_em: acidente_encaminhamento.encaminhado_em,
      observacao: acidente_encaminhamento.observacao,
      relatorio_versao: acidente_relatorio.versao,
      por: tabela_usuario.nome,
    })
    .from(acidente_encaminhamento)
    .innerJoin(acidente_relatorio, eq(acidente_relatorio.id, acidente_encaminhamento.relatorio_id))
    .innerJoin(tabela_usuario, eq(tabela_usuario.id, acidente_encaminhamento.encaminhado_por))
    .where(eq(acidente_encaminhamento.ocorrencia_id, ocorrencia_id))
    .orderBy(asc(acidente_encaminhamento.id));
  const decisoes = await tx
    .select({
      id: acidente_decisao_pericial.id,
      resultado: acidente_decisao_pericial.resultado,
      decidida_em: acidente_decisao_pericial.decidida_em,
      numero_cat_siass: acidente_decisao_pericial.numero_cat_siass,
      observacao: acidente_decisao_pericial.observacao,
      substitui_id: acidente_decisao_pericial.substitui_id,
      por: tabela_usuario.nome,
    })
    .from(acidente_decisao_pericial)
    .innerJoin(tabela_usuario, eq(tabela_usuario.id, acidente_decisao_pericial.registrada_por))
    .where(eq(acidente_decisao_pericial.ocorrencia_id, ocorrencia_id))
    .orderBy(asc(acidente_decisao_pericial.id));
  const substituidas = new Set(decisoes.map((d) => d.substitui_id).filter((v): v is number => v !== null));
  return { encaminhamentos, decisoes: decisoes.map((d) => ({ ...d, vigente: !substituidas.has(d.id) })) };
}
