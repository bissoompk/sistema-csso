/**
 * Turma e inscrição interna — as máquinas E e F. Porte de `app/servicos/turma.py`.
 *
 * Aqui mora tudo o que decide se uma mudança pode acontecer; a rota só traduz
 * formulário em chamada e erro em mensagem. Esconder botão nunca foi guarda:
 * toda recusa desta fatia está abaixo, e todo teste de recusa bate aqui.
 *
 * O que NÃO está aqui, de propósito: o lançamento de presença e de nota e a
 * apuração do resultado (`presenca.ts`), e o certificado (`emissao_certificado.ts`).
 * `mudar_situacao` conhece uma dessas: concluir a turma é um ato só — muda o
 * estado E apura cada inscrito, chamando `presenca.apurar_turma` na mesma
 * transação.
 *
 * **Forma do porte.** O Python recebia objetos do ORM com as relações
 * carregadas sob demanda; aqui a turma e a inscrição chegam carregadas pelos
 * `carregar_*` deste arquivo (`TurmaCarregada`, `InscricaoCarregada`), e toda
 * escrita atualiza o banco E o objeto em memória — o que o `flush` fazia.
 */
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  agora_utc,
  assinatura_instrutor as tabela_assinatura,
  campus as tabela_campus,
  certificado_modelo as tabela_modelo,
  certificado_modelo_tag as tabela_tag,
  inscricao as tabela_inscricao,
  participante as tabela_participante,
  pendencia as tabela_pendencia,
  servidor as tabela_servidor,
  treinamento as tabela_treinamento,
  turma as tabela_turma,
  turma_instrutor as tabela_turma_instrutor,
  turma_presenca as tabela_presenca,
  unidade_uorg as tabela_unidade,
} from "../db/esquema/index.js";
import {
  ESTADOS_INSCRICAO,
  INSCRICAO_OCUPA_VAGA,
  ROTULO_INSCRICAO,
  ROTULO_TURMA,
  exigir_transicao_inscricao,
  exigir_transicao_turma,
} from "../dominio/estados.js";
import { AssinaturaInstrutor, Turma as T } from "../dominio/treinamento.js";
import { RegraViolada } from "../nucleo/erros.js";
import * as auditoria from "./auditoria.js";
import * as datas_br from "./datas_br.js";
import * as numeracao from "./numeracao.js";
import * as pendencias from "./pendencias.js";
import * as servico_participante from "./participante.js";
import { COM_PARTICIPANTE, nome_exibicao, type ParticipanteCarregado } from "./participante.js";
import { ESCOPO_PROPRIO, aplicar_escopo, type UsuarioAtual } from "./rbac.js";
import { comparar } from "./presenca.js";

// Abrir inscrição e começar a turma são edição; concluir e cancelar são decisão
// de quem responde pela turma. Mesma simetria do parecer (§8 do desenho).
export const PERMISSAO_POR_SITUACAO_TURMA: Readonly<Record<string, string>> = {
  PLANEJADA: "turma.criar",
  INSCRICOES_ABERTAS: "turma.criar",
  EM_ANDAMENTO: "turma.criar",
  CONCLUIDA: "turma.concluir",
  CANCELADA: "turma.concluir",
};

// O que se escolhe para uma inscrição. PRESENTE, AUSENTE, APROVADO e REPROVADO
// NÃO estão aqui de propósito: são estados DERIVADOS do lançamento e do fecho.
export const PERMISSAO_POR_SITUACAO_INSCRICAO: Readonly<Record<string, string>> = {
  INSCRITA: "turma.inscrever",
  CONFIRMADA: "turma.inscrever",
  CANCELADA: "turma.inscrever",
};

export const SITUACAO_DERIVADA =
  "Presença, ausência e resultado não se digitam: saem do lançamento de " +
  "presença e do fecho da turma, na aba Presença e notas.";

/** Regra de negócio da turma ou da inscrição que a ação violaria. */
export class RegraDaTurma extends RegraViolada {}

// ---------------------------------------------------------------------
// Tipos carregados e leitores
// ---------------------------------------------------------------------
export type TurmaRegistro = typeof tabela_turma.$inferSelect;
export type InscricaoRegistro = typeof tabela_inscricao.$inferSelect;
export type PresencaRegistro = typeof tabela_presenca.$inferSelect;
export type TreinamentoRegistro = typeof tabela_treinamento.$inferSelect;
export type ModeloRegistro = typeof tabela_modelo.$inferSelect;
export type TagRegistro = typeof tabela_tag.$inferSelect;
export type AssinaturaRegistro = typeof tabela_assinatura.$inferSelect;

export type AssinaturaCarregada = AssinaturaRegistro & { servidor: typeof tabela_servidor.$inferSelect | null };
export type ModeloCarregado = ModeloRegistro & { tags: TagRegistro[] };
export type TreinamentoCarregado = TreinamentoRegistro & {
  modelo_vigente: ModeloCarregado | null;
  instrutor_padrao: AssinaturaRegistro | null;
};
export type VinculoInstrutor = typeof tabela_turma_instrutor.$inferSelect & { instrutor: AssinaturaCarregada };
export type TurmaCarregada = TurmaRegistro & {
  treinamento: TreinamentoCarregado;
  campus: typeof tabela_campus.$inferSelect | null;
  unidade_promotora: typeof tabela_unidade.$inferSelect | null;
  instrutores: VinculoInstrutor[];
};
export type InscricaoCarregada = InscricaoRegistro & {
  turma: TurmaCarregada;
  participante: ParticipanteCarregado;
  presencas: PresencaRegistro[];
};

/** O `mapa_de_tags` exige as tags na ordem (ordem, id) — o `order_by` do Python. */
export const COM_TAGS = {
  tags: { orderBy: (t: typeof tabela_tag, { asc: a }: { asc: typeof asc }) => [a(t.ordem), a(t.id)] },
} as const;

export const COM_TURMA = {
  treinamento: { with: { modelo_vigente: { with: COM_TAGS }, instrutor_padrao: true } },
  campus: true,
  unidade_promotora: true,
  instrutores: {
    orderBy: (v: typeof tabela_turma_instrutor, { asc: a }: { asc: typeof asc }) => [a(v.ordem)],
    with: { instrutor: { with: { servidor: true } } },
  },
} as const;

const COM_INSCRICAO = {
  participante: { with: COM_PARTICIPANTE },
  presencas: { orderBy: (p: typeof tabela_presenca, { asc: a }: { asc: typeof asc }) => [a(p.data)] },
} as const;

export async function carregar_turma(tx: Executor, turma_id: number): Promise<TurmaCarregada | null> {
  const t = await tx.query.turma.findFirst({ where: eq(tabela_turma.id, turma_id), with: COM_TURMA as never });
  return (t as TurmaCarregada | undefined) ?? null;
}

/** A inscrição com a turma, o participante e os dias lançados. */
export async function carregar_inscricao(
  tx: Executor,
  inscricao_id: number,
  turma: TurmaCarregada | null = null,
): Promise<InscricaoCarregada | null> {
  const i = await tx.query.inscricao.findFirst({
    where: eq(tabela_inscricao.id, inscricao_id),
    with: COM_INSCRICAO as never,
  });
  if (!i) return null;
  const registro = i as unknown as Omit<InscricaoCarregada, "turma">;
  const alvo = turma && turma.id === registro.turma_id ? turma : await carregar_turma(tx, registro.turma_id);
  return { ...registro, turma: alvo! } as InscricaoCarregada;
}

/** Recarrega o objeto carregado a partir do banco (o `s.refresh` do Python). */
export async function recarregar_turma(tx: Executor, turma: TurmaCarregada): Promise<TurmaCarregada> {
  const nova = (await carregar_turma(tx, turma.id))!;
  Object.assign(turma, nova);
  return turma;
}

async function gravar_turma(tx: Executor, turma: TurmaCarregada | TurmaRegistro, campos: Partial<TurmaRegistro>) {
  await tx.update(tabela_turma).set(campos).where(eq(tabela_turma.id, turma.id));
  Object.assign(turma, campos);
}

export async function gravar_inscricao(
  tx: Executor,
  inscricao: InscricaoRegistro,
  campos: Partial<InscricaoRegistro>,
): Promise<void> {
  await tx.update(tabela_inscricao).set(campos).where(eq(tabela_inscricao.id, inscricao.id));
  Object.assign(inscricao, campos);
}

// ---------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------
/** TUR-2026-0007. Quatro dígitos: zero à esquerda mantém a ordenação alfabética. */
export function codigo_de(numero: number, ano: number): string {
  return `TUR-${ano}-${String(numero).padStart(4, "0")}`;
}

/**
 * O recorte de turmas pelo escopo — e o que "próprio" quer dizer aqui.
 *
 * **Uma turma não é dado pessoal de ninguém.** Código, treinamento, período,
 * local e vagas são CARTAZ. O que é "de alguém" é a INSCRIÇÃO, e é por ela que
 * o recorte do titular passa (`inscricoes_do_titular`). Por isso o ramo de
 * escopo próprio NÃO filtra; `ESCOPO_UNIDADE` continua passando por
 * `aplicar_escopo`, e é para ele que `turma.campus_id` existe.
 *
 * Devolve a CONDIÇÃO (ver o desvio de `aplicar_escopo` em DESVIOS.md).
 */
export function consulta_no_escopo(usuario: UsuarioAtual) {
  if (usuario.escopo === ESCOPO_PROPRIO) return undefined;
  return aplicar_escopo(usuario, tabela_turma);
}

/** Uma leitura só, já recortada — a porta única das rotas de turma. */
export async function no_escopo(tx: Executor, usuario: UsuarioAtual, turma_id: number): Promise<TurmaCarregada | null> {
  const [achada] = await tx
    .select({ id: tabela_turma.id })
    .from(tabela_turma)
    .where(and(consulta_no_escopo(usuario), eq(tabela_turma.id, turma_id)));
  return achada ? carregar_turma(tx, achada.id) : null;
}

export async function inscricoes_que_ocupam_vaga(tx: Executor, turma: { id: number }): Promise<number> {
  const [linha] = await tx
    .select({ n: count() })
    .from(tabela_inscricao)
    .where(and(eq(tabela_inscricao.turma_id, turma.id), inArray(tabela_inscricao.situacao, [...INSCRICAO_OCUPA_VAGA])));
  return Number(linha?.n ?? 0);
}

/** `null` quando a turma não tem limite declarado — que não é o mesmo que zero. */
export async function vagas_restantes(tx: Executor, turma: TurmaRegistro): Promise<number | null> {
  if (turma.vagas === null) return null;
  return Math.max(0, turma.vagas - (await inscricoes_que_ocupam_vaga(tx, turma)));
}

// ---------------------------------------------------------------------
// Turma
// ---------------------------------------------------------------------
function _conferir_periodo(data_inicio: string, data_fim: string): void {
  if (data_fim < data_inicio) throw new RegraDaTurma("O fim da turma não pode ser anterior ao início.");
}

function _conferir_numeros(d: {
  carga_horaria_horas: string | null;
  vagas: number | null;
  nota_minima_aprovacao: string | null;
  frequencia_minima_percentual: string;
}): void {
  if (d.carga_horaria_horas !== null && comparar(d.carga_horaria_horas, "0") <= 0) {
    throw new RegraDaTurma("Carga horária da turma: informe um número maior que zero.");
  }
  if (d.vagas !== null && d.vagas <= 0) {
    throw new RegraDaTurma("Vagas: informe um número maior que zero, ou deixe em branco.");
  }
  if (
    d.nota_minima_aprovacao !== null &&
    !(comparar(d.nota_minima_aprovacao, "0") >= 0 && comparar(d.nota_minima_aprovacao, "10") <= 0)
  ) {
    throw new RegraDaTurma("Nota mínima: use um valor entre 0 e 10.");
  }
  if (!(comparar(d.frequencia_minima_percentual, "0") >= 0 && comparar(d.frequencia_minima_percentual, "100") <= 0)) {
    throw new RegraDaTurma("Frequência mínima: use um percentual entre 0 e 100.");
  }
}

export interface DadosTurma {
  treinamento: TreinamentoRegistro;
  data_inicio: string;
  data_fim: string;
  local?: string | null;
  campus_id?: number | null;
  unidade_promotora_id?: number | null;
  carga_horaria_horas?: string | null;
  data_base_vencimento?: string | null;
  vagas?: number | null;
  inscricao_aberta_ate?: string | null;
  nota_minima_aprovacao?: string | null;
  frequencia_minima_percentual?: string;
  observacoes?: string | null;
}

/**
 * Abre a turma e consome o número do ano, na mesma transação. O ano da turma é
 * o do INÍCIO, não o da criação: "Turma 7/2026" é uma turma realizada em 2026.
 */
export async function criar_turma(tx: Executor, usuario: UsuarioAtual, d: DadosTurma): Promise<TurmaCarregada> {
  usuario.exigir("turma.criar");
  const treinamento = d.treinamento;
  if (!treinamento.ativo) {
    throw new RegraDaTurma(`'${treinamento.nome}' está inativo no catálogo — reative-o antes de abrir turma.`);
  }
  _conferir_periodo(d.data_inicio, d.data_fim);
  const frequencia = d.frequencia_minima_percentual ?? "75";
  _conferir_numeros({
    carga_horaria_horas: d.carga_horaria_horas ?? null,
    vagas: d.vagas ?? null,
    nota_minima_aprovacao: d.nota_minima_aprovacao ?? null,
    frequencia_minima_percentual: frequencia,
  });
  if (d.data_base_vencimento && d.data_base_vencimento < d.data_inicio) {
    throw new RegraDaTurma("A data base do vencimento não pode ser anterior ao início da turma.");
  }

  const ano = datas_br.partes(d.data_inicio)[0];
  const numero = await numeracao.proximo_numero_turma(tx, ano);
  const [linha] = await tx
    .insert(tabela_turma)
    .values({
      treinamento_id: treinamento.id,
      numero,
      ano,
      codigo: codigo_de(numero, ano),
      data_inicio: d.data_inicio,
      data_fim: d.data_fim,
      data_base_vencimento: d.data_base_vencimento ?? null,
      carga_horaria_horas: d.carga_horaria_horas ?? null,
      local: d.local ?? null,
      campus_id: d.campus_id ?? null,
      unidade_promotora_id: d.unidade_promotora_id ?? null,
      vagas: d.vagas ?? null,
      inscricao_aberta_ate: d.inscricao_aberta_ate ?? null,
      nota_minima_aprovacao: d.nota_minima_aprovacao ?? null,
      frequencia_minima_percentual: frequencia,
      observacoes: d.observacoes ?? null,
      situacao: "PLANEJADA",
      criado_por: usuario.id,
    })
    .returning();
  await auditoria.registrar(tx, {
    entidade: "turma",
    entidade_id: linha!.id,
    tipo_evento: "TURMA_CRIADA",
    descricao: `${linha!.codigo} · ${treinamento.nome} · ${d.data_inicio} a ${d.data_fim}`,
    usuario,
  });
  return (await carregar_turma(tx, linha!.id))!;
}

/**
 * Grava a ficha da turma e audita campo a campo. As regras correm ANTES da
 * gravação: mudar o ano de início desmentiria o código que já circulou, e
 * turma encerrada não se reescreve.
 */
export async function editar_turma(
  tx: Executor,
  usuario: UsuarioAtual,
  turma: TurmaCarregada,
  campos: Partial<TurmaRegistro>,
): Promise<TurmaCarregada> {
  usuario.exigir("turma.criar");
  if (T.encerrada(turma)) {
    throw new RegraDaTurma(
      `Turma ${ROTULO_TURMA[turma.situacao]!.toLowerCase()} não se edita — ` +
        "o que ela diz já foi comunicado a quem participou.",
    );
  }
  const valor = <K extends keyof TurmaRegistro>(k: K): TurmaRegistro[K] =>
    (k in campos ? campos[k] : turma[k]) as TurmaRegistro[K];
  const novo_inicio = valor("data_inicio");
  const novo_fim = valor("data_fim");
  _conferir_periodo(novo_inicio, novo_fim);
  const ano_novo = datas_br.partes(novo_inicio)[0];
  if (ano_novo !== turma.ano) {
    // o número foi tirado da sequência de `turma.ano` e o código está no cartaz
    throw new RegraDaTurma(
      `Adiar a turma para ${ano_novo} mudaria o ano de ${turma.codigo}, ` +
        "que já foi divulgado. Cancele esta turma e abra outra.",
    );
  }
  const base = valor("data_base_vencimento");
  if (base !== null && base < novo_inicio) {
    throw new RegraDaTurma("A data base do vencimento não pode ser anterior ao início da turma.");
  }
  _conferir_numeros({
    carga_horaria_horas: valor("carga_horaria_horas"),
    vagas: valor("vagas"),
    nota_minima_aprovacao: valor("nota_minima_aprovacao"),
    frequencia_minima_percentual: valor("frequencia_minima_percentual"),
  });
  const vagas_novas = valor("vagas");
  if (vagas_novas !== null) {
    const ocupadas = await inscricoes_que_ocupam_vaga(tx, turma);
    if (vagas_novas < ocupadas) {
      throw new RegraDaTurma(
        `A turma já tem ${ocupadas} inscrito(s): reduzir para ` +
          `${vagas_novas} vaga(s) deixaria gente inscrita fora da conta.`,
      );
    }
  }

  const antes: Record<string, unknown> = {};
  for (const k of Object.keys(campos)) antes[k] = turma[k as keyof TurmaRegistro];
  // Decimal do Python: '8.0' e '8' são o mesmo número, e o diff campo a campo
  // não pode acusar mudança que não houve
  const depois: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(campos)) {
    const a = antes[k];
    depois[k] = typeof v === "string" && typeof a === "string" && eh_numero(a) && eh_numero(v) && comparar(a, v) === 0 ? a : v;
  }
  await gravar_turma(tx, turma, campos);
  await auditoria.registrar_diferencas(tx, {
    entidade: "turma",
    entidade_id: turma.id,
    antes,
    depois,
    usuario,
  });
  return turma;
}

function eh_numero(v: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(v);
}

/** Máquina E. Transição não declarada é recusada aqui, não no template. */
export async function mudar_situacao(
  tx: Executor,
  usuario: UsuarioAtual,
  turma: TurmaCarregada,
  destino: string,
  opcoes: { motivo?: string | null } = {},
): Promise<TurmaCarregada> {
  const permissao = Object.hasOwn(PERMISSAO_POR_SITUACAO_TURMA, destino) ? PERMISSAO_POR_SITUACAO_TURMA[destino] : undefined;
  if (permissao === undefined) throw new RegraDaTurma(`Situação de turma desconhecida: ${destino}.`);
  usuario.exigir(permissao);

  const origem = turma.situacao;
  if (origem === destino) return turma;
  exigir_transicao_turma(origem, destino);

  const limpo = (opcoes.motivo ?? "").trim() || null;
  if (destino === "CANCELADA" && !limpo) {
    throw new RegraDaTurma(
      "Cancelar exige o motivo: é o único registro que sobra para quem " +
        "perguntar depois por que a turma não aconteceu.",
    );
  }
  if (destino === "INSCRICOES_ABERTAS" && turma.data_fim < datas_br.hoje()) {
    throw new RegraDaTurma(
      `A turma terminou em ${datas_br.numerica(turma.data_fim)} — não há como abrir inscrição para ela.`,
    );
  }

  await gravar_turma(tx, turma, {
    situacao: destino,
    motivo_cancelamento: destino === "CANCELADA" ? limpo : null,
    concluida_em: destino === "CONCLUIDA" ? agora_utc() : null,
  });
  await auditoria.registrar(tx, {
    entidade: "turma",
    entidade_id: turma.id,
    tipo_evento: auditoria.ESTADO_ALTERADO,
    descricao:
      `${turma.codigo}: ${ROTULO_TURMA[origem] ?? origem} -> ${ROTULO_TURMA[destino] ?? destino}` +
      (limpo ? ` — ${limpo}` : ""),
    campo: "situacao",
    valor_anterior: origem,
    valor_novo: destino,
    comentario: limpo,
    usuario,
  });
  if (destino === "CONCLUIDA") {
    // concluir é UM ato: calcula a frequência de cada inscrito e atribui
    // APROVADO/REPROVADO na mesma transação. Import dinâmico pelo mesmo motivo
    // do import local do Python: `presenca` importa daqui.
    const presenca = await import("./presenca.js");
    await presenca.apurar_turma(tx, usuario, turma);
  }
  return turma;
}

// ---------------------------------------------------------------------
// Instrutores da turma
// ---------------------------------------------------------------------
export async function vincular_instrutor(
  tx: Executor,
  usuario: UsuarioAtual,
  turma: TurmaCarregada,
  instrutor: AssinaturaCarregada,
  opcoes: { assina_certificado?: boolean } = {},
) {
  const assina = opcoes.assina_certificado ?? true;
  usuario.exigir("turma.criar");
  if (T.encerrada(turma)) throw new RegraDaTurma("Turma encerrada não muda de instrutor.");
  const nome = AssinaturaInstrutor.nome_exibicao(instrutor);
  if (!instrutor.ativo) {
    throw new RegraDaTurma(`A assinatura de ${nome} está inativa — reative-a antes de vinculá-la à turma.`);
  }
  if (!AssinaturaInstrutor.vigente_em(instrutor, turma.data_inicio)) {
    // a assinatura tem vigência justamente para não autorizar quem já saiu
    throw new RegraDaTurma(
      `A assinatura de ${nome} não vigora em ${datas_br.numerica(turma.data_inicio)}, quando a turma começa.`,
    );
  }
  const [ja] = await tx
    .select()
    .from(tabela_turma_instrutor)
    .where(
      and(eq(tabela_turma_instrutor.turma_id, turma.id), eq(tabela_turma_instrutor.assinatura_instrutor_id, instrutor.id)),
    );
  if (ja) throw new RegraDaTurma(`${nome} já é instrutor desta turma.`);

  const [vinculo] = await tx
    .insert(tabela_turma_instrutor)
    .values({
      turma_id: turma.id,
      assinatura_instrutor_id: instrutor.id,
      ordem: turma.instrutores.length + 1,
      assina_certificado: assina,
    })
    .returning();
  turma.instrutores.push({ ...vinculo!, instrutor });
  await auditoria.registrar(tx, {
    entidade: "turma",
    entidade_id: turma.id,
    tipo_evento: "TURMA_INSTRUTOR_VINCULADO",
    descricao: `${turma.codigo}: ${nome}` + (assina ? "" : " (não assina o certificado)"),
    usuario,
  });
  return vinculo!;
}

export async function desvincular_instrutor(
  tx: Executor,
  usuario: UsuarioAtual,
  turma: TurmaCarregada,
  instrutor_id: number,
): Promise<void> {
  usuario.exigir("turma.criar");
  if (T.encerrada(turma)) throw new RegraDaTurma("Turma encerrada não muda de instrutor.");
  const vinculo = turma.instrutores.find((v) => v.assinatura_instrutor_id === instrutor_id);
  if (!vinculo) return;
  const nome = AssinaturaInstrutor.nome_exibicao(vinculo.instrutor);
  await tx
    .delete(tabela_turma_instrutor)
    .where(
      and(eq(tabela_turma_instrutor.turma_id, turma.id), eq(tabela_turma_instrutor.assinatura_instrutor_id, instrutor_id)),
    );
  turma.instrutores = turma.instrutores.filter((v) => v !== vinculo);
  await auditoria.registrar(tx, {
    entidade: "turma",
    entidade_id: turma.id,
    tipo_evento: "TURMA_INSTRUTOR_DESVINCULADO",
    descricao: `${turma.codigo}: ${nome}`,
    usuario,
  });
}

// ---------------------------------------------------------------------
// Inscrição
// ---------------------------------------------------------------------
/** A mesma pessoa não entra duas vezes na mesma turma (a mensagem útil de `uq_inscricao`). */
async function _conferir_inscricao_unica(tx: Executor, turma: TurmaRegistro, participante: ParticipanteCarregado) {
  const [ja] = await tx
    .select()
    .from(tabela_inscricao)
    .where(and(eq(tabela_inscricao.turma_id, turma.id), eq(tabela_inscricao.participante_id, participante.id)));
  if (ja) {
    throw new RegraDaTurma(
      `${nome_exibicao(participante)} já consta em ${turma.codigo} como ` +
        `${(ROTULO_INSCRICAO[ja.situacao] ?? ja.situacao).toLowerCase()}.`,
    );
  }
}

/**
 * A última vaga disputada por duas pessoas ao mesmo tempo.
 *
 * DESVIO: no SQLite o `BEGIN IMMEDIATE` fazia a leitura e a gravação caberem
 * numa janela sem outro escritor. No Postgres (MVCC) duas transações leriam
 * "resta 1" ao mesmo tempo; a linha da turma é travada (`FOR UPDATE`) antes da
 * conta, e a segunda inscrição espera a primeira terminar.
 */
async function _conferir_vaga(tx: Executor, turma: TurmaRegistro): Promise<void> {
  await tx.select({ id: tabela_turma.id }).from(tabela_turma).where(eq(tabela_turma.id, turma.id)).for("update");
  const restantes = await vagas_restantes(tx, turma);
  if (restantes !== null && restantes <= 0) {
    throw new RegraDaTurma(`${turma.codigo} não tem vaga: ${turma.vagas} de ${turma.vagas} ocupadas.`);
  }
}

/** Põe a pessoa na turma. Inscrição interna nasce INSCRITA e já ocupa vaga. */
export async function inscrever(
  tx: Executor,
  usuario: UsuarioAtual,
  turma: TurmaCarregada,
  participante: ParticipanteCarregado,
  opcoes: { origem?: string; observacao?: string | null } = {},
): Promise<InscricaoCarregada> {
  usuario.exigir("turma.inscrever");
  if ((opcoes.origem ?? "INTERNA") !== "INTERNA") throw new RegraDaTurma("Nesta versão só existe inscrição interna.");
  if (!T.aceita_inscricao(turma)) {
    throw new RegraDaTurma(`${turma.codigo} está ${ROTULO_TURMA[turma.situacao]!.toLowerCase()} e não recebe inscrição.`);
  }
  if (!participante.ativo || participante.mesclado_em_id !== null) {
    throw new RegraDaTurma(
      `${nome_exibicao(participante)} é um registro desativado — use o participante que o substituiu.`,
    );
  }
  await _conferir_inscricao_unica(tx, turma, participante);
  await _conferir_vaga(tx, turma);

  const [linha] = await tx
    .insert(tabela_inscricao)
    .values({
      turma_id: turma.id,
      participante_id: participante.id,
      situacao: "INSCRITA",
      origem: "INTERNA",
      observacao: (opcoes.observacao ?? "").trim() || null,
      inscrito_por: usuario.id,
    })
    .returning();
  await auditoria.registrar(tx, {
    entidade: "inscricao",
    entidade_id: linha!.id,
    tipo_evento: "INSCRICAO_CRIADA",
    // RN-19 na ESCRITA: só o identificador, nunca o nome ao lado do `PTC-`
    descricao: `${turma.codigo}: ${participante.identificador_publico}`,
    usuario,
  });
  return { ...linha!, turma, participante, presencas: [] };
}

/**
 * Máquina F. A ordem das guardas importa: estado inexistente, depois estado
 * derivado, depois permissão — senão quem tentasse marcar presença por aqui
 * ouviria "permissão negada" em vez de ser mandado para a aba certa.
 */
export async function mudar_situacao_inscricao(
  tx: Executor,
  usuario: UsuarioAtual,
  inscricao: InscricaoCarregada,
  destino: string,
  opcoes: { motivo?: string | null; quando?: Date | null } = {},
): Promise<InscricaoCarregada> {
  if (!(ESTADOS_INSCRICAO as readonly string[]).includes(destino)) {
    throw new RegraDaTurma(`Situação de inscrição desconhecida: ${destino}.`);
  }
  const permissao = Object.hasOwn(PERMISSAO_POR_SITUACAO_INSCRICAO, destino)
    ? PERMISSAO_POR_SITUACAO_INSCRICAO[destino]
    : undefined;
  if (permissao === undefined) throw new RegraDaTurma(SITUACAO_DERIVADA);
  usuario.exigir(permissao);

  const origem = inscricao.situacao;
  if (origem === destino) return inscricao;
  exigir_transicao_inscricao(origem, destino);

  const limpo = (opcoes.motivo ?? "").trim() || null;
  if (destino === "CANCELADA" && !limpo) {
    throw new RegraDaTurma(
      "Cancelar a inscrição exige o motivo: é o que distingue desistência " +
        "de erro de digitação quando alguém consultar depois.",
    );
  }
  if (destino === "CONFIRMADA" && T.encerrada(inscricao.turma)) {
    throw new RegraDaTurma(
      `${inscricao.turma.codigo} está ${ROTULO_TURMA[inscricao.turma.situacao]!.toLowerCase()}: não há o que confirmar.`,
    );
  }

  const campos: Partial<InscricaoRegistro> = {
    situacao: destino,
    motivo_cancelamento: destino === "CANCELADA" ? limpo : null,
  };
  if (destino === "CONFIRMADA") {
    campos.confirmada_em = opcoes.quando ?? agora_utc();
    campos.confirmada_por = usuario.id;
  }
  await gravar_inscricao(tx, inscricao, campos);
  await auditoria.registrar(tx, {
    entidade: "inscricao",
    entidade_id: inscricao.id,
    tipo_evento: auditoria.ESTADO_ALTERADO,
    descricao:
      `${inscricao.turma.codigo} · ${inscricao.participante.identificador_publico}: ` +
      `${ROTULO_INSCRICAO[origem] ?? origem} -> ${ROTULO_INSCRICAO[destino] ?? destino}` +
      (limpo ? ` — ${limpo}` : ""),
    campo: "situacao",
    valor_anterior: origem,
    valor_novo: destino,
    comentario: limpo,
    usuario,
  });
  // sair de INSCRITA é o que a CSSO tinha para fazer: confirmar (ou cancelar)
  await fechar_pendencia_de_confirmacao(tx, inscricao, usuario);
  return inscricao;
}

/** O `sorted(..., key=casefold)` do Python: ordem de ponto de código, não de locale. */
export function comparar_texto(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Na ordem em que a lista de presença vai sair: nome, não id. */
export async function inscricoes_da_turma(tx: Executor, turma: TurmaCarregada): Promise<InscricaoCarregada[]> {
  const linhas = await tx.query.inscricao.findMany({
    where: eq(tabela_inscricao.turma_id, turma.id),
    with: COM_INSCRICAO as never,
    orderBy: [asc(tabela_inscricao.id)],
  });
  const itens = (linhas as unknown as Omit<InscricaoCarregada, "turma">[]).map(
    (i) => ({ ...i, turma }) as InscricaoCarregada,
  );
  return itens.sort((a, b) =>
    comparar_texto(nome_exibicao(a.participante).toLowerCase(), nome_exibicao(b.participante).toLowerCase()),
  );
}

// ---------------------------------------------------------------------
// A inscrição do PRÓPRIO servidor
// ---------------------------------------------------------------------
// `turma.inscrever_se` e `turma.inscrever` são permissões diferentes porque
// descrevem atos diferentes. **A propriedade de segurança é a ausência de um
// parâmetro**: as funções abaixo não recebem participante nem inscrição de
// terceiro — o titular sai de `usuario.servidor_id`, que vem da sessão.
export const TIPO_PENDENCIA_CONFIRMAR = "TURMA_INSCRICAO_A_CONFIRMAR";

export function chave_da_pendencia_de_confirmacao(inscricao: { id: number }): string {
  return `inscricao-${inscricao.id}-a-confirmar`;
}

/**
 * Abre a tarefa que diz à CSSO que há um pedido esperando confirmação.
 *
 * Sem responsável, de propósito: tarefa sem dono é do SETOR. A descrição não
 * nomeia ninguém (`identificador_publico`). O prazo é o da turma.
 */
export async function abrir_pendencia_de_confirmacao(
  tx: Executor,
  inscricao: InscricaoCarregada,
  usuario: UsuarioAtual | null = null,
): Promise<void> {
  const turma = inscricao.turma;
  const pendencia = await pendencias.abrir(tx, {
    tipo: TIPO_PENDENCIA_CONFIRMAR,
    chave: chave_da_pendencia_de_confirmacao(inscricao),
    descricao:
      `${turma.codigo} · ${turma.treinamento.nome} · pedida pelo próprio ` +
      `participante ${inscricao.participante.identificador_publico}`,
    usuario,
    entidade: "turma",
    entidade_id: turma.id,
    prazo: turma.inscricao_aberta_ate || turma.data_inicio,
  });
  // `abrir` cai no `usuario.id` do chamador — aqui o PRÓPRIO servidor. O DONO
  // da tarefa é o setor, e por isso é nulo.
  await tx.update(tabela_pendencia).set({ responsavel_id: null }).where(eq(tabela_pendencia.id, pendencia.id));
}

/**
 * Sair de INSCRITA é o que a tarefa pedia — então a tarefa acabou. Só FECHA,
 * nunca abre: quem abre é `inscrever_se`, e só ele.
 */
export async function fechar_pendencia_de_confirmacao(
  tx: Executor,
  inscricao: InscricaoRegistro,
  usuario: UsuarioAtual,
): Promise<void> {
  if (inscricao.situacao === "INSCRITA") return;
  const [existente] = await tx
    .select()
    .from(tabela_pendencia)
    .where(eq(tabela_pendencia.chave, chave_da_pendencia_de_confirmacao(inscricao)));
  if (existente) await pendencias.concluir(tx, existente, usuario);
}

async function _titular_da_conta(tx: Executor, usuario: UsuarioAtual) {
  if (usuario.servidor_id === null) {
    throw new RegraDaTurma(
      "Sua conta não está ligada a um cadastro de servidor, e sem essa " +
        "ligação o sistema não tem em nome de quem inscrever. A ligação é " +
        "feita em Usuários, por quem tem `usuario.criar_conta` — peça " +
        "informando o seu SIAPE.",
    );
  }
  const [servidor] = await tx.select().from(tabela_servidor).where(eq(tabela_servidor.id, usuario.servidor_id));
  if (!servidor) {
    throw new RegraDaTurma(
      "O cadastro de servidor ligado a esta conta não existe mais. Avise a CSSO antes de tentar de novo.",
    );
  }
  return servidor;
}

/**
 * `""` quando a turma recebe pedido do próprio; o motivo, quando não recebe.
 * Mais estreita que `aceita_inscricao`: só `INSCRICOES_ABERTAS`, dentro do prazo.
 */
export function aberta_a_pedido_proprio(turma: TurmaRegistro, hoje: string | null = null): string {
  const dia = hoje ?? datas_br.hoje();
  if (turma.situacao !== "INSCRICOES_ABERTAS") {
    return (
      `${turma.codigo} está ${ROTULO_TURMA[turma.situacao]!.toLowerCase()}: só se ` +
      "pede vaga em turma com inscrições abertas. Fale com a CSSO."
    );
  }
  if (turma.inscricao_aberta_ate !== null && turma.inscricao_aberta_ate < dia) {
    return `As inscrições de ${turma.codigo} fecharam em ${datas_br.numerica(turma.inscricao_aberta_ate)}.`;
  }
  return "";
}

/** O cartaz: as turmas que recebem pedido do próprio, hoje. Sem escopo, e sem nome. */
export async function turmas_abertas(tx: Executor, hoje: string | null = null): Promise<TurmaCarregada[]> {
  const dia = hoje ?? datas_br.hoje();
  const itens = (await tx.query.turma.findMany({
    where: eq(tabela_turma.situacao, "INSCRICOES_ABERTAS"),
    with: COM_TURMA as never,
  })) as unknown as TurmaCarregada[];
  return itens
    .filter((t) => !aberta_a_pedido_proprio(t, dia))
    .sort((a, b) => comparar_texto(a.data_inicio, b.data_inicio) || comparar_texto(a.codigo, b.codigo));
}

/**
 * "As minhas" — AQUI o escopo próprio quer dizer alguma coisa. Presa ao
 * `servidor_id` da conta; `-1` no lugar de null para não virar `IS NULL`.
 */
export async function inscricoes_do_titular(tx: Executor, usuario: UsuarioAtual): Promise<InscricaoCarregada[]> {
  const ids = await tx
    .select({ id: tabela_inscricao.id })
    .from(tabela_inscricao)
    .innerJoin(tabela_participante, eq(tabela_participante.id, tabela_inscricao.participante_id))
    .innerJoin(tabela_turma, eq(tabela_turma.id, tabela_inscricao.turma_id))
    .where(eq(tabela_participante.servidor_id, usuario.servidor_id ?? -1))
    .orderBy(desc(tabela_turma.data_inicio), desc(tabela_turma.codigo));
  const saida: InscricaoCarregada[] = [];
  for (const { id } of ids) saida.push((await carregar_inscricao(tx, id))!);
  return saida;
}

/**
 * O servidor pede a própria vaga. Nasce INSCRITA; a CSSO confirma. A vaga é
 * ocupada desde já (`INSCRITA` está em `INSCRICAO_OCUPA_VAGA`).
 */
export async function inscrever_se(
  tx: Executor,
  usuario: UsuarioAtual,
  turma: TurmaCarregada,
  opcoes: { hoje?: string | null } = {},
): Promise<InscricaoCarregada> {
  usuario.exigir("turma.inscrever_se");
  const hoje = opcoes.hoje ?? datas_br.hoje();
  const servidor = await _titular_da_conta(tx, usuario);

  const impedimento = aberta_a_pedido_proprio(turma, hoje);
  if (impedimento) throw new RegraDaTurma(impedimento);

  const pessoa = await servico_participante.de_servidor(tx, servidor, usuario);
  await _conferir_inscricao_unica(tx, turma, pessoa);
  await _conferir_vaga(tx, turma);

  const [linha] = await tx
    .insert(tabela_inscricao)
    .values({
      turma_id: turma.id,
      participante_id: pessoa.id,
      situacao: "INSCRITA",
      origem: "INTERNA",
      // quem pediu foi ele: `inscrito_por` é a conta do próprio titular
      inscrito_por: usuario.id,
    })
    .returning();
  const inscricao: InscricaoCarregada = { ...linha!, turma, participante: pessoa, presencas: [] };
  await auditoria.registrar(tx, {
    entidade: "inscricao",
    entidade_id: inscricao.id,
    tipo_evento: "INSCRICAO_PEDIDA_PELO_TITULAR",
    descricao: `${turma.codigo}: ${pessoa.identificador_publico} pediu a própria vaga`,
    usuario,
  });
  await abrir_pendencia_de_confirmacao(tx, inscricao, usuario);
  return inscricao;
}

/** Desistir cabe até a véspera do início, e só de inscrição ainda viva. */
export function pode_desistir(inscricao: InscricaoCarregada, hoje: string | null = null): boolean {
  const dia = hoje ?? datas_br.hoje();
  return (
    (inscricao.situacao === "INSCRITA" || inscricao.situacao === "CONFIRMADA") &&
    !T.encerrada(inscricao.turma) &&
    dia < inscricao.turma.data_inicio
  );
}

/**
 * A própria desistência — e ela NÃO apaga nada (RN-31). Até a véspera do
 * início: depois disso não ir é FATO (`AUSENTE`), não decisão.
 */
export async function desistir(
  tx: Executor,
  usuario: UsuarioAtual,
  inscricao: InscricaoCarregada,
  opcoes: { motivo?: string | null; hoje?: string | null } = {},
): Promise<InscricaoCarregada> {
  usuario.exigir("turma.inscrever_se");
  const hoje = opcoes.hoje ?? datas_br.hoje();
  const servidor_id = inscricao.participante.servidor_id;
  if (usuario.servidor_id === null || servidor_id !== usuario.servidor_id) {
    // não é "permissão negada": a permissão ele tem; relação com a inscrição, não
    throw new RegraDaTurma("Esta inscrição não é sua.");
  }
  if (!pode_desistir(inscricao, hoje)) {
    if (inscricao.situacao !== "INSCRITA" && inscricao.situacao !== "CONFIRMADA") {
      throw new RegraDaTurma(
        `Sua inscrição em ${inscricao.turma.codigo} está ` +
          `${(ROTULO_INSCRICAO[inscricao.situacao] ?? inscricao.situacao).toLowerCase()} ` +
          "e não há o que desistir.",
      );
    }
    throw new RegraDaTurma(
      `${inscricao.turma.codigo} começou em ${datas_br.numerica(inscricao.turma.data_inicio)}: a partir do ` +
        "início a falta é registrada como ausência, não desfeita como " +
        "desistência. Fale com a CSSO.",
    );
  }

  const limpo = (opcoes.motivo ?? "").trim() || "Desistência do próprio inscrito.";
  const origem = inscricao.situacao;
  exigir_transicao_inscricao(origem, "CANCELADA");
  await gravar_inscricao(tx, inscricao, { situacao: "CANCELADA", motivo_cancelamento: limpo });
  await auditoria.registrar(tx, {
    entidade: "inscricao",
    entidade_id: inscricao.id,
    tipo_evento: "INSCRICAO_DESISTIDA",
    descricao: `${inscricao.turma.codigo}: ${inscricao.participante.identificador_publico} desistiu — ${limpo}`,
    campo: "situacao",
    valor_anterior: origem,
    valor_novo: "CANCELADA",
    comentario: limpo,
    usuario,
  });
  await fechar_pendencia_de_confirmacao(tx, inscricao, usuario);
  return inscricao;
}
