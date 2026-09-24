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
  turma_presenca as tabela_presenca,
} from "../db/esquema/index.js";
import {
  INSCRICAO_COM_RESULTADO,
  INSCRICAO_FORA_DA_APURACAO,
  ROTULO_INSCRICAO,
  ROTULO_TURMA,
  exigir_transicao_inscricao,
} from "../dominio/estados.js";
import { Certificado as C, Inscricao as I, Turma as T } from "../dominio/treinamento.js";
import * as auditoria from "./auditoria.js";
import * as datas_br from "./datas_br.js";
import { nome_exibicao } from "./participante.js";
import type { UsuarioAtual } from "./rbac.js";
import {
  RegraDaTurma,
  gravar_inscricao,
  inscricoes_da_turma,
  type InscricaoCarregada,
  type PresencaRegistro,
  type TurmaCarregada,
  type TurmaRegistro,
} from "./turma.js";

export const PRESENCA_LANCADA = "PRESENCA_LANCADA";
export const PRESENCA_EM_LOTE = "PRESENCA_EM_LOTE";
export const NOTA_LANCADA = "NOTA_LANCADA";
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
 * Horas presentes sobre a carga EFETIVA da turma, em percentual, com duas
 * casas arredondadas meio para cima (o `quantize(ROUND_HALF_UP)`).
 */
export function frequencia_de(inscricao: InscricaoCarregada): string {
  const carga = escalado(T.carga_efetiva(inscricao.turma) || "0");
  if (carga <= 0n) return "0.00";
  const horas = escalado(I.horas_presentes(inscricao));
  const numerador = horas * 10_000n; // percentual (x100) em centésimos (x100)
  let q = numerador / carga;
  if ((numerador % carga) * 2n >= carga) q += 1n;
  return `${q / 100n}.${(q % 100n).toString().padStart(2, "0")}`;
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
  if (turma.nota_minima_aprovacao !== null) {
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
    readonly horas: string,
    readonly frequencia: string,
    readonly avaliacao: Avaliacao,
  ) {}
  get abaixo_do_minimo(): boolean {
    return !this.avaliacao.aprovado;
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
    I.horas_presentes(inscricao),
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
  if (turma.situacao !== "EM_ANDAMENTO") {
    throw new RegraDaTurma(
      `${turma.codigo} está ${ROTULO_TURMA[turma.situacao]!.toLowerCase()}: passe a ` +
        "turma para em andamento antes de lançar presença ou nota.",
    );
  }
  return null;
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
    horas?: string | null;
    justificativa?: string | null;
    motivo?: string | null;
  },
): Promise<PresencaRegistro> {
  const presente = d.presente ?? true;
  const turma = inscricao.turma;
  const retificacao = await _exigir_lancamento(tx, usuario, inscricao, d.motivo);
  _exigir_inscricao_lancavel(inscricao);

  if (!(turma.data_inicio <= d.data && d.data <= turma.data_fim)) {
    throw new RegraDaTurma(
      `${datas_br.numerica(d.data)} não é dia de ${turma.codigo}, que vai de ` +
        `${datas_br.numerica(turma.data_inicio)} a ${datas_br.numerica(turma.data_fim)}.`,
    );
  }

  const carga = T.carga_efetiva(turma);
  let lancadas: string;
  if (!presente) {
    // ausência não acumula hora — a regra do `ck_turma_presenca_coerente`
    lancadas = "0";
  } else if (d.horas !== null && d.horas !== undefined) {
    lancadas = d.horas;
  } else if (turma.data_inicio === turma.data_fim) {
    // curso de um dia: o dia É a carga inteira
    lancadas = carga;
  } else {
    throw new RegraDaTurma(
      `${turma.codigo} tem mais de um dia: informe as horas deste dia. ` +
        "Assumir a carga inteira daria 100% a quem veio um dia só.",
    );
  }
  if (presente && comparar(lancadas, "0") <= 0) {
    throw new RegraDaTurma(
      "Informe as horas do dia: presença de zero hora não é presença, e " + "deixaria a frequência mentindo para mais.",
    );
  }
  if (comparar(lancadas, carga) > 0) {
    throw new RegraDaTurma(`${numero(lancadas)}h num dia só passa da carga da turma (${numero(carga)}h).`);
  }

  const ja = inscricao.presencas.find((p) => p.data === d.data) ?? null;
  const outras = escalado(I.horas_presentes(inscricao)) - (ja !== null && ja.presente ? escalado(ja.horas) : 0n);
  const total = outras + escalado(lancadas);
  if (total > escalado(carga)) {
    throw new RegraDaTurma(
      `O total lançado ficaria em ${numero(texto_decimal(total))}h, acima da ` +
        `carga da turma (${numero(carga)}h). Confira os dias já lançados.`,
    );
  }

  const anterior = ja === null ? null : ([ja.presente, ja.horas] as const);
  const frequencia_antes = inscricao.frequencia_percentual;
  const limpa = (d.justificativa ?? "").trim() || null;
  const campos = {
    presente,
    horas: lancadas,
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
    linha = { ...nova!, horas: lancadas };
    inscricao.presencas.push(linha);
    inscricao.presencas.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
  } else {
    const [atual] = await tx.update(tabela_presenca).set(campos).where(eq(tabela_presenca.id, ja.id)).returning();
    Object.assign(ja, atual!, { horas: lancadas });
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
      `, ${numero(lancadas)}h` +
      (anterior !== null ? ` (antes: ${anterior[0] ? "presente" : "ausente"}, ${numero(anterior[1])}h)` : "") +
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
      horas: T.carga_efetiva(turma),
      motivo: opcoes.motivo,
    });
  }
  await auditoria.registrar(tx, {
    entidade: "turma",
    entidade_id: turma.id,
    tipo_evento: PRESENCA_EM_LOTE,
    descricao:
      `${turma.codigo}: ${alcancadas.length} presença(s) de ` +
      `${numero(T.carga_efetiva(turma))}h em ${datas_br.numerica(turma.data_inicio)}`,
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
  d: { data: string; horas?: string | null; motivo?: string | null },
): Promise<InscricaoCarregada[]> {
  usuario.exigir("turma.avaliar");
  if (!(turma.data_inicio <= d.data && d.data <= turma.data_fim)) {
    throw new RegraDaTurma(
      `${datas_br.numerica(d.data)} não é dia de ${turma.codigo}, que vai de ` +
        `${datas_br.numerica(turma.data_inicio)} a ${datas_br.numerica(turma.data_fim)}.`,
    );
  }
  const alcancadas = (await inscricoes_da_turma(tx, turma)).filter((i) => !INSCRICAO_FORA_DA_APURACAO.has(i.situacao));
  if (!alcancadas.length) throw new RegraDaTurma(`${turma.codigo} não tem ninguém para marcar presente.`);
  for (const inscricao of alcancadas) {
    await lancar_presenca(tx, usuario, inscricao, {
      data: d.data,
      presente: true,
      horas: d.horas ?? null,
      motivo: d.motivo,
    });
  }
  await auditoria.registrar(tx, {
    entidade: "turma",
    entidade_id: turma.id,
    tipo_evento: PRESENCA_EM_LOTE,
    descricao:
      `${turma.codigo}: ${alcancadas.length} presença(s) em ${datas_br.numerica(d.data)}` +
      (d.horas !== null && d.horas !== undefined ? `, ${numero(d.horas)}h` : ""),
    comentario: (d.motivo ?? "").trim() || null,
    usuario,
  });
  return alcancadas;
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
