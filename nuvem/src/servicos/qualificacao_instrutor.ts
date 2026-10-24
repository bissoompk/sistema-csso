/**
 * A qualificação do instrutor (24/10/2026): a formação que o habilita a
 * ministrar um treinamento, com o comprovante.
 *
 * NR-10, NR-33 e NR-35 cobram que o instrutor seja comprovadamente
 * qualificado. O sistema guarda a qualificação (`instrutor_qualificacao`), o
 * comprovante (anexo `QUALIFICACAO_INSTRUTOR`, restrito a quem gerencia
 * instrutores — `anexo_acesso.ts`) e faz duas coisas com ela:
 *
 * - **avisa ao escalar.** O instrutor sem qualificação ativa que habilite
 *   aquele treinamento, válida em todo o período da turma, leva um aviso na
 *   ficha da turma e na mensagem do "Vincular". **Não bloqueia**: há
 *   treinamento que a norma não exige de instrutor formado, e o setor decide.
 *   Treinamento sem norma e sem qualificação vinculada a ele (de instrutor
 *   nenhum) não gera aviso — não há o que conferir;
 * - **avisa o vencimento.** A pendência `INSTRUTOR_QUALIFICACAO_A_VENCER`
 *   nasce 30 dias antes de `valida_ate` (prazo = a própria validade, sem
 *   responsável: é do setor), pela rotina noturna e também no gesto que
 *   cadastra, e se fecha sozinha quando a qualificação é renovada (outra
 *   qualificação ativa do mesmo instrutor, para o mesmo fim, que vale além
 *   desta) ou inativada.
 *
 * "Habilita" é: a qualificação aponta para o treinamento, ou a norma dela é
 * uma das normas de `treinamento.norma_referencia`. A comparação de norma
 * ignora acento, caixa, espaço e pontuação ("NR-35" = "nr 35" = "NR35"), e a
 * referência do treinamento pode listar várias ("NR-10 / NR-35").
 *
 * A descrição da pendência não leva nome: a tarefa circula no sino do setor
 * (como a de reciclagem); o link leva à ficha do instrutor.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  agora_utc,
  assinatura_instrutor as tabela_assinatura,
  instrutor_qualificacao as tabela_qualificacao,
  pendencia as tabela_pendencia,
  treinamento as tabela_treinamento,
} from "../db/esquema/index.js";
import { somar_dias } from "../dominio/datas.js";
import { AssinaturaInstrutor } from "../dominio/treinamento.js";
import { RegraViolada } from "../nucleo/erros.js";
import * as anexos from "./anexos.js";
import * as auditoria from "./auditoria.js";
import * as datas_br from "./datas_br.js";
import * as pendencias from "./pendencias.js";
import type { UsuarioAtual } from "./rbac.js";
import { sem_acento } from "./textos.js";

export type Qualificacao = typeof tabela_qualificacao.$inferSelect;

/** A permissão que cadastra, inativa e baixa: a mesma da tela de instrutores. */
export const PERMISSAO = "assinatura.gerenciar";
export const ENTIDADE = "instrutor_qualificacao";
export const CATEGORIA_ANEXO = "QUALIFICACAO_INSTRUTOR";
export const TIPO_PENDENCIA = "INSTRUTOR_QUALIFICACAO_A_VENCER";
/** A janela do aviso: a mesma da reciclagem de certificado. */
export const DIAS_AVISO = 30;

export class QualificacaoRecusada extends RegraViolada {}

export function chave_da_pendencia(q: { id: number }): string {
  return `instrutor-qualificacao-${q.id}-a-vencer`;
}

// ---------------------------------------------------------------------
// Regras puras
// ---------------------------------------------------------------------
/** "NR-35" -> "NR35": sem acento, maiúscula, só letra e dígito. */
export function normalizar_norma(texto: string | null | undefined): string {
  return sem_acento(texto).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** As normas que a referência do treinamento lista ("NR-10 / NR-35", "NR-33; NR-35", "NR-10 e NR-35"). */
export function normas_da_referencia(texto: string | null | undefined): Set<string> {
  const saida = new Set<string>();
  for (const pedaco of (texto ?? "").split(/[\/,;+]|\s+e\s+/i)) {
    const n = normalizar_norma(pedaco);
    if (n) saida.add(n);
  }
  return saida;
}

type TreinamentoAlvo = { id: number; norma_referencia: string | null };
type QualificacaoAlvo = Pick<
  Qualificacao,
  "id" | "instrutor_id" | "treinamento_id" | "norma" | "data_emissao" | "valida_ate" | "ativo"
>;

/** A qualificação serve a este treinamento — pelo vínculo direto ou pela norma. */
export function habilita(q: Pick<QualificacaoAlvo, "treinamento_id" | "norma">, t: TreinamentoAlvo): boolean {
  if (q.treinamento_id !== null && q.treinamento_id === t.id) return true;
  const norma = normalizar_norma(q.norma);
  return Boolean(norma) && normas_da_referencia(t.norma_referencia).has(norma);
}

/** Ativa, emitida até o primeiro dia e válida até o último: vale a turma inteira. */
export function cobre(q: Pick<QualificacaoAlvo, "ativo" | "data_emissao" | "valida_ate">, inicio: string, fim: string): boolean {
  return q.ativo && q.data_emissao <= inicio && (q.valida_ate === null || q.valida_ate >= fim);
}

/** Duas qualificações para o mesmo fim: o mesmo treinamento, ou a mesma norma. */
export function mesmo_fim(a: Pick<QualificacaoAlvo, "treinamento_id" | "norma">, b: Pick<QualificacaoAlvo, "treinamento_id" | "norma">): boolean {
  if (a.treinamento_id !== null && a.treinamento_id === b.treinamento_id) return true;
  const na = normalizar_norma(a.norma);
  return Boolean(na) && na === normalizar_norma(b.norma);
}

/** Há outra qualificação ativa do mesmo instrutor, para o mesmo fim, que vale além desta. */
export function renovada(q: QualificacaoAlvo, todas: readonly QualificacaoAlvo[]): boolean {
  if (q.valida_ate === null) return false;
  return todas.some(
    (r) =>
      r.id !== q.id &&
      r.ativo &&
      r.instrutor_id === q.instrutor_id &&
      mesmo_fim(q, r) &&
      (r.valida_ate === null || r.valida_ate > q.valida_ate!),
  );
}

export type CodigoSituacao = "INATIVA" | "SEM_VALIDADE" | "VALIDA" | "A_VENCER" | "VENCIDA";

export interface Situacao {
  codigo: CodigoSituacao;
  rotulo: string;
  /** dias até o vencimento (A_VENCER) */
  dias: number | null;
}

function _dias_entre(de: string, ate: string): number {
  return Math.round((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86_400_000);
}

/** A pílula da lista: válida / vence em N dias / vencida / sem validade (ou inativa). */
export function situacao(q: Pick<Qualificacao, "ativo" | "valida_ate">, hoje: string): Situacao {
  if (!q.ativo) return { codigo: "INATIVA", rotulo: "inativa", dias: null };
  if (q.valida_ate === null) return { codigo: "SEM_VALIDADE", rotulo: "sem validade", dias: null };
  if (q.valida_ate < hoje) return { codigo: "VENCIDA", rotulo: "vencida", dias: null };
  const dias = _dias_entre(hoje, q.valida_ate);
  if (dias <= DIAS_AVISO) {
    return { codigo: "A_VENCER", rotulo: dias === 0 ? "vence hoje" : dias === 1 ? "vence amanhã" : `vence em ${dias} dias`, dias };
  }
  return { codigo: "VALIDA", rotulo: "válida", dias };
}

/** O comprovante pelos PRIMEIROS BYTES (PDF, PNG, JPEG), não pelo nome nem pelo que o navegador declara. */
export function tipo_do_comprovante(conteudo: Uint8Array): string | null {
  const comeca = (assinatura: number[]) =>
    conteudo.byteLength >= assinatura.length && assinatura.every((b, i) => conteudo[i] === b);
  if (comeca([0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (comeca([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (comeca([0xff, 0xd8, 0xff])) return "image/jpeg";
  return null;
}

// ---------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------
export async function do_instrutor(tx: Executor, instrutor_id: number): Promise<Qualificacao[]> {
  return tx
    .select()
    .from(tabela_qualificacao)
    .where(eq(tabela_qualificacao.instrutor_id, instrutor_id))
    .orderBy(asc(tabela_qualificacao.ativo), asc(tabela_qualificacao.valida_ate), asc(tabela_qualificacao.id));
}

/** Quantas ativas e quantas pedem atenção (vencidas ou a vencer), por instrutor — para a lista. */
export async function resumo_por_instrutor(
  tx: Executor,
  hoje: string,
): Promise<Record<number, { ativas: number; atencao: number }>> {
  const linhas = await tx
    .select({ instrutor_id: tabela_qualificacao.instrutor_id, ativo: tabela_qualificacao.ativo, valida_ate: tabela_qualificacao.valida_ate })
    .from(tabela_qualificacao)
    .where(eq(tabela_qualificacao.ativo, true));
  const saida: Record<number, { ativas: number; atencao: number }> = {};
  for (const l of linhas) {
    const r = (saida[l.instrutor_id] ??= { ativas: 0, atencao: 0 });
    r.ativas += 1;
    const s = situacao(l, hoje).codigo;
    if (s === "VENCIDA" || s === "A_VENCER") r.atencao += 1;
  }
  return saida;
}

/** O treinamento exige conferir a qualificação: tem norma, ou alguma qualificação ativa aponta para ele. */
async function _exige(tx: Executor, t: TreinamentoAlvo): Promise<boolean> {
  if (normas_da_referencia(t.norma_referencia).size) return true;
  const [uma] = await tx
    .select({ id: tabela_qualificacao.id })
    .from(tabela_qualificacao)
    .where(and(eq(tabela_qualificacao.treinamento_id, t.id), eq(tabela_qualificacao.ativo, true)))
    .limit(1);
  return Boolean(uma);
}

interface TurmaAlvo {
  data_inicio: string;
  data_fim: string;
  treinamento: TreinamentoAlvo & { nome: string };
}

function _frase(nome: string, turma: TurmaAlvo, tem_alguma: boolean): string {
  const periodo =
    turma.data_inicio === turma.data_fim
      ? `em ${datas_br.numerica(turma.data_inicio)}`
      : `de ${datas_br.numerica(turma.data_inicio)} a ${datas_br.numerica(turma.data_fim)}`;
  const norma = (turma.treinamento.norma_referencia ?? "").trim();
  const alvo = `${turma.treinamento.nome}${norma ? ` (${norma})` : ""}`;
  return tem_alguma
    ? `${nome} tem qualificação para ${alvo}, mas nenhuma ativa válida ${periodo}. Confira o comprovante renovado.`
    : `${nome} não tem qualificação cadastrada que o habilite para ${alvo}. Se a norma exige instrutor qualificado, cadastre o comprovante na ficha do instrutor.`;
}

/**
 * `{instrutor_id: aviso}` dos instrutores sem qualificação para a turma. Vazio
 * quando o treinamento não pede conferência, ou todos estão cobertos.
 */
export async function avisos_da_turma(
  tx: Executor,
  turma: TurmaAlvo,
  instrutores: readonly { id: number; nome: string; servidor?: { nome: string } | null }[],
): Promise<Record<number, string>> {
  const saida: Record<number, string> = {};
  if (!instrutores.length || !(await _exige(tx, turma.treinamento))) return saida;
  const todas = await tx
    .select()
    .from(tabela_qualificacao)
    .where(inArray(tabela_qualificacao.instrutor_id, instrutores.map((i) => i.id)));
  for (const i of instrutores) {
    const que_habilitam = todas.filter((q) => q.instrutor_id === i.id && q.ativo && habilita(q, turma.treinamento));
    if (que_habilitam.some((q) => cobre(q, turma.data_inicio, turma.data_fim))) continue;
    saida[i.id] = _frase(AssinaturaInstrutor.nome_exibicao(i), turma, que_habilitam.length > 0);
  }
  return saida;
}

/** O aviso de UM instrutor ao escalá-lo, ou null. */
export async function aviso_ao_escalar(
  tx: Executor,
  turma: TurmaAlvo,
  instrutor: { id: number; nome: string; servidor?: { nome: string } | null },
): Promise<string | null> {
  return (await avisos_da_turma(tx, turma, [instrutor]))[instrutor.id] ?? null;
}

// ---------------------------------------------------------------------
// Escrita
// ---------------------------------------------------------------------
export interface DadosQualificacao {
  descricao: string;
  treinamento_id: number | null;
  norma: string | null;
  instituicao: string;
  data_emissao: string | null;
  valida_ate: string | null;
}

export interface Comprovante {
  nome: string;
  conteudo: Uint8Array;
}

/**
 * Cadastra a qualificação com o comprovante. As recusas usam o rótulo da tela.
 * Depois, a pendência do instrutor se acerta (a renovação fecha a anterior).
 */
export async function cadastrar(
  tx: Executor,
  usuario: UsuarioAtual,
  instrutor_id: number,
  d: DadosQualificacao,
  comprovante: Comprovante | null,
  hoje: string = datas_br.hoje(),
): Promise<Qualificacao> {
  usuario.exigir(PERMISSAO);
  const instrutor = await tx.query.assinatura_instrutor.findFirst({
    where: eq(tabela_assinatura.id, instrutor_id),
    with: { servidor: true },
  });
  if (!instrutor) throw new QualificacaoRecusada("Instrutor não encontrado.");
  const descricao = d.descricao.trim();
  if (!descricao) throw new QualificacaoRecusada("Informe a descrição da qualificação.");
  const instituicao = d.instituicao.trim();
  if (!instituicao) throw new QualificacaoRecusada("Informe a instituição emissora.");
  const norma = (d.norma ?? "").trim() || null;
  if (d.treinamento_id === null && !norma) {
    throw new QualificacaoRecusada("Informe o treinamento que ela habilita, a norma, ou os dois.");
  }
  if (norma && !normalizar_norma(norma)) throw new QualificacaoRecusada("Norma inválida.");
  if (d.treinamento_id !== null) {
    const [t] = await tx.select({ id: tabela_treinamento.id }).from(tabela_treinamento).where(eq(tabela_treinamento.id, d.treinamento_id));
    if (!t) throw new QualificacaoRecusada("Treinamento não encontrado.");
  }
  if (!d.data_emissao) throw new QualificacaoRecusada("Data de emissão inválida.");
  if (d.data_emissao > hoje) throw new QualificacaoRecusada("A data de emissão não pode ser futura.");
  if (d.valida_ate !== null && d.valida_ate < d.data_emissao) {
    throw new QualificacaoRecusada("A validade não pode ser anterior à data de emissão.");
  }
  if (!comprovante || comprovante.conteudo.byteLength === 0) {
    throw new QualificacaoRecusada("Envie o comprovante (PDF ou imagem PNG/JPEG).");
  }
  if (comprovante.conteudo.byteLength > anexos.LIMITE_BYTES) throw new anexos.AnexoGrandeDemais(comprovante.conteudo.byteLength);
  const tipo = tipo_do_comprovante(comprovante.conteudo);
  if (tipo === null) throw new QualificacaoRecusada("O comprovante precisa ser um PDF ou uma imagem PNG/JPEG.");

  const [q] = await tx
    .insert(tabela_qualificacao)
    .values({
      instrutor_id,
      descricao,
      treinamento_id: d.treinamento_id,
      norma,
      instituicao,
      data_emissao: d.data_emissao,
      valida_ate: d.valida_ate,
      criado_por: usuario.id,
    })
    .returning();
  const extensao = tipo === "application/pdf" ? "pdf" : tipo === "image/png" ? "png" : "jpg";
  const { anexo } = await anexos.guardar(tx, {
    entidade: ENTIDADE,
    entidade_id: q!.id,
    nome_original: comprovante.nome || `comprovante.${extensao}`,
    conteudo: comprovante.conteudo,
    mime_type: tipo,
    categoria: CATEGORIA_ANEXO,
    usuario,
  });
  await tx.update(tabela_qualificacao).set({ comprovante_anexo_id: anexo.id }).where(eq(tabela_qualificacao.id, q!.id));
  q!.comprovante_anexo_id = anexo.id;
  await auditoria.registrar(tx, {
    entidade: ENTIDADE,
    entidade_id: q!.id,
    tipo_evento: "INSTRUTOR_QUALIFICACAO_CADASTRADA",
    descricao:
      `${AssinaturaInstrutor.nome_exibicao(instrutor)}: ${descricao} · ${instituicao} · emitida em ` +
      `${datas_br.numerica(d.data_emissao)}` +
      (d.valida_ate ? `, válida até ${datas_br.numerica(d.valida_ate)}` : ", sem validade") +
      ` (comprovante SHA-256 ${anexo.sha256.slice(0, 12)}…)`,
    valor_novo: { treinamento_id: d.treinamento_id, norma, data_emissao: d.data_emissao, valida_ate: d.valida_ate },
    usuario,
  });
  await sincronizar_pendencias(tx, hoje, instrutor_id);
  return q!;
}

/** Inativa (não apaga): sai do aviso ao escalar, e a pendência dela se fecha. */
export async function inativar(
  tx: Executor,
  usuario: UsuarioAtual,
  instrutor_id: number,
  qualificacao_id: number,
  hoje: string = datas_br.hoje(),
): Promise<Qualificacao> {
  usuario.exigir(PERMISSAO);
  const [q] = await tx
    .select()
    .from(tabela_qualificacao)
    .where(and(eq(tabela_qualificacao.id, qualificacao_id), eq(tabela_qualificacao.instrutor_id, instrutor_id)));
  if (!q) throw new QualificacaoRecusada("Qualificação não encontrada.");
  if (!q.ativo) return q;
  const mudanca = { ativo: false, inativado_por: usuario.id, inativado_em: agora_utc() };
  await tx.update(tabela_qualificacao).set(mudanca).where(eq(tabela_qualificacao.id, q.id));
  Object.assign(q, mudanca);
  await auditoria.registrar(tx, {
    entidade: ENTIDADE,
    entidade_id: q.id,
    tipo_evento: "INSTRUTOR_QUALIFICACAO_INATIVADA",
    descricao: `${q.descricao} · ${q.instituicao} (instrutor nº ${q.instrutor_id}) inativada`,
    usuario,
  });
  await sincronizar_pendencias(tx, hoje, instrutor_id);
  return q;
}

// ---------------------------------------------------------------------
// Pendência de vencimento
// ---------------------------------------------------------------------
export interface ResultadoVarredura {
  abertas: number;
  fechadas: number;
}

/**
 * Abre o aviso da qualificação que entrou na janela de 30 dias e fecha o da
 * que foi renovada ou inativada (ou cujo instrutor foi inativado). Idempotente
 * pela chave: a qualificação que já teve aviso não ganha outro. Só abre para
 * quem ainda não venceu — a vencida de anos atrás aparece na ficha, mas não
 * vira enxurrada de tarefas no dia em que a rotina começa a rodar.
 *
 * Sem `instrutor_id`, olha todas (a rotina noturna); com ele, só as daquele
 * instrutor (o gesto que cadastra ou inativa).
 */
export async function sincronizar_pendencias(
  tx: Executor,
  hoje: string,
  instrutor_id: number | null = null,
): Promise<ResultadoVarredura> {
  const resultado: ResultadoVarredura = { abertas: 0, fechadas: 0 };
  const todas = await tx
    .select({ q: tabela_qualificacao, instrutor_ativo: tabela_assinatura.ativo })
    .from(tabela_qualificacao)
    .innerJoin(tabela_assinatura, eq(tabela_assinatura.id, tabela_qualificacao.instrutor_id))
    .where(instrutor_id === null ? undefined : eq(tabela_qualificacao.instrutor_id, instrutor_id));
  const lista = todas.map((l) => l.q);
  const instrutor_ativo = new Map(todas.map((l) => [l.q.instrutor_id, l.instrutor_ativo]));
  const motivo_de_fechar = (q: Qualificacao): string | null => {
    if (!q.ativo) return "a qualificação foi inativada";
    if (!instrutor_ativo.get(q.instrutor_id)) return "o instrutor foi inativado";
    if (renovada(q, lista)) return "a qualificação foi renovada";
    return null;
  };
  const limite = somar_dias(hoje, DIAS_AVISO);
  for (const q of lista) {
    if (q.valida_ate === null || q.valida_ate < hoje || q.valida_ate > limite) continue;
    if (motivo_de_fechar(q) !== null) continue;
    const chave = chave_da_pendencia(q);
    const [ja] = await tx.select({ id: tabela_pendencia.id }).from(tabela_pendencia).where(eq(tabela_pendencia.chave, chave));
    if (ja) continue;
    await pendencias.abrir(tx, {
      tipo: TIPO_PENDENCIA,
      chave,
      descricao:
        `Qualificação «${q.descricao}» (${q.instituicao}) do instrutor nº ${q.instrutor_id} vence em ` +
        `${datas_br.numerica(q.valida_ate)}. Cadastre o comprovante renovado.`,
      entidade: ENTIDADE,
      entidade_id: q.id,
      prazo: q.valida_ate,
    });
    resultado.abertas += 1;
  }
  const por_id = new Map(lista.map((q) => [q.id, q]));
  const abertas = await tx
    .select()
    .from(tabela_pendencia)
    .where(and(eq(tabela_pendencia.tipo, TIPO_PENDENCIA), eq(tabela_pendencia.concluida, false)));
  for (const p of abertas) {
    const q = p.entidade_id === null ? undefined : por_id.get(p.entidade_id);
    // fora do recorte deste instrutor: não é desta passada
    if (!q) {
      if (instrutor_id !== null) continue;
      await pendencias.concluir_pela_rotina(tx, p, "a qualificação não existe mais");
      resultado.fechadas += 1;
      continue;
    }
    const motivo = motivo_de_fechar(q);
    if (motivo === null) continue;
    await pendencias.concluir_pela_rotina(tx, p, motivo);
    resultado.fechadas += 1;
  }
  return resultado;
}
