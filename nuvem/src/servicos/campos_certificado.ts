/**
 * NUVEM (não existe no Python): os marcadores do modelo que não são campo do
 * sistema.
 *
 * - **Texto fixo**: digitado na ficha do modelo, vale para todo certificado
 *   ("10 (dez) tempos").
 * - **Campo da turma**: o modelo declara o rótulo ("Local de atuação do
 *   brigadista"); cada turma que emite com ele preenche o valor.
 * - **Campo do participante**: idem, por inscrição ("Nota – Primeiros
 *   socorros"). É dado pessoal: lê-se e grava-se com a regra da nota final.
 *
 * Os valores são guardados pelo MARCADOR (e não pela linha do dicionário): a
 * versão nova do modelo clona o dicionário e o que já foi digitado continua
 * valendo. Na emissão tudo é resolvido e congelado em
 * `ContextoCertificado.campos_livres` — certificado emitido não muda depois.
 */
import { and, desc, eq, inArray, or } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  agora_utc,
  certificado_valor_inscricao as tabela_valor_inscricao,
  certificado_valor_turma as tabela_valor_turma,
  historico_evento,
  inscricao as tabela_inscricao,
} from "../db/esquema/index.js";
import { ROTULO_TIPO_TAG, TIPOS_TAG, type TipoTag } from "../dominio/treinamento.js";
import { PermissaoNegada } from "../nucleo/erros.js";
import * as auditoria from "./auditoria.js";
import type { CampoLivreCongelado } from "./certificado.js";
import { CAMPOS_CERTIFICADO } from "./certificado.js";
import { certificado_ativo } from "./presenca.js";
import type { UsuarioAtual } from "./rbac.js";
import { RegraDaTurma, type InscricaoCarregada, type ModeloCarregado, type TurmaCarregada } from "./turma.js";

export const CAMPO_TURMA_ALTERADO = "CERTIFICADO_CAMPO_TURMA_ALTERADO";
export const CAMPO_PARTICIPANTE_ALTERADO = "CERTIFICADO_CAMPO_PARTICIPANTE_ALTERADO";

// quem preenche os campos da turma: quem edita a turma ou quem emite
export const PERMISSOES_CAMPO_TURMA = ["turma.criar", "certificado.emitir"] as const;
// os do participante seguem a nota final (`presenca.lancar_nota`)
export const PERMISSAO_CAMPO_PARTICIPANTE = "turma.avaliar";

export const TAMANHO_MAXIMO_VALOR = 2000;

type Tag = ModeloCarregado["tags"][number];
type TagMinima = Pick<Tag, "marcador" | "tipo" | "rotulo" | "texto_fixo" | "obrigatorio" | "campo">;

/** O tipo da linha; linha antiga (sem a coluna) é campo do sistema. */
export function tipo_de(tag: { tipo?: string | null }): TipoTag {
  return ((tag.tipo ?? "SISTEMA") as TipoTag) || "SISTEMA";
}

export function campos_da_turma<T extends TagMinima>(modelo: { tags: readonly T[] } | null): T[] {
  return modelo ? modelo.tags.filter((t) => tipo_de(t) === "TURMA") : [];
}

export function campos_do_participante<T extends TagMinima>(modelo: { tags: readonly T[] } | null): T[] {
  return modelo ? modelo.tags.filter((t) => tipo_de(t) === "PARTICIPANTE") : [];
}

/** Rótulo para a tela e para a mensagem: o declarado, ou o próprio marcador. */
export function rotulo_de(tag: TagMinima): string {
  if (tipo_de(tag) === "SISTEMA") return CAMPOS_CERTIFICADO[tag.campo]?.rotulo ?? tag.campo;
  if (tipo_de(tag) === "TEXTO_FIXO") return tag.rotulo || `texto fixo de ${tag.marcador}`;
  return tag.rotulo || tag.marcador;
}

// ---------------------------------------------------------------------
// A linha do dicionário (ficha do modelo)
// ---------------------------------------------------------------------
export interface DadosDaTag {
  tipo: TipoTag;
  campo: string;
  texto_fixo: string | null;
  rotulo: string | null;
}

/**
 * Confere o que foi digitado para uma linha do dicionário e devolve as colunas
 * — ou a frase da recusa. Campo do sistema continua fechado no vocabulário.
 */
export function dados_da_tag(d: {
  tipo?: string | null;
  campo?: string | null;
  texto_fixo?: string | null;
  rotulo?: string | null;
}): [DadosDaTag | null, string] {
  const tipo = ((d.tipo ?? "").trim() || "SISTEMA") as TipoTag;
  if (!(TIPOS_TAG as readonly string[]).includes(tipo)) return [null, `Tipo de preenchimento inválido: '${tipo}'.`];
  const rotulo = (d.rotulo ?? "").trim().slice(0, 120) || null;
  if (tipo === "SISTEMA") {
    const campo = (d.campo ?? "").trim();
    // nunca chutar a chave: campo desconhecido sairia em branco no papel
    if (!Object.hasOwn(CAMPOS_CERTIFICADO, campo)) return [null, `Campo desconhecido: '${campo}'.`];
    return [{ tipo, campo, texto_fixo: null, rotulo: null }, ""];
  }
  if (tipo === "TEXTO_FIXO") {
    const texto = (d.texto_fixo ?? "").replace(/\r\n/g, "\n").trim();
    if (!texto) return [null, "Digite o texto fixo — é ele que sai no certificado."];
    if (texto.length > TAMANHO_MAXIMO_VALOR) return [null, `Texto fixo com mais de ${TAMANHO_MAXIMO_VALOR} caracteres.`];
    return [{ tipo, campo: "", texto_fixo: texto, rotulo }, ""];
  }
  if (!rotulo) {
    return [null, `Dê um nome ao ${ROTULO_TIPO_TAG[tipo].toLowerCase()} — é o que aparece no formulário da turma.`];
  }
  return [{ tipo, campo: "", texto_fixo: null, rotulo }, ""];
}

/** "campo do sistema: Nome do participante", "campo da turma: Local…" — para a trilha. */
export function descrever_tag(tag: TagMinima): string {
  const tipo = tipo_de(tag);
  if (tipo === "SISTEMA") return tag.campo;
  if (tipo === "TEXTO_FIXO") return `texto fixo “${(tag.texto_fixo ?? "").slice(0, 60)}”`;
  return `${ROTULO_TIPO_TAG[tipo].toLowerCase()} “${tag.rotulo ?? ""}”`;
}

// ---------------------------------------------------------------------
// Leitura dos valores
// ---------------------------------------------------------------------
export type Valores = Record<string, string>;

export async function valores_da_turma(tx: Executor, turma_id: number): Promise<Valores> {
  const linhas = await tx
    .select({ marcador: tabela_valor_turma.marcador, valor: tabela_valor_turma.valor })
    .from(tabela_valor_turma)
    .where(eq(tabela_valor_turma.turma_id, turma_id));
  return Object.fromEntries(linhas.map((l) => [l.marcador, l.valor]));
}

/** `{inscricao_id: {marcador: valor}}` — uma consulta para a aba toda. */
export async function valores_das_inscricoes(tx: Executor, inscricao_ids: number[]): Promise<Record<number, Valores>> {
  const saida: Record<number, Valores> = {};
  if (!inscricao_ids.length) return saida;
  const linhas = await tx
    .select()
    .from(tabela_valor_inscricao)
    .where(inArray(tabela_valor_inscricao.inscricao_id, inscricao_ids));
  for (const l of linhas) (saida[l.inscricao_id] ??= {})[l.marcador] = l.valor;
  return saida;
}

/** O mesmo, para todas as inscrições de uma turma (sem precisar dos ids antes). */
export async function valores_dos_inscritos(tx: Executor, turma_id: number): Promise<Record<number, Valores>> {
  const linhas = await tx
    .select({
      inscricao_id: tabela_valor_inscricao.inscricao_id,
      marcador: tabela_valor_inscricao.marcador,
      valor: tabela_valor_inscricao.valor,
    })
    .from(tabela_valor_inscricao)
    .innerJoin(tabela_inscricao, eq(tabela_inscricao.id, tabela_valor_inscricao.inscricao_id))
    .where(eq(tabela_inscricao.turma_id, turma_id));
  const saida: Record<number, Valores> = {};
  for (const l of linhas) (saida[l.inscricao_id] ??= {})[l.marcador] = l.valor;
  return saida;
}

/**
 * A trilha dos campos de certificado da turma: os da turma e os de cada
 * inscrição, mais nova primeiro.
 */
export async function trilha_da_turma(tx: Executor, turma_id: number, limite = 50) {
  const ids = tx.select({ id: tabela_inscricao.id }).from(tabela_inscricao).where(eq(tabela_inscricao.turma_id, turma_id));
  return tx
    .select()
    .from(historico_evento)
    .where(
      or(
        and(
          eq(historico_evento.entidade, "turma"),
          eq(historico_evento.entidade_id, turma_id),
          eq(historico_evento.tipo_evento, CAMPO_TURMA_ALTERADO),
        ),
        and(
          eq(historico_evento.entidade, "inscricao"),
          inArray(historico_evento.entidade_id, ids),
          eq(historico_evento.tipo_evento, CAMPO_PARTICIPANTE_ALTERADO),
        ),
      ),
    )
    .orderBy(desc(historico_evento.id))
    .limit(limite);
}

// ---------------------------------------------------------------------
// Resolução (emissão e validação)
// ---------------------------------------------------------------------
/** `{marcador: {tipo, rotulo, valor}}` de toda linha que não é campo do sistema. */
export function resolver(
  modelo: { tags: readonly TagMinima[] },
  da_turma: Valores,
  do_participante: Valores,
): Record<string, CampoLivreCongelado> {
  const saida: Record<string, CampoLivreCongelado> = {};
  for (const tag of modelo.tags) {
    const tipo = tipo_de(tag);
    if (tipo === "SISTEMA") continue;
    const valor =
      tipo === "TEXTO_FIXO"
        ? (tag.texto_fixo ?? "")
        : tipo === "TURMA"
          ? (da_turma[tag.marcador] ?? "")
          : (do_participante[tag.marcador] ?? "");
    saida[tag.marcador] = { tipo, rotulo: rotulo_de(tag), valor };
  }
  return saida;
}

/** As frases de bloqueio: campo obrigatório que sairia em branco. */
export function pendencias(modelo: { tags: readonly TagMinima[] }, livres: Record<string, CampoLivreCongelado>): string[] {
  const motivos: string[] = [];
  for (const tag of modelo.tags) {
    if (!tag.obrigatorio) continue;
    const livre = livres[tag.marcador];
    if (!livre || livre.valor.trim()) continue;
    if (livre.tipo === "TURMA") motivos.push(`falta preencher “${livre.rotulo}” da turma (aba Emissão)`);
    else if (livre.tipo === "PARTICIPANTE") motivos.push(`falta preencher “${livre.rotulo}” deste participante (aba Emissão)`);
    else motivos.push(`o texto fixo de ${tag.marcador} está em branco no modelo`);
  }
  return motivos;
}

// ---------------------------------------------------------------------
// Gravação
// ---------------------------------------------------------------------
function _limpo(valor: string | null | undefined): string {
  const texto = (valor ?? "").replace(/\r\n/g, "\n").trim();
  if (texto.length > TAMANHO_MAXIMO_VALOR) {
    throw new RegraDaTurma(`Valor com mais de ${TAMANHO_MAXIMO_VALOR} caracteres.`);
  }
  return texto;
}

export function pode_preencher_turma(usuario: UsuarioAtual): boolean {
  return PERMISSOES_CAMPO_TURMA.some((p) => usuario.pode(p));
}

/**
 * Grava os campos da turma que o modelo declara; valor em branco apaga. Só
 * mexe nos marcadores do modelo, e cada mudança é um evento na trilha.
 * Devolve quantos mudaram.
 */
export async function gravar_valores_turma(
  tx: Executor,
  usuario: UsuarioAtual,
  turma: TurmaCarregada,
  modelo: ModeloCarregado,
  digitados: Valores,
): Promise<number> {
  if (!pode_preencher_turma(usuario)) throw new PermissaoNegada(PERMISSOES_CAMPO_TURMA[0]);
  const atuais = await valores_da_turma(tx, turma.id);
  let mudaram = 0;
  for (const tag of campos_da_turma(modelo)) {
    if (!Object.hasOwn(digitados, tag.marcador)) continue;
    const novo = _limpo(digitados[tag.marcador]);
    const antes = atuais[tag.marcador] ?? "";
    if (novo === antes) continue;
    if (!novo) {
      await tx
        .delete(tabela_valor_turma)
        .where(and(eq(tabela_valor_turma.turma_id, turma.id), eq(tabela_valor_turma.marcador, tag.marcador)));
    } else {
      await tx
        .insert(tabela_valor_turma)
        .values({ turma_id: turma.id, marcador: tag.marcador, valor: novo, atualizado_por: usuario.id })
        .onConflictDoUpdate({
          target: [tabela_valor_turma.turma_id, tabela_valor_turma.marcador],
          set: { valor: novo, atualizado_por: usuario.id, atualizado_em: agora_utc() },
        });
    }
    await auditoria.registrar(tx, {
      entidade: "turma",
      entidade_id: turma.id,
      tipo_evento: CAMPO_TURMA_ALTERADO,
      descricao: `${turma.codigo} · ${rotulo_de(tag)}`,
      campo: tag.marcador,
      valor_anterior: antes || null,
      valor_novo: novo || null,
      usuario,
    });
    mudaram += 1;
  }
  return mudaram;
}

/**
 * Grava os campos do participante de UMA inscrição. A regra é a da nota final:
 * `turma.avaliar`, e inscrição com certificado válido não se reescreve — o
 * documento que circulou se anula e se reemite.
 */
export async function gravar_valores_inscricao(
  tx: Executor,
  usuario: UsuarioAtual,
  inscricao: InscricaoCarregada,
  modelo: ModeloCarregado,
  digitados: Valores,
  atuais: Valores,
): Promise<number> {
  usuario.exigir(PERMISSAO_CAMPO_PARTICIPANTE);
  const tags = campos_do_participante(modelo).filter((t) => Object.hasOwn(digitados, t.marcador));
  const mudancas = tags
    .map((tag) => ({ tag, antes: atuais[tag.marcador] ?? "", novo: _limpo(digitados[tag.marcador]) }))
    .filter((m) => m.antes !== m.novo);
  if (!mudancas.length) return 0;
  if (inscricao.situacao === "CANCELADA") {
    throw new RegraDaTurma(`A inscrição ${inscricao.participante.identificador_publico} está cancelada.`);
  }
  const emitido = await certificado_ativo(tx, inscricao);
  if (emitido) {
    throw new RegraDaTurma(
      `${inscricao.participante.identificador_publico} já tem o certificado ${emitido.numero}/${emitido.ano}: ` +
        "certificado que saiu não se reescreve — anule-o com o motivo e reemita depois de corrigir.",
    );
  }
  for (const { tag, antes, novo } of mudancas) {
    if (!novo) {
      await tx
        .delete(tabela_valor_inscricao)
        .where(and(eq(tabela_valor_inscricao.inscricao_id, inscricao.id), eq(tabela_valor_inscricao.marcador, tag.marcador)));
    } else {
      await tx
        .insert(tabela_valor_inscricao)
        .values({ inscricao_id: inscricao.id, marcador: tag.marcador, valor: novo, atualizado_por: usuario.id })
        .onConflictDoUpdate({
          target: [tabela_valor_inscricao.inscricao_id, tabela_valor_inscricao.marcador],
          set: { valor: novo, atualizado_por: usuario.id, atualizado_em: agora_utc() },
        });
    }
    // RN-19 na escrita: o identificador público, nunca o nome
    await auditoria.registrar(tx, {
      entidade: "inscricao",
      entidade_id: inscricao.id,
      tipo_evento: CAMPO_PARTICIPANTE_ALTERADO,
      descricao: `${inscricao.turma.codigo} · ${inscricao.participante.identificador_publico} · ${rotulo_de(tag)}`,
      campo: tag.marcador,
      valor_anterior: antes || null,
      valor_novo: novo || null,
      usuario,
    });
  }
  return mudancas.length;
}
