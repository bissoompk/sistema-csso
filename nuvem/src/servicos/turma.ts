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
import { and, asc, count, desc, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  agora_utc,
  assinatura_instrutor as tabela_assinatura,
  campus as tabela_campus,
  certificado as tabela_certificado,
  certificado_modelo as tabela_modelo,
  certificado_modelo_tag as tabela_tag,
  email_saida as tabela_email_saida,
  inscricao as tabela_inscricao,
  local_treinamento as tabela_local,
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
  ROTULO_TURMA_TELA,
  exigir_transicao_inscricao,
  exigir_transicao_turma,
} from "../dominio/estados.js";
import { AssinaturaInstrutor, ROTULO_INSCRICAO_TELA, Turma as T } from "../dominio/treinamento.js";
import { RegraViolada } from "../nucleo/erros.js";
import * as auditoria from "./auditoria.js";
import * as avisos_inscricao from "./avisos_inscricao.js";
import * as datas_br from "./datas_br.js";
import * as local_treinamento from "./local_treinamento.js";
import * as numeracao from "./numeracao.js";
import * as pendencias from "./pendencias.js";
import * as servico_participante from "./participante.js";
import * as setor_promotor from "./setor_promotor.js";
import * as setor_equipe from "./setor_equipe.js";
import * as titular_externo from "./titular_externo.js";
import { COM_PARTICIPANTE, nome_exibicao, type ParticipanteCarregado } from "./participante.js";
import { ESCOPO_PROPRIO, aplicar_escopo, type UsuarioAtual } from "./rbac.js";
import { comparar } from "./presenca.js";
import { filtro } from "../web.js";

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
  // NUVEM (24/10/2026): o local cadastrado; `local` (texto) leva o nome dele
  local_cadastrado: typeof tabela_local.$inferSelect | null;
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
  local_cadastrado: true,
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
 * O escopo é o da PERMISSÃO (D1/D9), e não o da conta: o titular que pede a
 * própria vaga (`turma.inscrever_se`, sempre próprio) alcança o cartaz
 * inteiro, ainda que tenha um perfil de equipe recortado por campus; quem
 * inscreve os outros (`turma.inscrever`) alcança só o campus daquela
 * concessão.
 *
 * NUVEM: o alcance de EQUIPE se recorta também pelo setor promotor da turma
 * (`setor_equipe.ts`): cada setor vê as turmas que promove. O cartaz do
 * titular (o ramo de escopo próprio) continua inteiro.
 *
 * Devolve a CONDIÇÃO (ver o desvio de `aplicar_escopo` em DESVIOS.md).
 */
export function consulta_no_escopo(usuario: UsuarioAtual, permissao: string | readonly string[] = "treinamento.ver") {
  if (usuario.escopo_de(permissao) === ESCOPO_PROPRIO) return undefined;
  return and(aplicar_escopo(usuario, tabela_turma, permissao), setor_equipe.condicao_setor_turma(usuario));
}

/** Uma leitura só, já recortada — a porta única das rotas de turma. */
export async function no_escopo(
  tx: Executor,
  usuario: UsuarioAtual,
  turma_id: number,
  permissao: string | readonly string[] = "treinamento.ver",
): Promise<TurmaCarregada | null> {
  const [achada] = await tx
    .select({ id: tabela_turma.id })
    .from(tabela_turma)
    .where(and(consulta_no_escopo(usuario, permissao), eq(tabela_turma.id, turma_id)));
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
/** Exportada para a rota da retificação conferir o período antes das outras travas. */
export function conferir_periodo(data_inicio: string, data_fim: string): void {
  if (data_fim < data_inicio) throw new RegraDaTurma("O fim da turma não pode ser anterior ao início.");
}

// ---------------------------------------------------------------------
// Hora da turma (22/10/2026): início e fim do dia, opcionais
// ---------------------------------------------------------------------
// A turma antiga não tem hora, e continua valendo: sem hora é "dia inteiro"
// (a agenda .ics a põe como evento de dia todo). Com hora, o mesmo horário
// vale para todos os dias da turma. A CHECK `ck_turma_horas` repete a regra
// no banco: fim exige início, e é maior que ele.

/** Turnos do filtro, pela hora de INÍCIO. Lista fechada: valor fora dela é ignorado. */
export const TURNOS: readonly (readonly [string, string])[] = [
  ["manha", "Manhã"],
  ["tarde", "Tarde"],
  ["noite", "Noite"],
  ["dia_inteiro", "Dia inteiro"],
];

/** O turno pedido na URL, ou "" quando não é um dos da lista. */
export function ler_turno(valor: string | null | undefined): string {
  const v = (valor ?? "").trim();
  return TURNOS.some(([codigo]) => codigo === v) ? v : "";
}

/** Manhã antes das 12h, tarde até 17h59, noite a partir das 18h; sem hora, dia inteiro. */
export function turno_de(hora_inicio: string | null | undefined): string {
  if (!hora_inicio) return "dia_inteiro";
  if (hora_inicio < "12:00") return "manha";
  if (hora_inicio < "18:00") return "tarde";
  return "noite";
}

/** A condição SQL do turno (para a lista de /turmas). `undefined` sem filtro. */
export function condicao_turno(turno: string) {
  const h = tabela_turma.hora_inicio;
  if (turno === "dia_inteiro") return isNull(h);
  if (turno === "manha") return lt(h, "12:00");
  if (turno === "tarde") return and(gte(h, "12:00"), lt(h, "18:00"));
  if (turno === "noite") return gte(h, "18:00");
  return undefined;
}

/**
 * "08:00", "8:00", "08:00:00" e "8h" viram "08:00:00" — o formato em que o
 * Postgres devolve `time`, para o diff da edição não acusar mudança que não
 * houve. Vazio é `null`; o resto é recusa com o rótulo do campo.
 */
export function normalizar_hora(valor: string | null | undefined, rotulo: string): string | null {
  const bruto = (valor ?? "").trim().toLowerCase();
  if (!bruto) return null;
  const m = /^(\d{1,2})(?::|h)?(\d{2})?(?::(\d{2}))?h?$/.exec(bruto);
  const hora = m ? Number(m[1]) : NaN;
  const minuto = m && m[2] !== undefined ? Number(m[2]) : 0;
  const segundo = m && m[3] !== undefined ? Number(m[3]) : 0;
  if (!m || hora > 23 || minuto > 59 || segundo > 59) {
    throw new RegraDaTurma(`${rotulo}: use HH:MM, entre 00:00 e 23:59 (por exemplo, 08:00).`);
  }
  const dois = (n: number) => String(n).padStart(2, "0");
  return `${dois(hora)}:${dois(minuto)}:${dois(segundo)}`;
}

/** A regra de `ck_turma_horas`, com a frase para quem digitou. */
export function conferir_horas(hora_inicio: string | null, hora_fim: string | null): void {
  if (hora_fim !== null && hora_inicio === null) {
    throw new RegraDaTurma("Informe a hora de início: a hora de término sozinha não diz quando a turma começa.");
  }
  if (hora_fim !== null && hora_inicio !== null && hora_fim <= hora_inicio) {
    throw new RegraDaTurma(
      `A hora de término (${hora_curta(hora_fim)}) tem de ser depois da hora de início (${hora_curta(hora_inicio)}).`,
    );
  }
}

/** "08:00:00" → "8h"; "08:30:00" → "8h30". */
export function hora_curta(hora: string | null | undefined): string {
  if (!hora) return "";
  const [h, m] = hora.split(":");
  const minutos = m && m !== "00" ? m : "";
  return `${Number(h)}h${minutos}`;
}

/** "8h às 17h", "a partir das 8h", ou "" (dia inteiro). */
export function horario_curto(t: { hora_inicio?: string | null; hora_fim?: string | null } | null | undefined): string {
  if (!t || !t.hora_inicio) return "";
  if (!t.hora_fim) return `a partir das ${hora_curta(t.hora_inicio)}`;
  return `${hora_curta(t.hora_inicio)} às ${hora_curta(t.hora_fim)}`;
}

/** O valor do `<input type="time">`: "08:00:00" → "08:00". */
export function hora_do_campo(hora: string | null | undefined): string {
  return hora ? hora.slice(0, 5) : "";
}

// os templates leem `turma|horario_turma` e `turma.hora_inicio|hora_campo`
filtro("horario_turma", horario_curto);
filtro("hora_campo", hora_do_campo);

/**
 * O prazo de inscrição é planejamento, e por isso pode ser futuro — mas não
 * depois do início: o link ou o pedido próprio que aceita gente com a turma já
 * acontecendo é o que deixava o cartaz "inscrições até 01/12" numa turma de
 * 21/10. `novo` diz se o prazo foi digitado agora: o prazo antigo que já passou
 * não é recusado a cada edição da turma.
 */
function _conferir_prazo_de_inscricao(
  d: { data_inicio: string; inscricao_aberta_ate: string | null },
  novo: boolean,
): void {
  const ate = d.inscricao_aberta_ate;
  if (ate === null) return;
  if (novo && ate < datas_br.hoje()) throw new RegraDaTurma("O prazo de inscrição já passou.");
  if (ate > d.data_inicio) {
    throw new RegraDaTurma(
      `As inscrições têm de fechar até o início da turma (${datas_br.numerica(d.data_inicio)}), ` +
        `e não em ${datas_br.numerica(ate)}.`,
    );
  }
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

/**
 * NUVEM: a unidade promotora sai da lista de setores promotores
 * (`setor_promotor.ts`). Vazio passa; o valor que a turma JÁ tinha também — a
 * turma antiga com unidade fora da lista se edita sem ser obrigada a trocar.
 */
async function _conferir_unidade_promotora(tx: Executor, escolhida: number | null, atual: number | null): Promise<void> {
  if (escolhida === null || escolhida === atual) return;
  const recusa = await setor_promotor.recusa(tx, escolhida);
  if (recusa) throw new RegraDaTurma(recusa);
}

/**
 * NUVEM: o setor promotor da turma nova, pelo setor de quem a abre
 * (`setor_equipe.ts`). Quem vê todos os setores escolhe qualquer um (ou
 * nenhum); os outros, só um dos seus — em branco, o único que têm.
 */
export function setor_da_turma_nova(usuario: UsuarioAtual, escolhida: number | null): number | null {
  if (setor_equipe.ve_todos(usuario)) return escolhida;
  const meus = usuario.setores_promotores;
  if (escolhida !== null) {
    if (!meus.includes(escolhida)) throw new RegraDaTurma(RECUSA_SETOR_ALHEIO);
    return escolhida;
  }
  if (meus.length === 1) return meus[0]!;
  if (!meus.length) throw new RegraDaTurma(setor_equipe.AVISO_SEM_SETOR);
  throw new RegraDaTurma("Escolha o setor promotor da turma: a sua conta está vinculada a mais de um setor.");
}

export const RECUSA_SETOR_ALHEIO =
  "Você só pode atribuir a turma a um dos setores promotores a que a sua conta está vinculada.";

/** NUVEM: na edição, a turma não sai dos setores de quem edita. */
function _conferir_setor_na_edicao(usuario: UsuarioAtual, nova: number | null, atual: number | null): void {
  if (nova === atual || setor_equipe.ve_todos(usuario)) return;
  if (nova === null) {
    throw new RegraDaTurma("Escolha o setor promotor da turma: ele não pode ficar em branco.");
  }
  if (!usuario.setores_promotores.includes(nova)) throw new RegraDaTurma(RECUSA_SETOR_ALHEIO);
}

/**
 * NUVEM (24/10/2026): o local cadastrado escolhido, conferido
 * (`local_treinamento.conferir_para_turma`); `null` é "outro local", o texto livre.
 */
async function _local_escolhido(
  tx: Executor,
  local_id: number | null,
  campus_id: number | null,
  atual_id: number | null,
): Promise<local_treinamento.LocalCarregado | null> {
  if (local_id === null) return null;
  const r = await local_treinamento.conferir_para_turma(tx, local_id, campus_id, atual_id);
  if (typeof r === "string") throw new RegraDaTurma(r);
  return r;
}

export interface DadosTurma {
  treinamento: TreinamentoRegistro;
  data_inicio: string;
  data_fim: string;
  local?: string | null;
  /** o local cadastrado; com ele, `local` é ignorado e vira o nome do local */
  local_id?: number | null;
  descricao?: string | null;
  campus_id?: number | null;
  unidade_promotora_id?: number | null;
  carga_horaria_horas?: string | null;
  data_base_vencimento?: string | null;
  vagas?: number | null;
  inscricao_aberta_ate?: string | null;
  nota_minima_aprovacao?: string | null;
  frequencia_minima_percentual?: string;
  observacoes?: string | null;
  /** como digitado ("08:00"); o serviço confere e normaliza */
  hora_inicio?: string | null;
  hora_fim?: string | null;
  aceita_comunidade_externa?: boolean;
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
  conferir_periodo(d.data_inicio, d.data_fim);
  const hora_inicio = normalizar_hora(d.hora_inicio, "Hora de início");
  const hora_fim = normalizar_hora(d.hora_fim, "Hora de término");
  conferir_horas(hora_inicio, hora_fim);
  _conferir_prazo_de_inscricao({ data_inicio: d.data_inicio, inscricao_aberta_ate: d.inscricao_aberta_ate ?? null }, true);
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
  const unidade_promotora_id = setor_da_turma_nova(usuario, d.unidade_promotora_id ?? null);
  await _conferir_unidade_promotora(tx, unidade_promotora_id, null);
  const local = await _local_escolhido(tx, d.local_id ?? null, d.campus_id ?? null, null);

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
      local: local ? local.nome : (d.local ?? null),
      local_id: local ? local.id : null,
      descricao: d.descricao ?? null,
      campus_id: d.campus_id ?? null,
      unidade_promotora_id,
      vagas: d.vagas ?? null,
      inscricao_aberta_ate: d.inscricao_aberta_ate ?? null,
      nota_minima_aprovacao: d.nota_minima_aprovacao ?? null,
      frequencia_minima_percentual: frequencia,
      observacoes: d.observacoes ?? null,
      hora_inicio,
      hora_fim,
      aceita_comunidade_externa: d.aceita_comunidade_externa ?? false,
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
  const turma = (await carregar_turma(tx, linha!.id))!;
  // NUVEM: o instrutor padrão do catálogo já entra na turma, quando serve
  // (ativo e vigente no início); se não serve, a turma nasce sem e se vincula à mão
  if (treinamento.instrutor_padrao_id !== null) {
    const padrao = await tx.query.assinatura_instrutor.findFirst({
      where: (a, { eq: igual }) => igual(a.id, treinamento.instrutor_padrao_id!),
      with: { servidor: true },
    });
    if (padrao && padrao.ativo && AssinaturaInstrutor.vigente_em(padrao, turma.data_inicio)) {
      await vincular_instrutor(tx, usuario, turma, padrao);
    }
  }
  return turma;
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
  // NUVEM: a correção da turma CONCLUÍDA passa por aqui com as mesmas regras de
  // período e de ano; quem a chama (`retificacao.retificar_turma`) exige o motivo
  opcoes: { concluida?: boolean } = {},
): Promise<TurmaCarregada> {
  usuario.exigir("turma.criar");
  if (T.encerrada(turma) && !(opcoes.concluida && turma.situacao === "CONCLUIDA")) {
    throw new RegraDaTurma(
      `Turma ${ROTULO_TURMA_TELA[turma.situacao]!.toLowerCase()} não se edita — ` +
        "o que ela diz já foi comunicado a quem participou.",
    );
  }
  const valor = <K extends keyof TurmaRegistro>(k: K): TurmaRegistro[K] =>
    (k in campos ? campos[k] : turma[k]) as TurmaRegistro[K];
  const novo_inicio = valor("data_inicio");
  const novo_fim = valor("data_fim");
  conferir_periodo(novo_inicio, novo_fim);
  // a hora chega como digitada; daqui em diante está no formato do banco
  if ("hora_inicio" in campos) campos = { ...campos, hora_inicio: normalizar_hora(campos.hora_inicio, "Hora de início") };
  if ("hora_fim" in campos) campos = { ...campos, hora_fim: normalizar_hora(campos.hora_fim, "Hora de término") };
  conferir_horas(valor("hora_inicio"), valor("hora_fim"));
  // a turma concluída (retificação) não tem mais prazo de inscrição a respeitar;
  // e o prazo só se confere quando ele ou o início mudam — a turma antiga com o
  // prazo depois do início não trava a correção do local (o link e o pedido
  // próprio dela já fecham no início, `aberta_a_pedido_proprio`)
  const ate = valor("inscricao_aberta_ate");
  // o link público ligado precisa do prazo (`ck_turma_inscricao_publica`):
  // apagá-lo estourava a regra do banco e a tela mostrava erro 500 (25/10/2026)
  if (turma.inscricao_publica && ate === null) {
    throw new RegraDaTurma(
      "O link público de inscrição desta turma está ligado, e ele precisa da data de “inscrições até”. " +
        "Informe a data, ou desligue o link na aba Inscrições antes de apagá-la.",
    );
  }
  const prazo_mudou = ate !== turma.inscricao_aberta_ate;
  if (!opcoes.concluida && (prazo_mudou || novo_inicio !== turma.data_inicio)) {
    _conferir_prazo_de_inscricao({ data_inicio: novo_inicio, inscricao_aberta_ate: ate }, prazo_mudou);
  }
  const ano_novo = datas_br.partes(novo_inicio)[0];
  if (ano_novo !== turma.ano) {
    // o número foi tirado da sequência de `turma.ano` e o código está no cartaz
    throw new RegraDaTurma(
      `Adiar a turma para ${ano_novo} mudaria o ano de ${turma.codigo}, ` +
        "que já foi divulgado. Cancele esta turma e abra outra.",
    );
  }
  // NUVEM (24/10/2026): o local. `local_id` no formulário decide (vazio =
  // "outro local", o texto livre); sem ele (formulário antigo, a retificação),
  // o texto digitado diferente do atual é outro local e solta o cadastrado.
  // Com local cadastrado, o texto é sempre o nome dele.
  const escolheu_local = "local_id" in campos;
  let local_final = escolheu_local ? (campos.local_id ?? null) : turma.local_id;
  if (!escolheu_local && local_final !== null && "local" in campos && (campos.local ?? null) !== turma.local) {
    local_final = null;
  }
  if (local_final !== turma.local_id) campos = { ...campos, local_id: local_final };
  if (local_final !== null && (escolheu_local || local_final !== turma.local_id || valor("campus_id") !== turma.campus_id)) {
    const local = (await _local_escolhido(tx, local_final, valor("campus_id"), turma.local_id))!;
    campos = { ...campos, local: local.nome };
  }
  _conferir_setor_na_edicao(usuario, valor("unidade_promotora_id"), turma.unidade_promotora_id);
  await _conferir_unidade_promotora(tx, valor("unidade_promotora_id"), turma.unidade_promotora_id);
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
  // concluir libera o certificado, que atesta um curso que TERMINOU: vale para
  // qualquer origem, e não só para o atalho de planejada direto a concluída
  if (destino === "CONCLUIDA" && turma.data_fim > datas_br.hoje()) {
    throw new RegraDaTurma(
      `${turma.codigo} termina em ${datas_br.numerica(turma.data_fim)}: só se conclui turma que já aconteceu.` +
        (origem === "PLANEJADA"
          ? " Passe-a para em andamento quando começar."
          : " Lance a presença de cada dia e conclua a partir dessa data."),
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
  if (destino === "INSCRICOES_ABERTAS" && turma.divulgar_na_vitrine) {
    // NUVEM: quem pediu aviso na vitrine (e confirmou) é avisado, uma vez por turma
    const aviso = await import("./aviso_interesse.js");
    await aviso.avisar_turma(tx, turma as unknown as TurmaCarregada);
  }
  if (destino === "CONCLUIDA") {
    // concluir é UM ato: calcula a frequência de cada inscrito e atribui
    // APROVADO/REPROVADO na mesma transação. Import dinâmico pelo mesmo motivo
    // do import local do Python: `presenca` importa daqui.
    const presenca = await import("./presenca.js");
    await presenca.apurar_turma(tx, usuario, turma);
    // NUVEM (24/10/2026): o convite da avaliação de reação a quem frequentou,
    // por e-mail, depois da apuração (idempotente: concluir de novo não repete)
    const avaliacao = await import("./avaliacao_reacao.js");
    await avaliacao.convidar_turma(tx, usuario, turma);
  }
  return turma;
}

// ---------------------------------------------------------------------
// Exclusão da turma aberta por engano
// ---------------------------------------------------------------------
export const TURMA_EXCLUIDA = "TURMA_EXCLUIDA";
const SITUACOES_EXCLUIVEIS = ["PLANEJADA", "INSCRICOES_ABERTAS"];

/**
 * O que impede apagar a turma — lista vazia é "pode". A turma que ainda não
 * aconteceu e que só a equipe conhece (treinamento errado, data trocada, turma
 * duplicada) sai de vez; a que alguém de fora já viu se CANCELA, com motivo,
 * porque o cancelamento é o que essa pessoa vai ler.
 *
 * Trava: começou (presença ou nota lançada), tem certificado (mesmo anulado:
 * o número existiu), já saiu e-mail para algum inscrito, ou há pedido feito
 * pelo próprio participante (link público ou "inscrever-me"). A inscrição que
 * a própria equipe lançou vai junto com a turma.
 */
export async function impedimentos_da_exclusao(tx: Executor, turma: TurmaRegistro): Promise<string[]> {
  const motivos: string[] = [];
  if (!SITUACOES_EXCLUIVEIS.includes(turma.situacao)) {
    motivos.push(
      `a turma está ${(ROTULO_TURMA_TELA[turma.situacao] ?? turma.situacao).toLowerCase()}: só se exclui a ` +
        "planejada ou com inscrições abertas — a que já começou ou acabou tem história",
    );
  }
  const inscricoes = await tx.select().from(tabela_inscricao).where(eq(tabela_inscricao.turma_id, turma.id));
  const ids = inscricoes.map((i) => i.id);
  if (ids.length) {
    const [presencas] = await tx
      .select({ n: count() })
      .from(tabela_presenca)
      .where(inArray(tabela_presenca.inscricao_id, ids));
    if (Number(presencas?.n ?? 0) > 0 || inscricoes.some((i) => i.nota_final !== null)) {
      motivos.push("já há presença ou nota lançada");
    }
    const [certificados] = await tx
      .select({ n: count() })
      .from(tabela_certificado)
      .where(inArray(tabela_certificado.inscricao_id, ids));
    if (Number(certificados?.n ?? 0) > 0) motivos.push("já há certificado emitido para ela, ainda que anulado");
    const [enviados] = await tx
      .select({ n: count() })
      .from(tabela_email_saida)
      .where(and(inArray(tabela_email_saida.inscricao_id, ids), eq(tabela_email_saida.situacao, "ENVIADO")));
    if (Number(enviados?.n ?? 0) > 0) motivos.push("algum inscrito já recebeu e-mail sobre ela");
    // o pedido do próprio participante (link ou "inscrever-me") é o que abre a
    // tarefa de confirmação; a inscrição lançada pela equipe não abre
    const chaves = inscricoes.map(chave_da_pendencia_de_confirmacao);
    const pedidas = new Set(
      (await tx.select({ chave: tabela_pendencia.chave }).from(tabela_pendencia).where(inArray(tabela_pendencia.chave, chaves))).map(
        (p) => p.chave,
      ),
    );
    const de_fora = inscricoes.filter(
      (i) => i.situacao !== "CANCELADA" && (i.origem === "PUBLICA" || pedidas.has(chave_da_pendencia_de_confirmacao(i))),
    );
    if (de_fora.length) {
      motivos.push(`${de_fora.length} pedido(s) feito(s) pelo próprio participante — essa pessoa precisa ler o cancelamento`);
    }
  }
  return motivos;
}

/**
 * Apaga a turma e o que só existia por ela: inscrições lançadas pela equipe,
 * vínculos de instrutor, campos do certificado (as FKs cascateiam). Fecha as
 * tarefas abertas sobre ela e cancela o e-mail que ainda estava na fila. O
 * código não volta para a sequência: `TUR-AAAA-NNNN` que sumiu fica explicado
 * na trilha, que guarda o retrato da turma.
 */
export async function excluir_turma(
  tx: Executor,
  usuario: UsuarioAtual,
  turma: TurmaCarregada,
  motivo: string | null | undefined,
): Promise<void> {
  usuario.exigir("turma.concluir");
  const limpo = (motivo ?? "").trim();
  if (!limpo) {
    throw new RegraDaTurma("Excluir exige o motivo: é o que explica, depois, o código que falta na sequência.");
  }
  const motivos = await impedimentos_da_exclusao(tx, turma);
  if (motivos.length) {
    // a saída depende de onde a turma está: só se cancela a que ainda pode ser cancelada
    const saida =
      turma.situacao === "CANCELADA"
        ? " Ela já está cancelada, e o cancelamento guarda o motivo."
        : turma.situacao === "CONCLUIDA"
          ? " Turma concluída fica no histórico: dado errado nela se corrige em “Corrigir dados da turma”."
          : " Cancele a turma, com o motivo.";
    throw new RegraDaTurma(`${turma.codigo} não pode ser excluída: ${motivos.join("; ")}.${saida}`);
  }
  const inscricoes = await tx
    .select({ id: tabela_inscricao.id })
    .from(tabela_inscricao)
    .where(eq(tabela_inscricao.turma_id, turma.id));
  const ids = inscricoes.map((i) => i.id);
  if (ids.length) {
    await tx
      .update(tabela_email_saida)
      .set({ situacao: "CANCELADO", ultimo_erro: "turma excluída" })
      .where(and(inArray(tabela_email_saida.inscricao_id, ids), inArray(tabela_email_saida.situacao, ["PENDENTE", "FALHOU"])));
  }
  const tarefas = await tx
    .select()
    .from(tabela_pendencia)
    .where(and(eq(tabela_pendencia.entidade, "turma"), eq(tabela_pendencia.entidade_id, turma.id), eq(tabela_pendencia.concluida, false)));
  for (const tarefa of tarefas) await pendencias.concluir(tx, tarefa, usuario);

  await tx.delete(tabela_turma).where(eq(tabela_turma.id, turma.id));
  await auditoria.registrar(tx, {
    entidade: "turma",
    entidade_id: turma.id,
    tipo_evento: TURMA_EXCLUIDA,
    descricao:
      `${turma.codigo} · ${turma.treinamento.nome} · ${datas_br.numerica(turma.data_inicio)} excluída` +
      (ids.length ? `, com ${ids.length} inscrição(ões) lançada(s) pela equipe` : "") +
      ` — ${limpo}`,
    campo: "situacao",
    valor_anterior: {
      codigo: turma.codigo,
      treinamento_id: turma.treinamento_id,
      situacao: turma.situacao,
      data_inicio: turma.data_inicio,
      data_fim: turma.data_fim,
      local: turma.local,
      campus_id: turma.campus_id,
      inscricoes: ids.length,
    },
    comentario: limpo,
    usuario,
  });
}

// ---------------------------------------------------------------------
// Instrutores da turma
// ---------------------------------------------------------------------
/**
 * A turma concluída ainda aceita mudar o instrutor enquanto nenhum certificado
 * saiu dela (nem anulado): quem concluiu sem marcar quem assina ficaria sem
 * saída, porque a emissão é recusada e a tela travava o vínculo. Depois do
 * primeiro certificado vale a regra de sempre — anula e reemite (`retificacao.ts`).
 * A turma cancelada nunca muda.
 */
export async function instrutor_mutavel(tx: Executor, turma: TurmaCarregada): Promise<boolean> {
  if (!T.encerrada(turma)) return true;
  if (turma.situacao !== "CONCLUIDA") return false;
  const ids = (await tx.select({ id: tabela_inscricao.id }).from(tabela_inscricao).where(eq(tabela_inscricao.turma_id, turma.id))).map((i) => i.id);
  if (!ids.length) return true;
  const [certificados] = await tx.select({ n: count() }).from(tabela_certificado).where(inArray(tabela_certificado.inscricao_id, ids));
  return Number(certificados?.n ?? 0) === 0;
}

const _RECUSA_INSTRUTOR_ENCERRADA = "Turma encerrada não muda de instrutor.";

export async function vincular_instrutor(
  tx: Executor,
  usuario: UsuarioAtual,
  turma: TurmaCarregada,
  instrutor: AssinaturaCarregada,
  opcoes: { assina_certificado?: boolean } = {},
) {
  const assina = opcoes.assina_certificado ?? true;
  usuario.exigir("turma.criar");
  if (!(await instrutor_mutavel(tx, turma))) throw new RegraDaTurma(_RECUSA_INSTRUTOR_ENCERRADA);
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
  if (!(await instrutor_mutavel(tx, turma))) throw new RegraDaTurma(_RECUSA_INSTRUTOR_ENCERRADA);
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
/**
 * A mesma pessoa não entra duas vezes na mesma turma (a mensagem útil de
 * `uq_inscricao`). `proprio`: quem pede é o titular, e a frase fala com ele —
 * "Fulano já consta como cancelada" não diz ao servidor que foi ele quem
 * desistiu, nem o que fazer agora.
 */
async function _conferir_inscricao_unica(
  tx: Executor,
  turma: TurmaRegistro,
  participante: ParticipanteCarregado,
  proprio = false,
) {
  const [ja] = await tx
    .select()
    .from(tabela_inscricao)
    .where(and(eq(tabela_inscricao.turma_id, turma.id), eq(tabela_inscricao.participante_id, participante.id)));
  if (!ja) return;
  if (proprio) throw new RegraDaTurma(frase_da_minha_inscricao(ja.situacao, turma.codigo));
  throw new RegraDaTurma(
    `${nome_exibicao(participante)} já consta em ${turma.codigo} como ` +
      `${(ROTULO_INSCRICAO[ja.situacao] ?? ja.situacao).toLowerCase()}.`,
  );
}

/**
 * Onde o titular está numa turma, dito a ele — a mesma frase na coluna de
 * "Meus treinamentos" e na recusa do "inscrever-me". A desistência é definitiva
 * nesta turma (`desistir`): voltar atrás é com a equipe responsável.
 */
export function situacao_para_o_titular(situacao: string): string {
  if (situacao === "CANCELADA") return "Você desistiu — fale com a equipe responsável";
  if (situacao === "AGUARDANDO_EMAIL") return "Pedido em análise";
  if (situacao === "INSCRITA") return "Inscrita, aguardando confirmação";
  return ROTULO_INSCRICAO_TELA[situacao] ?? situacao;
}

function frase_da_minha_inscricao(situacao: string, codigo: string): string {
  if (situacao === "CANCELADA") {
    return `Você desistiu de ${codigo}, e a desistência é definitiva nesta turma: para voltar, fale com a equipe responsável.`;
  }
  if (situacao === "AGUARDANDO_EMAIL") return `Seu pedido de vaga em ${codigo} já está em análise pela equipe responsável.`;
  return `Você já está inscrito(a) em ${codigo}.`;
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

/**
 * Põe a pessoa na turma. Desde 25/10/2026 a inscrição nasce CONFIRMADA: com a
 * vaga conferida sob trava, não há o que a equipe decidir depois (antes nascia
 * INSCRITA e esperava o clique em "Confirmar").
 */
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
    throw new RegraDaTurma(`${turma.codigo} está ${ROTULO_TURMA_TELA[turma.situacao]!.toLowerCase()} e não recebe inscrição.`);
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
      situacao: "CONFIRMADA",
      origem: "INTERNA",
      observacao: (opcoes.observacao ?? "").trim() || null,
      inscrito_por: usuario.id,
      confirmada_em: agora_utc(),
      confirmada_por: usuario.id,
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
      `${inscricao.turma.codigo} está ${ROTULO_TURMA_TELA[inscricao.turma.situacao]!.toLowerCase()}: não há o que confirmar.`,
    );
  }

  // NUVEM: o pedido do link público sai da espera pela conferência da equipe
  // (não há e-mail a confirmar) — e só então passa a ocupar vaga
  const aceitando_pedido = origem === "AGUARDANDO_EMAIL" && destino === "INSCRITA";
  const recusando_pedido = origem === "AGUARDANDO_EMAIL" && destino === "CANCELADA";
  if (aceitando_pedido) {
    if (!T.aceita_inscricao(inscricao.turma)) {
      throw new RegraDaTurma(
        `${inscricao.turma.codigo} está ${ROTULO_TURMA_TELA[inscricao.turma.situacao]!.toLowerCase()} e não recebe inscrição.`,
      );
    }
    await _conferir_vaga(tx, inscricao.turma);
  }

  // aceitar o pedido do link já confirma a vaga (25/10/2026): a conferência é
  // a decisão, e um segundo clique em "Confirmar" não acrescentava nada
  const final = aceitando_pedido ? "CONFIRMADA" : destino;
  const campos: Partial<InscricaoRegistro> = {
    situacao: final,
    motivo_cancelamento: destino === "CANCELADA" ? limpo : null,
  };
  if (aceitando_pedido) {
    campos.conferida_em = opcoes.quando ?? agora_utc();
    campos.conferida_por = usuario.id;
  }
  if (final === "CONFIRMADA") {
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
      `${ROTULO_INSCRICAO[origem] ?? origem} -> ${ROTULO_INSCRICAO[final] ?? final}` +
      (limpo ? ` — ${limpo}` : ""),
    campo: "situacao",
    valor_anterior: origem,
    valor_novo: final,
    comentario: limpo,
    usuario,
  });
  // sair de INSCRITA é o que a equipe tinha para fazer: confirmar (ou cancelar);
  // aceitar o pedido do link também — a conferência foi o ato que ela pedia
  if (aceitando_pedido) await fechar_pendencia_de_confirmacao(tx, inscricao, usuario, { mesmo_inscrita: true });
  else await fechar_pendencia_de_confirmacao(tx, inscricao, usuario);
  // quem pediu pelo link e deixou e-mail fica sabendo (`avisos_inscricao.ts`)
  if (aceitando_pedido || recusando_pedido) {
    await avisos_inscricao.avisar(tx, inscricao, aceitando_pedido, usuario.id);
  }
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
// terceiro — o titular sai de `usuario.servidor_id`, que vem da sessão (ou,
// para o terceirizado e o discente, da própria conta: `titular_externo.ts`).
export const TIPO_PENDENCIA_CONFIRMAR = "TURMA_INSCRICAO_A_CONFIRMAR";

export function chave_da_pendencia_de_confirmacao(inscricao: { id: number }): string {
  return `inscricao-${inscricao.id}-a-confirmar`;
}

/**
 * Abre a tarefa que diz à equipe que há um pedido esperando confirmação.
 *
 * Sem responsável, de propósito: tarefa sem dono é do SETOR. A descrição não
 * nomeia ninguém (`identificador_publico`). O prazo é o da turma.
 */
export async function abrir_pendencia_de_confirmacao(
  tx: Executor,
  inscricao: InscricaoCarregada,
  usuario: UsuarioAtual | null = null,
  pelo_link = false,
): Promise<void> {
  const turma = inscricao.turma;
  const pendencia = await pendencias.abrir(tx, {
    tipo: TIPO_PENDENCIA_CONFIRMAR,
    chave: chave_da_pendencia_de_confirmacao(inscricao),
    descricao:
      `${turma.codigo} · ${turma.treinamento.nome} · pedida ` +
      (pelo_link ? "pelo link público · " : "pelo próprio participante ") +
      inscricao.participante.identificador_publico,
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
  opcoes: { mesmo_inscrita?: boolean } = {},
): Promise<void> {
  if (inscricao.situacao === "INSCRITA" && !opcoes.mesmo_inscrita) return;
  const [existente] = await tx
    .select()
    .from(tabela_pendencia)
    .where(eq(tabela_pendencia.chave, chave_da_pendencia_de_confirmacao(inscricao)));
  if (existente) await pendencias.concluir(tx, existente, usuario);
}

/**
 * O participante em nome de quem a conta pede a vaga. O servidor, pelo
 * `servidor_id` (o participante dele nasce em `de_servidor`); o terceirizado e
 * o discente, pelo participante ligado à conta (`titular_externo.ts`), que
 * nasce no primeiro pedido.
 */
async function _titular_da_conta(tx: Executor, usuario: UsuarioAtual): Promise<ParticipanteCarregado> {
  _exigir_titular(usuario);
  if (usuario.servidor_id === null) {
    try {
      return await titular_externo.garantir_participante_da_conta(tx, usuario);
    } catch (erro) {
      // o e-mail da conta que não serve de e-mail de participante: a frase
      // não repete o endereço
      if (erro instanceof servico_participante.DadosDoParticipante) {
        throw new RegraDaTurma(
          "O e-mail da sua conta não pôde ser usado no cadastro de participante." + FALE_COM_A_EQUIPE,
        );
      }
      throw erro;
    }
  }
  const [servidor] = await tx.select().from(tabela_servidor).where(eq(tabela_servidor.id, usuario.servidor_id));
  if (!servidor) {
    throw new RegraDaTurma(
      "O cadastro de servidor ligado a esta conta não existe mais. Avise a equipe responsável antes de tentar de novo.",
    );
  }
  return servico_participante.de_servidor(tx, servidor, usuario);
}

/** A conta sem titular (nem servidor ligado, nem perfil externo) não pede vaga. */
function _exigir_titular(usuario: UsuarioAtual): void {
  if (titular_externo.tem_titular(usuario)) return;
  throw new RegraDaTurma(
    "Sua conta não está ligada a um cadastro de servidor, e sem essa " +
      "ligação o sistema não tem em nome de quem inscrever. " +
      "Se você é servidor da UFVJM, informe os seus dados em Meu perfil (Sou servidor da UFVJM): a conta é ligada na hora.",
  );
}

/**
 * Fecho das recusas do pedido próprio ("inscrever-me"). A inscrição pública e
 * a tela do link tiram este trecho das mesmas frases (`.replace`), então o
 * texto mora aqui, num lugar só.
 */
export const FALE_COM_A_EQUIPE = " Fale com a equipe responsável.";

/**
 * `""` quando a turma recebe pedido do próprio; o motivo, quando não recebe.
 * Mais estreita que `aceita_inscricao`: só `INSCRICOES_ABERTAS`, dentro do prazo.
 */
export function aberta_a_pedido_proprio(turma: TurmaRegistro, hoje: string | null = null): string {
  const dia = hoje ?? datas_br.hoje();
  if (turma.situacao !== "INSCRICOES_ABERTAS") {
    return (
      `${turma.codigo} está ${ROTULO_TURMA_TELA[turma.situacao]!.toLowerCase()}: só se ` +
      "pede vaga em turma com inscrições abertas." +
      FALE_COM_A_EQUIPE
    );
  }
  if (turma.inscricao_aberta_ate !== null && turma.inscricao_aberta_ate < dia) {
    return `As inscrições de ${turma.codigo} fecharam em ${datas_br.numerica(turma.inscricao_aberta_ate)}.`;
  }
  // a turma que já começou não recebe pedido de fora, qualquer que seja o prazo
  // gravado (a turma antiga com "inscrições até" depois do início, por exemplo):
  // o retardatário do primeiro dia é inscrito pela equipe, que está na sala. O
  // dia do início já conta como começada: desistir também vale só até a véspera
  if (turma.data_inicio <= dia) {
    const quando = turma.data_inicio === dia ? "começa hoje" : `começou em ${datas_br.numerica(turma.data_inicio)}`;
    return `${turma.codigo} ${quando} e não recebe mais pedido de vaga.`;
  }
  return "";
}

/**
 * O cartaz: as turmas que recebem pedido do próprio, hoje. Sem escopo, e sem
 * nome. A que já começou sai (`aberta_a_pedido_proprio`); a lotada fica, porque
 * quem já está nela precisa vê-la — a tela a põe no fim.
 */
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
 * `servidor_id` da conta (`-1` no lugar de null para não virar `IS NULL`) ou,
 * para o terceirizado e o discente, ao participante ligado à conta.
 */
export async function inscricoes_do_titular(tx: Executor, usuario: UsuarioAtual): Promise<InscricaoCarregada[]> {
  const ids = await tx
    .select({ id: tabela_inscricao.id })
    .from(tabela_inscricao)
    .innerJoin(tabela_participante, eq(tabela_participante.id, tabela_inscricao.participante_id))
    .innerJoin(tabela_turma, eq(tabela_turma.id, tabela_inscricao.turma_id))
    .where(
      titular_externo.eh_titular_externo(usuario)
        ? eq(tabela_participante.usuario_id, usuario.id)
        : eq(tabela_participante.servidor_id, usuario.servidor_id ?? -1),
    )
    .orderBy(desc(tabela_turma.data_inicio), desc(tabela_turma.codigo));
  const saida: InscricaoCarregada[] = [];
  for (const { id } of ids) saida.push((await carregar_inscricao(tx, id))!);
  return saida;
}

/**
 * A inscrição que dá direito à agenda (.ics) da turma: a vaga é da pessoa
 * (inscrita, confirmada ou já apurada) e a turma não foi cancelada. O pedido
 * pelo link ainda em análise e a desistência ficam de fora.
 */
const COM_AGENDA: ReadonlySet<string> = new Set(["INSCRITA", "CONFIRMADA", "PRESENTE", "AUSENTE", "APROVADO", "REPROVADO"]);

export function tem_agenda(inscricao: { situacao: string; turma: { situacao: string } }): boolean {
  return COM_AGENDA.has(inscricao.situacao) && inscricao.turma.situacao !== "CANCELADA";
}

/**
 * O servidor pede a própria vaga. Desde 25/10/2026 a inscrição nasce
 * CONFIRMADA: a vaga foi conferida sob trava e ninguém precisa decidir nada
 * (antes nascia INSCRITA e abria a tarefa de confirmar para a equipe).
 */
export async function inscrever_se(
  tx: Executor,
  usuario: UsuarioAtual,
  turma: TurmaCarregada,
  opcoes: { hoje?: string | null } = {},
): Promise<InscricaoCarregada> {
  usuario.exigir("turma.inscrever_se");
  const hoje = opcoes.hoje ?? datas_br.hoje();
  _exigir_titular(usuario);

  const impedimento = aberta_a_pedido_proprio(turma, hoje);
  if (impedimento) throw new RegraDaTurma(impedimento);

  // depois do impedimento: o participante (do servidor ou da conta externa)
  // não nasce de um pedido que seria recusado de qualquer jeito
  const pessoa = await _titular_da_conta(tx, usuario);
  await _conferir_inscricao_unica(tx, turma, pessoa, true);
  await _conferir_vaga(tx, turma);

  const [linha] = await tx
    .insert(tabela_inscricao)
    .values({
      turma_id: turma.id,
      participante_id: pessoa.id,
      situacao: "CONFIRMADA",
      origem: "INTERNA",
      // quem pediu foi ele: `inscrito_por` é a conta do próprio titular
      inscrito_por: usuario.id,
      confirmada_em: agora_utc(),
      confirmada_por: usuario.id,
    })
    .returning();
  const inscricao: InscricaoCarregada = { ...linha!, turma, participante: pessoa, presencas: [] };
  await auditoria.registrar(tx, {
    entidade: "inscricao",
    entidade_id: inscricao.id,
    tipo_evento: "INSCRICAO_PEDIDA_PELO_TITULAR",
    descricao: `${turma.codigo}: ${pessoa.identificador_publico} pediu a própria vaga (confirmada: havia vaga)`,
    usuario,
  });
  return inscricao;
}

/**
 * O que o titular pode retirar: a inscrição viva e, desde 21/10/2026, o pedido
 * feito pelo link que a equipe ainda não conferiu (`AGUARDANDO_EMAIL`) — é o
 * mesmo arrependimento, e sem esta porta ele só saía pedindo à equipe.
 */
const DESISTIVEIS: ReadonlySet<string> = new Set(["INSCRITA", "CONFIRMADA", "AGUARDANDO_EMAIL"]);

/**
 * O participante é o da própria conta: o servidor ligado, ou — para o
 * terceirizado e o discente — o participante ligado à conta.
 */
export function e_do_titular(
  usuario: UsuarioAtual,
  participante: { servidor_id: number | null; usuario_id: number | null },
): boolean {
  if (titular_externo.eh_titular_externo(usuario)) return participante.usuario_id === usuario.id;
  return usuario.servidor_id !== null && participante.servidor_id === usuario.servidor_id;
}

/** Desistir cabe até a véspera do início, e só de inscrição ainda viva. */
export function pode_desistir(inscricao: InscricaoCarregada, hoje: string | null = null): boolean {
  const dia = hoje ?? datas_br.hoje();
  return DESISTIVEIS.has(inscricao.situacao) && !T.encerrada(inscricao.turma) && dia < inscricao.turma.data_inicio;
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
  if (!e_do_titular(usuario, inscricao.participante)) {
    // não é "permissão negada": a permissão ele tem; relação com a inscrição, não
    throw new RegraDaTurma("Esta inscrição não é sua.");
  }
  if (!pode_desistir(inscricao, hoje)) {
    if (!DESISTIVEIS.has(inscricao.situacao)) {
      throw new RegraDaTurma(
        `Sua inscrição em ${inscricao.turma.codigo} está ` +
          `${(ROTULO_INSCRICAO[inscricao.situacao] ?? inscricao.situacao).toLowerCase()} ` +
          "e não há o que desistir.",
      );
    }
    throw new RegraDaTurma(
      `${inscricao.turma.codigo} começou em ${datas_br.numerica(inscricao.turma.data_inicio)}: a partir do ` +
        "início a falta é registrada como ausência, não desfeita como " +
        "desistência." +
        FALE_COM_A_EQUIPE,
    );
  }

  const limpo =
    (opcoes.motivo ?? "").trim() ||
    (inscricao.situacao === "AGUARDANDO_EMAIL" ? "Pedido retirado pelo próprio." : "Desistência do próprio inscrito.");
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
