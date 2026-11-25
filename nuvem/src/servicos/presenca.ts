/**
 * Presença, nota e resultado da turma. Porte de `app/servicos/presenca.py`.
 *
 * Três regras governam este arquivo, e as três existem porque o número que sai
 * daqui decide se o certificado pode ser emitido:
 *
 * 1. **A frequência é calculada, nunca digitada.** Sai da soma das horas
 *    presentes em `turma_presenca` sobre a carga da turma.
 * 2. **O denominador é a carga da TURMA, não a do catálogo** (`carga_efetiva`).
 * 3. **O resultado nasce do fecho da turma, e não se digita.**
 *
 * Corrigir depois do fecho é possível e **é um ato registrado**: pede
 * `turma.concluir`, exige motivo por escrito, recalcula e audita. E inscrição
 * que já tem certificado NÃO anulado não recebe lançamento nenhum
 * (`_exigir_lancamento`).
 *
 * **Aritmética.** O Python fazia estas contas em `Decimal`. Aqui os números
 * andam como TEXTO decimal (o que o driver devolve para `numeric`) e as contas
 * são inteiras, em milionésimos (`BigInt`): 7,7 h + 0,3 h tem de dar 8 h, e não
 * 8,000000000000002 h — uma frequência que decide o certificado não pode
 * depender de arredondamento binário.
 */
import { and, count, eq, ne } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  agora_utc,
  certificado as tabela_certificado,
  inscricao as tabela_inscricao,
  inscricao_nota_disciplina as tabela_nota_disciplina,
  turma_presenca as tabela_presenca,
} from "../db/esquema/index.js";
import * as brigada from "../dominio/brigada.js";
import {
  INSCRICAO_COM_RESULTADO,
  INSCRICAO_FORA_DA_APURACAO,
  ROTULO_INSCRICAO,
  ROTULO_TURMA,
  ROTULO_TURMA_TELA,
  TransicaoInvalida,
  exigir_transicao_inscricao,
} from "../dominio/estados.js";
import { RegraViolada } from "../nucleo/erros.js";
import { Certificado as C, Inscricao as I, Turma as T } from "../dominio/treinamento.js";
import * as auditoria from "./auditoria.js";
import * as datas_br from "./datas_br.js";
import { nome_exibicao } from "./participante.js";
import type { UsuarioAtual } from "./rbac.js";
import { filtro } from "../web.js";
import * as carga from "../dominio/carga.js";
import * as carga_turma from "./carga_turma.js";
import {
  RegraDaTurma,
  gravar_inscricao,
  iniciar_pelo_lancamento,
  inscricoes_da_turma,
  mudar_situacao,
  type InscricaoCarregada,
  type PresencaRegistro,
  type TurmaCarregada,
  type TurmaRegistro,
} from "./turma.js";

// lote 4 (brigada): "85%", "77,5%" na tela; "77,5" no campo
filtro("nota_brigada", (v: string | null | undefined) => brigada.exibir_nota(v));
filtro("nota_campo", (v: string | null | undefined) => (v === null || v === undefined ? "" : brigada.exibir_nota(v).replace(/%$/, "")));

export const PRESENCA_LANCADA = "PRESENCA_LANCADA";
export const PRESENCA_EM_LOTE = "PRESENCA_EM_LOTE";
export const NOTA_LANCADA = "NOTA_LANCADA";
// lote 4: a nota de cada disciplina (brigada, 0 a 100)
export const NOTA_DISCIPLINA_LANCADA = "NOTA_DISCIPLINA_LANCADA";

/** A turma se avalia por disciplina (brigada)? O treinamento tem disciplinas cadastradas. */
export function por_disciplina(turma: TurmaCarregada): boolean {
  return (turma.treinamento.disciplinas ?? []).length > 0;
}

/** A nota lançada da disciplina, ou null. */
export function nota_da_disciplina(inscricao: InscricaoCarregada, disciplina_id: number): string | null {
  return (inscricao.notas_disciplina ?? []).find((n) => n.disciplina_id === disciplina_id)?.nota ?? null;
}

/** As disciplinas da turma ainda sem nota para a inscrição. */
export function disciplinas_sem_nota(turma: TurmaCarregada, inscricao: InscricaoCarregada) {
  return turma.treinamento.disciplinas.filter((d) => nota_da_disciplina(inscricao, d.id) === null);
}
export const TURMA_APURADA = "TURMA_APURADA";
export const RESULTADO_RETIFICADO = "RESULTADO_RETIFICADO";

// =====================================================================
// O `Decimal` do porte: texto decimal + contas inteiras
// =====================================================================
const ESCALA = 1_000_000n;
const RE_DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?$/;

/** '8,5' -> 8500000n (milionésimos). Lança com texto que não é número. */
export function escalado(valor: string | number | bigint): bigint {
  if (typeof valor === "bigint") return valor * ESCALA;
  const texto = String(valor).trim();
  const m = RE_DECIMAL.exec(texto);
  if (!m || (!m[2] && !m[3])) throw new RangeError(`não é número decimal: ${JSON.stringify(valor)}`);
  const inteira = BigInt(m[2] || "0");
  const frac = ((m[3] ?? "") + "000000").slice(0, 6);
  const resto = (m[3] ?? "").slice(6);
  let v = inteira * ESCALA + BigInt(frac);
  // além do sexto dígito, arredonda meio para cima — nenhuma coluna do módulo passa de 2
  if (resto && Number(resto[0]) >= 5) v += 1n;
  return m[1] === "-" ? -v : v;
}

/** -1, 0 ou 1, como `a < b`, `a == b`, `a > b` sobre `Decimal`. */
export function comparar(a: string | number, b: string | number): number {
  const x = escalado(a);
  const y = escalado(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Milionésimos -> texto decimal mínimo ('8', '7.5', '0.25'). */
export function texto_decimal(v: bigint): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const inteira = abs / ESCALA;
  const frac = (abs % ESCALA).toString().padStart(6, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${inteira}${frac ? "." + frac : ""}`;
}

/**
 * O `Decimal(texto)` do Python aplicado ao que se digita: devolve o texto
 * NORMALIZADO como o `str(Decimal)` o escreveria ('08.50' -> '8.50', '8.' ->
 * '8', '.5' -> '0.5'), ou `null` quando não é número.
 */
export function normalizar_decimal(bruto: string): string | null {
  const m = RE_DECIMAL.exec(bruto.trim());
  if (!m || (!m[2] && !m[3])) return null;
  const inteira = (m[2] || "0").replace(/^0+(?=\d)/, "");
  const frac = m[3] ?? "";
  return `${m[1] === "-" ? "-" : ""}${inteira}${frac ? "." + frac : ""}`;
}

/** `f"{Decimal(v):.2f}"` — meio para o par, o arredondamento do `format` do Decimal. */
function duas_casas(v: bigint): string {
  const passo = 10_000n; // milionésimos por centésimo
  const neg = v < 0n;
  const abs = neg ? -v : v;
  let q = abs / passo;
  const r = abs % passo;
  if (r * 2n > passo || (r * 2n === passo && q % 2n === 1n)) q += 1n;
  const txt = `${q / 100n}.${(q % 100n).toString().padStart(2, "0")}`;
  return (neg && q !== 0n ? "-" : "") + txt;
}

/**
 * 8, 7,5 e 75 — sem os zeros que o Numeric(5,2) arrasta. A tela e a trilha
 * mostram o mesmo texto.
 */
export function numero(valor: string | number | bigint | null | undefined): string {
  if (valor === null || valor === undefined) return "—";
  const v = typeof valor === "bigint" ? valor * ESCALA : escalado(valor);
  const texto = duas_casas(v).replace(/0+$/, "").replace(/\.$/, "");
  return (texto || "0").replace(".", ",");
}

// nas telas, o decimal sai como o setor lê: "8,3", "100", "7"
filtro("num", (v: string | number | bigint | null | undefined) => numero(v));
// lote 3: a carga só aparece por aqui — `t.carga_horaria_horas|carga(t.carga_unidade)`,
// `turma|carga_turma`, `presenca.quantidade|carga_base(turma.carga_unidade)`
filtro("carga", (v: string | number | null | undefined, unidade: string | null | undefined) => carga.exibir(v, unidade));
filtro("carga_turma", (turma: Parameters<typeof T.carga_texto>[0]) => T.carga_texto(turma));
filtro("carga_base", (v: number | string | null | undefined, unidade: string | null | undefined) =>
  carga.exibir_base(Number(v) || 0, carga.unidade_de(unidade)),
);
filtro("carga_campo", (v: number | string | null | undefined, unidade: string | null | undefined) =>
  carga.para_campo(Number(v) || 0, carga.unidade_de(unidade)),
);
// o valor da coluna (`4.5` horas, `10` tempos) no campo de digitação: "4h30", "10"
filtro("carga_campo_coluna", (v: string | null | undefined, unidade: string | null | undefined) => {
  const u = carga.unidade_de(unidade);
  return v === null || v === undefined || v === "" ? "" : carga.para_campo(carga.para_base(v, u), u);
});

/** Aceita 8, 8,5 e 8.5 — a vírgula é o separador que o setor digita. */
export function para_decimal(valor: string | number | null | undefined): string | null {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === "number") return normalizar_decimal(String(valor));
  const bruto = valor.trim().replace(",", ".");
  if (!bruto) return null;
  return normalizar_decimal(bruto);
}

// ---------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------
/** Os dias corridos entre início e fim (turma de NR acontece em sábado). */
export function dias_da_turma(turma: TurmaRegistro): string[] {
  const dias: string[] = [];
  for (let d = turma.data_inicio; d <= turma.data_fim; d = datas_br.somar_dias(d, 1)) dias.push(d);
  return dias;
}

/** Quantos inscritos em cada situação. */
export async function contagem_por_situacao(tx: Executor, turma: { id: number }): Promise<Record<string, number>> {
  const linhas = await tx
    .select({ situacao: tabela_inscricao.situacao, total: count() })
    .from(tabela_inscricao)
    .where(eq(tabela_inscricao.turma_id, turma.id))
    .groupBy(tabela_inscricao.situacao);
  return Object.fromEntries(linhas.map((l) => [l.situacao, Number(l.total)]));
}

/**
 * Presença sobre a carga EFETIVA da turma, em percentual, com duas
 * casas arredondadas meio para cima (o `quantize(ROUND_HALF_UP)`).
 */
export function frequencia_de(inscricao: InscricaoCarregada): string {
  // lote 3: minutos (ou tempos) presentes sobre a carga na mesma unidade-base — a razão é a
  // mesma das horas de antes, e o arredondamento também: nenhuma frequência muda de valor
  return carga.percentual(I.quantidade_presente(inscricao), T.carga_base(inscricao.turma));
}

/** Grava a frequência derivada. Chamada a cada lançamento e no fecho. */
export async function recalcular_frequencia(tx: Executor, inscricao: InscricaoCarregada): Promise<string> {
  const calculada = frequencia_de(inscricao);
  await gravar_inscricao(tx, inscricao, { frequencia_percentual: calculada });
  return calculada;
}

/** O resultado de um inscrito e por que ele é esse. */
export class Avaliacao {
  constructor(
    readonly situacao: string,
    readonly motivos: readonly string[] = [],
  ) {}
  get aprovado(): boolean {
    return this.situacao === "APROVADO";
  }
}

/**
 * APROVADO ou REPROVADO, com o motivo por escrito quando reprova. Recalcula a
 * frequência a partir dos lançamentos em vez de ler a coluna. A nota só entra
 * quando a turma declara `nota_minima_aprovacao`.
 */
export function avaliar(turma: TurmaCarregada, inscricao: InscricaoCarregada): Avaliacao {
  const motivos: string[] = [];
  if (!I.compareceu(inscricao)) motivos.push("não há presença registrada");
  const frequencia = frequencia_de(inscricao);
  if (comparar(frequencia, turma.frequencia_minima_percentual) < 0) {
    motivos.push(
      `frequência de ${numero(frequencia)}% abaixo do mínimo de ${numero(turma.frequencia_minima_percentual)}%`,
    );
  }
  if (por_disciplina(turma)) {
    // brigada (art. 40): o mínimo vale em CADA disciplina; a nota mínima da turma não se aplica
    for (const d of turma.treinamento.disciplinas) {
      const nota = nota_da_disciplina(inscricao, d.id);
      if (nota === null) motivos.push(`nota de ${d.nome} não lançada`);
      else if (brigada.comparar_nota(nota, d.nota_minima) < 0) {
        motivos.push(`nota de ${d.nome} ${brigada.exibir_nota(nota)} abaixo do mínimo de ${brigada.exibir_nota(d.nota_minima)}`);
      }
    }
  } else if (turma.nota_minima_aprovacao !== null) {
    if (inscricao.nota_final === null) {
      motivos.push(`nota não lançada, e a turma exige no mínimo ${numero(turma.nota_minima_aprovacao)}`);
    } else if (comparar(inscricao.nota_final, turma.nota_minima_aprovacao) < 0) {
      motivos.push(`nota ${numero(inscricao.nota_final)} abaixo da mínima ${numero(turma.nota_minima_aprovacao)}`);
    }
  }
  return motivos.length ? new Avaliacao("REPROVADO", motivos) : new Avaliacao("APROVADO");
}

/** Uma linha da grade dias x participantes da aba 3. */
export class LinhaDaGrade {
  constructor(
    readonly inscricao: InscricaoCarregada,
    /** `{'AAAA-MM-DD': presença}` */
    readonly por_dia: Record<string, PresencaRegistro>,
    /** o que conta para a frequência, na unidade-base da turma */
    readonly presente_base: number,
    readonly frequencia: string,
    readonly avaliacao: Avaliacao,
  ) {}
  /** "2h15", "3 tempos": o total presente pela função única de exibição */
  get presente_texto(): string {
    return carga.exibir_base(this.presente_base, T.unidade(this.inscricao.turma));
  }
  /** lote 4 (brigada): a nota lançada de cada disciplina, por id (`null` = sem nota) */
  get notas_por_disciplina(): Record<number, string | null> {
    return Object.fromEntries(
      (this.inscricao.turma.treinamento.disciplinas ?? []).map((d) => [d.id, nota_da_disciplina(this.inscricao, d.id)]),
    );
  }
  get abaixo_do_minimo(): boolean {
    return !this.avaliacao.aprovado;
  }
  /**
   * A coluna Situação em poucas palavras: o que falta para a pessoa passar
   * ("Faltam presença e nota"), ou o resultado já apurado com o motivo
   * principal. A frase inteira de `avaliacao.motivos` vai no `title` — quatro
   * linhas de texto por pessoa escondiam, numa grade de 30, quem está pendente.
   */
  get resumo(): string {
    const turma = this.inscricao.turma;
    const disciplinas = por_disciplina(turma);
    const falta_nota = disciplinas
      ? disciplinas_sem_nota(turma, this.inscricao).length > 0
      : turma.nota_minima_aprovacao !== null && this.inscricao.nota_final === null;
    const sem_presenca = !I.compareceu(this.inscricao);
    if (sem_presenca && falta_nota) return "Faltam presença e nota";
    if (sem_presenca) return "Falta presença";
    if (this.frequencia_baixa) return `Frequência abaixo de ${numero(turma.frequencia_minima_percentual)}%`;
    if (falta_nota) return disciplinas ? "Falta nota de disciplina" : "Falta a nota";
    if (disciplinas) {
      const abaixo = turma.treinamento.disciplinas.find(
        (d) => brigada.comparar_nota(nota_da_disciplina(this.inscricao, d.id)!, d.nota_minima) < 0,
      );
      if (abaixo) return `Nota de ${abaixo.nome} abaixo de ${brigada.exibir_nota(abaixo.nota_minima)}`;
    } else if (turma.nota_minima_aprovacao !== null && comparar(this.inscricao.nota_final!, turma.nota_minima_aprovacao) < 0) {
      return `Nota abaixo de ${numero(turma.nota_minima_aprovacao)}`;
    }
    return INSCRICAO_COM_RESULTADO.has(this.inscricao.situacao) ? "Critérios atendidos" : "Em dia";
  }
  /**
   * A frequência contra o mínimo da turma (a cor da barra). No Jinja era
   * `linha.frequencia < turma.frequencia_minima_percentual` entre dois
   * `Decimal`; aqui os dois são texto, e comparar texto diria que 100 < 75.
   */
  get frequencia_baixa(): boolean {
    return comparar(this.frequencia, this.inscricao.turma.frequencia_minima_percentual) < 0;
  }
}

/**
 * O motivo da reprovação numa frase só, para a tela da emissão: "reprovado(a):
 * frequência de 50% abaixo do mínimo de 75%". As mesmas palavras de `avaliar`,
 * que é quem decide — a frase não se recalcula em outro lugar.
 */
export function frase_de_reprovacao(turma: TurmaCarregada, inscricao: InscricaoCarregada): string {
  const motivos = avaliar(turma, inscricao).motivos;
  return "reprovado(a)" + (motivos.length ? `: ${motivos.join("; ")}` : "");
}

/** A grade da tela, montada uma vez e no serviço, com a MESMA `avaliar` do fecho. */
export async function grade_da_turma(tx: Executor, turma: TurmaCarregada): Promise<LinhaDaGrade[]> {
  return (await inscricoes_da_turma(tx, turma))
    .filter((i) => !INSCRICAO_FORA_DA_APURACAO.has(i.situacao))
    .map((i) => linha_da_grade(turma, i));
}

/** UMA linha, pela mesma conta que monta a grade inteira (troca parcial). */
export function linha_da_grade(turma: TurmaCarregada, inscricao: InscricaoCarregada): LinhaDaGrade {
  return new LinhaDaGrade(
    inscricao,
    Object.fromEntries(inscricao.presencas.map((p) => [p.data, p])),
    I.quantidade_presente(inscricao),
    frequencia_de(inscricao),
    avaliar(turma, inscricao),
  );
}

// ---------------------------------------------------------------------
// Guardas
// ---------------------------------------------------------------------
/** O certificado não anulado desta inscrição, se houver. */
export async function certificado_ativo(tx: Executor, inscricao: { id: number }) {
  const [achado] = await tx
    .select()
    .from(tabela_certificado)
    .where(and(eq(tabela_certificado.inscricao_id, inscricao.id), ne(tabela_certificado.situacao, "ANULADO")))
    .limit(1);
  return achado ?? null;
}

/**
 * Devolve o motivo da retificação, ou `null` quando é lançamento comum. A
 * permissão vem antes da situação; logo depois dela, a guarda do certificado.
 */
async function _exigir_lancamento(
  tx: Executor,
  usuario: UsuarioAtual,
  inscricao: InscricaoCarregada,
  motivo: string | null | undefined,
): Promise<string | null> {
  usuario.exigir("turma.avaliar");
  const turma = inscricao.turma;
  const emitido = await certificado_ativo(tx, inscricao);
  if (emitido) {
    throw new RegraDaTurma(
      `${nome_exibicao(inscricao.participante)} já tem o certificado ` +
        `${C.rotulo(emitido)} emitido, e certificado que saiu não se reescreve: ` +
        "anule-o com o motivo e reemita depois de corrigir. Enquanto ele " +
        "estiver válido, presença e nota desta inscrição ficam como estão.",
    );
  }
  const limpo = (motivo ?? "").trim() || null;
  if (turma.situacao === "CONCLUIDA") {
    usuario.exigir("turma.concluir");
    if (limpo === null) {
      throw new RegraDaTurma(
        `${turma.codigo} já foi concluída: corrigir presença ou nota agora ` +
          "é retificação, e retificação exige o motivo por escrito — o " +
          "resultado já foi comunicado a quem participou.",
      );
    }
    return limpo;
  }
  if (!aceita_lancamento(turma)) {
    throw new RegraDaTurma(
      `${turma.codigo} está ${ROTULO_TURMA_TELA[turma.situacao]!.toLowerCase()}: passe a ` +
        "turma para em andamento antes de lançar presença ou nota.",
    );
  }
  // T9 (lote 5): planejada que já começou passa a em andamento no primeiro lançamento
  await iniciar_pelo_lancamento(tx, usuario, turma);
  return null;
}

/**
 * Lançamento comum (sem retificação): turma em andamento, ou — NUVEM — ainda
 * planejada mas que já começou: o curso dado antes de alguém mexer no sistema.
 */
export function aceita_lancamento(turma: TurmaRegistro): boolean {
  if (turma.situacao === "EM_ANDAMENTO") return true;
  return turma.situacao === "PLANEJADA" && turma.data_inicio <= datas_br.hoje();
}

/**
 * O dia é da turma e já aconteceu. Presença é FATO: lançar o dia de amanhã
 * deixava a frequência em 100% antes de o curso acontecer, e com ela a turma
 * concluída e o certificado emitido.
 */
function _exigir_dia_da_turma(turma: TurmaRegistro, data: string): void {
  if (!(turma.data_inicio <= data && data <= turma.data_fim)) {
    throw new RegraDaTurma(
      `${datas_br.numerica(data)} não é dia de ${turma.codigo}, que vai de ` +
        `${datas_br.numerica(turma.data_inicio)} a ${datas_br.numerica(turma.data_fim)}.`,
    );
  }
  if (data > datas_br.hoje()) {
    throw new RegraDaTurma(`${datas_br.numerica(data)} ainda não chegou: presença só se lança do dia que já aconteceu.`);
  }
}

function _exigir_inscricao_lancavel(inscricao: InscricaoCarregada): void {
  if (INSCRICAO_FORA_DA_APURACAO.has(inscricao.situacao)) {
    throw new RegraDaTurma(
      `A inscrição de ${nome_exibicao(inscricao.participante)} está ` +
        `${ROTULO_INSCRICAO[inscricao.situacao]!.toLowerCase()} e não recebe lançamento.`,
    );
  }
}

/** Transição da máquina F disparada por lançamento, e não por escolha. */
async function _mover(
  tx: Executor,
  usuario: UsuarioAtual,
  inscricao: InscricaoCarregada,
  destino: string,
  opcoes: { tipo_evento?: string; comentario?: string | null; detalhe?: string | null } = {},
): Promise<void> {
  const origem = inscricao.situacao;
  if (origem === destino) return;
  exigir_transicao_inscricao(origem, destino);
  const campos: Partial<InscricaoCarregada> = { situacao: destino };
  if (destino === "CONFIRMADA" && inscricao.confirmada_em === null) {
    campos.confirmada_em = agora_utc();
    campos.confirmada_por = usuario.id;
  }
  await gravar_inscricao(tx, inscricao, campos);
  await auditoria.registrar(tx, {
    entidade: "inscricao",
    entidade_id: inscricao.id,
    tipo_evento: opcoes.tipo_evento ?? auditoria.ESTADO_ALTERADO,
    // RN-19 na ESCRITA: o `PTC-` no lugar do nome
    descricao:
      `${inscricao.turma.codigo} · ${inscricao.participante.identificador_publico}: ` +
      `${ROTULO_INSCRICAO[origem] ?? origem} -> ${ROTULO_INSCRICAO[destino] ?? destino}` +
      (opcoes.detalhe ? ` — ${opcoes.detalhe}` : ""),
    campo: "situacao",
    valor_anterior: origem,
    valor_novo: destino,
    comentario: opcoes.comentario ?? null,
    usuario,
  });
}

/** Quem assinou a folha está, por definição, confirmado na turma. */
async function _confirmar_por_presenca(tx: Executor, usuario: UsuarioAtual, inscricao: InscricaoCarregada) {
  if (inscricao.situacao === "INSCRITA") {
    await _mover(tx, usuario, inscricao, "CONFIRMADA", { detalhe: "confirmada pelo lançamento de presença" });
  }
}

/** Recalcula o resultado de quem já tem um, depois de uma retificação. */
async function _reapurar(tx: Executor, usuario: UsuarioAtual, inscricao: InscricaoCarregada, motivo: string) {
  const nova = avaliar(inscricao.turma, inscricao);
  await _mover(tx, usuario, inscricao, nova.situacao, {
    tipo_evento: RESULTADO_RETIFICADO,
    comentario: motivo,
    detalhe: nova.motivos.length ? nova.motivos.join("; ") : "critérios atendidos",
  });
  return nova;
}

/**
 * NUVEM: a carga da turma concluída foi corrigida (`retificacao.retificar_turma`)
 * — a frequência e o resultado de quem já tem um saem de novo, com o motivo.
 */
export async function reapurar_inscricao(
  tx: Executor,
  usuario: UsuarioAtual,
  inscricao: InscricaoCarregada,
  motivo: string,
): Promise<boolean> {
  await recalcular_frequencia(tx, inscricao);
  if (!INSCRICAO_COM_RESULTADO.has(inscricao.situacao)) return false;
  const antes = inscricao.situacao;
  await _reapurar(tx, usuario, inscricao, motivo);
  return inscricao.situacao !== antes;
}

/** PRESENTE (passando por CONFIRMADA) ou AUSENTE, conforme os lançamentos. */
async function _normalizar_comparecimento(tx: Executor, usuario: UsuarioAtual, inscricao: InscricaoCarregada) {
  const destino = I.compareceu(inscricao) ? "PRESENTE" : "AUSENTE";
  if (destino === "PRESENTE") await _confirmar_por_presenca(tx, usuario, inscricao);
  await _mover(tx, usuario, inscricao, destino);
}

async function _ajustar_situacao(
  tx: Executor,
  usuario: UsuarioAtual,
  inscricao: InscricaoCarregada,
  motivo: string | null,
) {
  if (INSCRICAO_COM_RESULTADO.has(inscricao.situacao)) {
    await _reapurar(tx, usuario, inscricao, motivo ?? "");
    return;
  }
  await _normalizar_comparecimento(tx, usuario, inscricao);
}

// ---------------------------------------------------------------------
// Presença
// ---------------------------------------------------------------------
/**
 * Um dia, um inscrito, uma linha. Relançar o mesmo dia corrige a linha — com
 * duas linhas para o mesmo dia a frequência passaria de 100%.
 */
export async function lancar_presenca(
  tx: Executor,
  usuario: UsuarioAtual,
  inscricao: InscricaoCarregada,
  d: {
    data: string;
    presente?: boolean;
    /** na unidade-base da turma: minutos em HORAS, tempos em TEMPOS (`dominio/carga.ts`) */
    quantidade?: number | null;
    justificativa?: string | null;
    motivo?: string | null;
  },
): Promise<PresencaRegistro> {
  const presente = d.presente ?? true;
  const turma = inscricao.turma;
  const retificacao = await _exigir_lancamento(tx, usuario, inscricao, d.motivo);
  _exigir_inscricao_lancavel(inscricao);

  _exigir_dia_da_turma(turma, d.data);

  const unidade = T.unidade(turma);
  const total_turma = T.carga_base(turma);
  const do_dia = carga_turma.carga_do_dia(turma, d.data);
  const txt = (q: number) => carga.exibir_base(q, unidade);
  let lancadas: number;
  if (!presente) {
    // ausência não acumula carga — a regra do `ck_turma_presenca_coerente`
    lancadas = 0;
  } else if (d.quantidade !== null && d.quantidade !== undefined) {
    lancadas = d.quantidade;
  } else if (turma.data_inicio === turma.data_fim) {
    // curso de um dia: o dia É a carga inteira
    lancadas = total_turma;
  } else {
    throw new RegraDaTurma(
      `${turma.codigo} tem mais de um dia: informe ${unidade === "TEMPOS" ? "os tempos" : "as horas"} deste dia. ` +
        "Assumir a carga inteira daria 100% a quem veio um dia só.",
    );
  }
  if (!Number.isInteger(lancadas) || lancadas < 0) {
    throw new RegraDaTurma(unidade === "TEMPOS" ? "Os tempos do dia são um número inteiro, zero ou mais." : "As horas do dia não podem ser negativas.");
  }
  if (presente && lancadas <= 0) {
    throw new RegraDaTurma(
      `Informe ${unidade === "TEMPOS" ? "os tempos" : "as horas"} do dia: presença de zero não é presença, e ` +
        "deixaria a frequência mentindo para mais.",
    );
  }
  // T5: o limite do dia é a carga DAQUELE dia, e não a da turma inteira
  if (lancadas > do_dia) {
    throw new RegraDaTurma(
      `${txt(lancadas)} em ${datas_br.numerica(d.data)} passa da carga daquele dia (${txt(do_dia)}). ` +
        "Se o dia teve mais carga, ajuste a carga por dia da turma.",
    );
  }

  const ja = inscricao.presencas.find((p) => p.data === d.data) ?? null;
  const outras = I.quantidade_presente(inscricao) - (ja !== null && ja.presente ? ja.quantidade : 0);
  const total = outras + lancadas;
  if (total > total_turma) {
    throw new RegraDaTurma(
      `O total lançado ficaria em ${txt(total)}, acima da ` +
        `carga da turma (${txt(total_turma)}). Confira os dias já lançados.`,
    );
  }

  const anterior = ja === null ? null : ([ja.presente, ja.quantidade] as const);
  const frequencia_antes = inscricao.frequencia_percentual;
  const limpa = (d.justificativa ?? "").trim() || null;
  const campos = {
    presente,
    quantidade: lancadas,
    justificativa: limpa,
    registrado_por: usuario.id,
    registrado_em: agora_utc(),
  };
  let linha: PresencaRegistro;
  if (ja === null) {
    const [nova] = await tx
      .insert(tabela_presenca)
      .values({ inscricao_id: inscricao.id, data: d.data, ...campos })
      .returning();
    // em memória fica o valor lançado, como no objeto do ORM depois do flush
    linha = nova!;
    inscricao.presencas.push(linha);
    inscricao.presencas.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
  } else {
    const [atual] = await tx.update(tabela_presenca).set(campos).where(eq(tabela_presenca.id, ja.id)).returning();
    Object.assign(ja, atual!);
    linha = ja;
  }

  const calculada = await recalcular_frequencia(tx, inscricao);
  await auditoria.registrar(tx, {
    entidade: "inscricao",
    entidade_id: inscricao.id,
    tipo_evento: PRESENCA_LANCADA,
    descricao:
      `${turma.codigo} · ${inscricao.participante.identificador_publico} · ${datas_br.numerica(d.data)}: ` +
      (presente ? "presente" : "ausente") +
      `, ${txt(lancadas)}` +
      (anterior !== null ? ` (antes: ${anterior[0] ? "presente" : "ausente"}, ${txt(anterior[1])})` : "") +
      ` — frequência ${numero(calculada)}%` +
      (limpa ? ` · ${limpa}` : ""),
    campo: "frequencia_percentual",
    // o valor, e não a formatação: o `str(Decimal)` que o Python gravava
    valor_anterior: frequencia_antes,
    valor_novo: calculada,
    comentario: retificacao,
    usuario,
  });
  await _ajustar_situacao(tx, usuario, inscricao, retificacao);
  return linha;
}

/**
 * Curso de um dia só: todo mundo presente, com a carga efetiva da turma.
 * Recusado em turma de mais de um dia — num clique só, quem faltou um dia
 * sairia com 100%.
 */
export async function marcar_todos_presentes(
  tx: Executor,
  usuario: UsuarioAtual,
  turma: TurmaCarregada,
  opcoes: { motivo?: string | null } = {},
): Promise<InscricaoCarregada[]> {
  usuario.exigir("turma.avaliar");
  _exigir_dia_da_turma(turma, turma.data_inicio);
  if (turma.data_inicio !== turma.data_fim) {
    const dias = dias_da_turma(turma).length;
    throw new RegraDaTurma(
      `${turma.codigo} tem ${dias} dias: marque dia a dia. Num clique só, ` +
        "quem faltou um dia sairia com 100% de frequência.",
    );
  }
  const alcancadas = (await inscricoes_da_turma(tx, turma)).filter((i) => !INSCRICAO_FORA_DA_APURACAO.has(i.situacao));
  if (!alcancadas.length) throw new RegraDaTurma(`${turma.codigo} não tem ninguém para marcar presente.`);
  for (const inscricao of alcancadas) {
    await lancar_presenca(tx, usuario, inscricao, {
      data: turma.data_inicio,
      presente: true,
      quantidade: T.carga_base(turma),
      motivo: opcoes.motivo,
    });
  }
  await auditoria.registrar(tx, {
    entidade: "turma",
    entidade_id: turma.id,
    tipo_evento: PRESENCA_EM_LOTE,
    descricao:
      `${turma.codigo}: ${alcancadas.length} presença(s) de ` +
      `${T.carga_texto(turma)} em ${datas_br.numerica(turma.data_inicio)}`,
    comentario: (opcoes.motivo ?? "").trim() || null,
    usuario,
  });
  return alcancadas;
}

/**
 * Uma COLUNA da grade: todo mundo presente NAQUELE dia — a unidade em que a
 * folha de presença chega em papel. Sobrescreve o dia; `lancar_presenca`
 * continua sendo quem confere o dia e as horas.
 */
export async function marcar_dia_presente(
  tx: Executor,
  usuario: UsuarioAtual,
  turma: TurmaCarregada,
  d: { data: string; quantidade?: number | null; motivo?: string | null },
): Promise<InscricaoCarregada[]> {
  usuario.exigir("turma.avaliar");
  _exigir_dia_da_turma(turma, d.data);
  const alcancadas = (await inscricoes_da_turma(tx, turma)).filter((i) => !INSCRICAO_FORA_DA_APURACAO.has(i.situacao));
  if (!alcancadas.length) throw new RegraDaTurma(`${turma.codigo} não tem ninguém para marcar presente.`);
  for (const inscricao of alcancadas) {
    await lancar_presenca(tx, usuario, inscricao, {
      data: d.data,
      presente: true,
      quantidade: d.quantidade ?? null,
      motivo: d.motivo,
    });
  }
  await auditoria.registrar(tx, {
    entidade: "turma",
    entidade_id: turma.id,
    tipo_evento: PRESENCA_EM_LOTE,
    descricao:
      `${turma.codigo}: ${alcancadas.length} presença(s) em ${datas_br.numerica(d.data)}` +
      (d.quantidade !== null && d.quantidade !== undefined ? `, ${carga.exibir_base(d.quantidade, T.unidade(turma))}` : ""),
    comentario: (d.motivo ?? "").trim() || null,
    usuario,
  });
  return alcancadas;
}

// ---------------------------------------------------------------------
// A folha inteira de uma vez
// ---------------------------------------------------------------------
/** O que a grade enviou: as caixas marcadas, as horas ajustadas e as notas. */
export interface Folha {
  /** `"<inscricao_id>_<AAAA-MM-DD>"` de cada caixa marcada (presente) */
  marcadas: ReadonlySet<string>;
  /** o digitado no "ajustar" (horas como 2h15 ou 2,25; tempos inteiros), pela mesma chave; vazio usa a carga do dia */
  quantidades: ReadonlyMap<string, string>;
  /** nota digitada por inscrição; `null` é "apagar a nota" (pedido explícito) */
  notas: ReadonlyMap<number, string | null>;
  /** lote 4 (brigada): a nota de cada disciplina, pela chave `"<inscricao_id>_<disciplina_id>"`; `null` apaga */
  notas_disciplina?: ReadonlyMap<string, string | null>;
  motivo?: string | null;
}

export interface FolhaSalva {
  presencas: number;
  notas: number;
  recusas: string[];
}

export function chave_da_celula(inscricao_id: number, dia: string): string {
  return `${inscricao_id}_${dia}`;
}

/**
 * NUVEM: a grade inteira num envio — a caixa de cada dia e um único "Salvar
 * folha". Antes eram três controles por célula (horas, presente, falta) e um
 * envio por clique: 30 pessoas × 2 dias, 60 envios no dia do curso.
 *
 * Cada célula continua passando por `lancar_presenca`, com as mesmas guardas
 * (dia que já aconteceu, carga, certificado emitido, retificação com motivo), e
 * no seu savepoint: a que trava vai para `recusas` sem derrubar as outras. Só
 * se grava o que MUDOU — a trilha não ganha uma linha por caixa que já estava
 * como estava.
 *
 * Caixa desmarcada sem lançamento só vira FALTA quando o dia está na folha
 * (alguém marcado nele, ou já lançado): a folha do dia de amanhã, ainda em
 * branco, não pode virar trinta faltas por um clique em "Salvar".
 *
 * As horas: a caixa marcada vale a carga do dia (`horas_por_dia`); quem chegou
 * atrasado tem as horas ajustadas à parte, porque a frequência é por hora.
 */
export async function salvar_folha(
  tx: Executor,
  usuario: UsuarioAtual,
  turma: TurmaCarregada,
  folha: Folha,
  quem: (inscricao: InscricaoCarregada) => string,
): Promise<FolhaSalva> {
  usuario.exigir("turma.avaliar");
  const saida: FolhaSalva = { presencas: 0, notas: 0, recusas: [] };
  const hoje = datas_br.hoje();
  const inscricoes = (await inscricoes_da_turma(tx, turma)).filter((i) => !INSCRICAO_FORA_DA_APURACAO.has(i.situacao));
  const padrao = new Map(carga_turma.carga_por_dia(turma));
  const unidade = T.unidade(turma);
  const dias = dias_da_turma(turma).filter((dia) => dia <= hoje);
  const na_folha = new Set(
    dias.filter((dia) =>
      inscricoes.some((i) => folha.marcadas.has(chave_da_celula(i.id, dia)) || i.presencas.some((p) => p.data === dia)),
    ),
  );
  const tentar = async (rotulo: string, f: (sp: Executor) => Promise<unknown>): Promise<boolean> => {
    try {
      await tx.transaction(async (sp) => f(sp as Executor));
      return true;
    } catch (erro) {
      if (!(erro instanceof RegraViolada || erro instanceof TransicaoInvalida)) throw erro;
      saida.recusas.push(`${rotulo}: ${erro.message.replace(/\.$/, "")}`);
      return false;
    }
  };

  for (const inscricao of inscricoes) {
    for (const dia of dias) {
      const chave = chave_da_celula(inscricao.id, dia);
      const presente = folha.marcadas.has(chave);
      const ja = inscricao.presencas.find((p) => p.data === dia) ?? null;
      const digitadas = (folha.quantidades.get(chave) ?? "").trim();
      const rotulo = `${quem(inscricao)}, ${datas_br.numerica(dia)}`;
      let lida: number | null = null;
      if (presente && digitadas) {
        try {
          lida = carga.ler(digitadas, unidade, unidade === "TEMPOS" ? "os tempos do dia" : "as horas do dia");
        } catch (e) {
          if (!(e instanceof carga.CargaInvalida)) throw e;
          saida.recusas.push(`${rotulo}: ${e.message.replace(/\.$/, "")}`);
          continue;
        }
      }
      if (ja) {
        // caixa marcada sem nada digitado num dia já presente fica como está: a folha
        // reenviada não reescreve o que foi lançado (nem a presença convertida das horas)
        const igual = ja.presente === presente && (!presente || lida === null || ja.quantidade === lida);
        if (igual) continue;
      } else if (!presente && !na_folha.has(dia)) {
        continue;
      }
      const quantidade = presente ? (lida ?? padrao.get(dia) ?? null) : null;
      const feito = await tentar(rotulo, (sp) =>
        lancar_presenca(sp, usuario, inscricao, { data: dia, presente, quantidade, motivo: folha.motivo }),
      );
      if (feito) saida.presencas += 1;
    }
  }
  for (const inscricao of inscricoes) {
    if (!folha.notas.has(inscricao.id)) continue;
    const nota = folha.notas.get(inscricao.id)!;
    const anterior = inscricao.nota_final;
    if (nota === anterior || (nota !== null && anterior !== null && comparar(nota, anterior) === 0)) continue;
    const feito = await tentar(`${quem(inscricao)}, nota`, (sp) =>
      lancar_nota(sp, usuario, inscricao, nota, { motivo: folha.motivo }),
    );
    if (feito) saida.notas += 1;
  }
  for (const inscricao of inscricoes) {
    for (const d of turma.treinamento.disciplinas ?? []) {
      const chave = `${inscricao.id}_${d.id}`;
      if (!folha.notas_disciplina?.has(chave)) continue;
      const nota = folha.notas_disciplina.get(chave)!;
      const anterior = nota_da_disciplina(inscricao, d.id);
      if (nota === anterior || (nota !== null && anterior !== null && brigada.comparar_nota(nota, anterior) === 0)) continue;
      const feito = await tentar(`${quem(inscricao)}, nota de ${d.nome}`, (sp) =>
        lancar_nota_disciplina(sp, usuario, inscricao, d.id, nota, { motivo: folha.motivo }),
      );
      if (feito) saida.notas += 1;
    }
  }
  return saida;
}

// ---------------------------------------------------------------------
// Turma já realizada
// ---------------------------------------------------------------------
export const TURMA_REALIZADA = "TURMA_REALIZADA_REGISTRADA";

/** O que `registrar_turma_realizada` fez, para a mensagem da tela. */
export interface TurmaRealizada {
  presentes: number;
  concluida: boolean;
}

/** A carga de cada dia, na unidade-base (`carga_turma.carga_por_dia`). */
export function carga_por_dia(turma: TurmaCarregada): [string, number][] {
  return carga_turma.carga_por_dia(turma).filter(([, q]) => q > 0);
}

/**
 * NUVEM: o curso que já aconteceu, registrado num clique — todo inscrito
 * presente pela carga inteira e a turma concluída (com a apuração), na mesma
 * transação e com a trilha de cada passo. Só para turma cujas datas já
 * passaram e sem presença lançada (o clique não sobrescreve folha conferida).
 * Com nota mínima a turma NÃO se conclui: nota não se inventa — lança-se a
 * presença, a turma fica em andamento e a nota se lança na aba.
 */
export async function registrar_turma_realizada(
  tx: Executor,
  usuario: UsuarioAtual,
  turma: TurmaCarregada,
): Promise<TurmaRealizada> {
  usuario.exigir("turma.avaliar");
  usuario.exigir("turma.concluir");
  if (!["PLANEJADA", "INSCRICOES_ABERTAS", "EM_ANDAMENTO"].includes(turma.situacao)) {
    throw new RegraDaTurma(`${turma.codigo} está ${ROTULO_TURMA_TELA[turma.situacao]!.toLowerCase()}.`);
  }
  if (turma.data_fim > datas_br.hoje()) {
    throw new RegraDaTurma(
      `${turma.codigo} termina em ${datas_br.numerica(turma.data_fim)}: só se registra como realizada depois disso.`,
    );
  }
  const alcancadas = (await inscricoes_da_turma(tx, turma)).filter((i) => !INSCRICAO_FORA_DA_APURACAO.has(i.situacao));
  if (!alcancadas.length) throw new RegraDaTurma(`${turma.codigo} não tem ninguém inscrito: inscreva os participantes antes.`);
  if (alcancadas.some((i) => i.presencas.length)) {
    throw new RegraDaTurma(
      `${turma.codigo} já tem presença lançada: confira a aba Presença e notas e conclua a turma por lá.`,
    );
  }
  // inscrição aberta não recebe lançamento; planejada que já começou, sim — e o primeiro
  // lançamento a passa para em andamento (T9), aqui uma vez, com a turma desta função
  if (turma.situacao === "INSCRICOES_ABERTAS") await mudar_situacao(tx, usuario, turma, "EM_ANDAMENTO");
  await iniciar_pelo_lancamento(tx, usuario, turma);

  const dias = carga_por_dia(turma);
  if (turma.data_inicio === turma.data_fim) {
    await marcar_todos_presentes(tx, usuario, turma);
  } else {
    for (const [data, quantidade] of dias) await marcar_dia_presente(tx, usuario, turma, { data, quantidade });
  }
  const com_nota = turma.nota_minima_aprovacao !== null;
  await auditoria.registrar(tx, {
    entidade: "turma",
    entidade_id: turma.id,
    tipo_evento: TURMA_REALIZADA,
    descricao:
      `${turma.codigo}: ${alcancadas.length} presente(s) pela carga de ${T.carga_texto(turma)}` +
      (com_nota ? " — aguarda as notas para concluir" : " e turma concluída"),
    usuario,
  });
  if (com_nota) {
    if (turma.situacao === "PLANEJADA") await mudar_situacao(tx, usuario, turma, "EM_ANDAMENTO");
    return { presentes: alcancadas.length, concluida: false };
  }
  await mudar_situacao(tx, usuario, turma, "CONCLUIDA");
  return { presentes: alcancadas.length, concluida: true };
}

// ---------------------------------------------------------------------
// Nota
// ---------------------------------------------------------------------
/** A nota da avaliação, de 0 a 10. `null` apaga a nota lançada (pedido explícito). */
export async function lancar_nota(
  tx: Executor,
  usuario: UsuarioAtual,
  inscricao: InscricaoCarregada,
  nota: string | null,
  opcoes: { motivo?: string | null } = {},
): Promise<InscricaoCarregada> {
  const retificacao = await _exigir_lancamento(tx, usuario, inscricao, opcoes.motivo);
  _exigir_inscricao_lancavel(inscricao);
  if (por_disciplina(inscricao.turma)) {
    throw new RegraDaTurma("Esta turma tem nota por disciplina (0 a 100): lance a nota de cada disciplina.");
  }
  if (nota !== null && !(comparar(nota, "0") >= 0 && comparar(nota, "10") <= 0)) {
    throw new RegraDaTurma("Nota: use um valor entre 0 e 10.");
  }
  const anterior = inscricao.nota_final;
  // `Decimal('8.50') == Decimal('8.5')`: a comparação é de valor, não de texto
  if (anterior === nota || (anterior !== null && nota !== null && comparar(anterior, nota) === 0)) return inscricao;
  await gravar_inscricao(tx, inscricao, { nota_final: nota });
  await auditoria.registrar(tx, {
    entidade: "inscricao",
    entidade_id: inscricao.id,
    tipo_evento: NOTA_LANCADA,
    descricao:
      `${inscricao.turma.codigo} · ${inscricao.participante.identificador_publico}: ` +
      `nota ${numero(anterior)} -> ${numero(nota)}`,
    campo: "nota_final",
    valor_anterior: anterior,
    valor_novo: nota,
    comentario: retificacao,
    usuario,
  });
  if (INSCRICAO_COM_RESULTADO.has(inscricao.situacao)) {
    await _reapurar(tx, usuario, inscricao, retificacao ?? "");
  }
  return inscricao;
}

/**
 * A nota de UMA disciplina (brigada), de 0 a 100. `null` apaga a nota lançada. Com todas as
 * disciplinas lançadas, `nota_final` passa a ser a média simples delas (art. 42, § 3º), na escala
 * 100; faltando alguma, a nota final fica vazia.
 */
export async function lancar_nota_disciplina(
  tx: Executor,
  usuario: UsuarioAtual,
  inscricao: InscricaoCarregada,
  disciplina_id: number,
  nota: string | null,
  opcoes: { motivo?: string | null } = {},
): Promise<InscricaoCarregada> {
  const retificacao = await _exigir_lancamento(tx, usuario, inscricao, opcoes.motivo);
  _exigir_inscricao_lancavel(inscricao);
  // "85" e "85,0" são 85.00: a nota se grava sempre com duas casas
  try {
    nota = nota === null ? null : brigada.ler_nota(nota);
  } catch (erro) {
    if (erro instanceof brigada.NotaInvalida) throw new RegraDaTurma(erro.message);
    throw erro;
  }
  const disciplina = inscricao.turma.treinamento.disciplinas.find((d) => d.id === disciplina_id);
  if (!disciplina) throw new RegraDaTurma("Esta disciplina não é do treinamento da turma.");
  const anterior = nota_da_disciplina(inscricao, disciplina_id);
  if (anterior === nota || (anterior !== null && nota !== null && brigada.comparar_nota(anterior, nota) === 0)) return inscricao;
  const notas = (inscricao.notas_disciplina ?? []).filter((n) => n.disciplina_id !== disciplina_id);
  if (nota === null) {
    await tx
      .delete(tabela_nota_disciplina)
      .where(and(eq(tabela_nota_disciplina.inscricao_id, inscricao.id), eq(tabela_nota_disciplina.disciplina_id, disciplina_id)));
  } else {
    const [gravada] = await tx
      .insert(tabela_nota_disciplina)
      .values({ inscricao_id: inscricao.id, disciplina_id, nota, lancada_por: usuario.id })
      .onConflictDoUpdate({
        target: [tabela_nota_disciplina.inscricao_id, tabela_nota_disciplina.disciplina_id],
        set: { nota, lancada_por: usuario.id, lancada_em: agora_utc() },
      })
      .returning();
    notas.push(gravada!);
  }
  inscricao.notas_disciplina = notas;
  const completas = inscricao.turma.treinamento.disciplinas.every((d) => notas.some((n) => n.disciplina_id === d.id));
  const final = completas ? brigada.media(notas.map((n) => n.nota)) : null;
  await gravar_inscricao(tx, inscricao, { nota_escala: 100, nota_final: final });
  await auditoria.registrar(tx, {
    entidade: "inscricao",
    entidade_id: inscricao.id,
    tipo_evento: NOTA_DISCIPLINA_LANCADA,
    descricao:
      `${inscricao.turma.codigo} · ${inscricao.participante.identificador_publico}: ` +
      `${disciplina.nome} ${brigada.exibir_nota(anterior)} -> ${brigada.exibir_nota(nota)}` +
      ` (nota final ${brigada.exibir_nota(final)})`,
    campo: "nota_disciplina",
    valor_anterior: anterior,
    valor_novo: nota,
    comentario: retificacao,
    usuario,
  });
  if (INSCRICAO_COM_RESULTADO.has(inscricao.situacao)) {
    await _reapurar(tx, usuario, inscricao, retificacao ?? "");
  }
  return inscricao;
}

// ---------------------------------------------------------------------
// Fecho da turma
// ---------------------------------------------------------------------
/** O que o fecho da turma produziu, para a mensagem da tela. */
export class Apuracao {
  aprovados: InscricaoCarregada[] = [];
  reprovados: InscricaoCarregada[] = [];
  fora: InscricaoCarregada[] = [];
  get total(): number {
    return this.aprovados.length + this.reprovados.length;
  }
  get resumo(): string {
    if (!this.total) return "nenhum inscrito a apurar";
    return `${this.aprovados.length} aprovado(s), ${this.reprovados.length} reprovado(s)`;
  }
}

/**
 * Calcula a frequência de cada inscrito e atribui APROVADO/REPROVADO. Chamada
 * de dentro de `turma.mudar_situacao` (a permissão já foi exigida lá). Turma
 * sem inscrito conclui normalmente, com apuração vazia.
 */
export async function apurar_turma(tx: Executor, usuario: UsuarioAtual, turma: TurmaCarregada): Promise<Apuracao> {
  const apuracao = new Apuracao();
  for (const inscricao of await inscricoes_da_turma(tx, turma)) {
    if (INSCRICAO_FORA_DA_APURACAO.has(inscricao.situacao)) {
      apuracao.fora.push(inscricao);
      continue;
    }
    await recalcular_frequencia(tx, inscricao);
    // o estado intermediário impede APROVADO para quem nunca compareceu
    await _normalizar_comparecimento(tx, usuario, inscricao);
    const resultado = avaliar(turma, inscricao);
    await _mover(tx, usuario, inscricao, resultado.situacao, {
      detalhe: resultado.motivos.length
        ? resultado.motivos.join("; ")
        : `frequência ${numero(inscricao.frequencia_percentual)}%`,
    });
    (resultado.aprovado ? apuracao.aprovados : apuracao.reprovados).push(inscricao);
  }
  await auditoria.registrar(tx, {
    entidade: "turma",
    entidade_id: turma.id,
    tipo_evento: TURMA_APURADA,
    descricao: `${turma.codigo}: ${apuracao.resumo}`,
    usuario,
  });
  return apuracao;
}
