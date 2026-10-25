/**
 * Serviço do processo: transições de estado, kanban e SLA.
 * Porte de `app/servicos/processo.py`.
 *
 * No Python o serviço mexia no objeto do ORM e o `flush` gravava. Aqui o
 * processo é uma linha simples: `mover` grava com UPDATE e atualiza o mesmo
 * objeto em memória, para quem chamou continuar lendo o estado novo (o que o
 * objeto do SQLAlchemy fazia sozinho).
 */
import { and, asc, count, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  anexo,
  atribuicao,
  checklist,
  checklist_item,
  fluxo_etapa,
  laudo_tecnico,
  parametro,
  parecer_tecnico,
  perfil,
  perfil_permissao,
  permissao,
  processo as tabela_processo,
  tipo_processo,
  usuario as tabela_usuario,
} from "../db/esquema/index.js";
import { agora_utc } from "../db/esquema/base.js";
import { ChecklistModelo } from "../dominio/dominios.js";
import {
  ATALHO_REUSO_LAUDO,
  CADEIA_ADICIONAL,
  INCISOS_ART11,
  ORIGENS_DA_TRIAGEM,
  ROTULO_ESTADO,
  ROTULO_ESTADO_TELA,
  TransicaoInvalida,
  caminhos_de_avanco,
  coluna_de,
  colunas_destino,
  exigir_transicao,
  fluxo_curto,
  pode_transitar,
} from "../dominio/estados.js";
import { RegraViolada } from "../nucleo/erros.js";
import * as auditoria from "./auditoria.js";
import * as datas_br from "./datas_br.js";
import * as servico_nup from "./nup.js";
import * as textos from "./textos.js";
import type { UsuarioAtual } from "./rbac.js";

export type Processo = typeof tabela_processo.$inferSelect;
type ChecklistModeloLinha = { id: number; nome: string; itens: string };

// RN-16 - SLA por coluna (dias). O padrão abaixo vale enquanto ninguém editar
// em /config; a partir daí, quem manda é a tabela `parametro`.
export const SLA_PADRAO: Readonly<Record<string, number>> = Object.freeze({
  NAO_INICIADO: 0,
  A_FAZER: 15,
  EM_ANDAMENTO: 30,
  AGUARDANDO: 20,
  CONCLUIDO: 0,
});

export const PREFIXO_SLA = "sla.";

/** `int(valor)` do Python: aceita espaços e sinal, recusa o resto. */
function inteiro_python(valor: unknown): number | null {
  const texto = String(valor ?? "").trim();
  return /^[+-]?\d+$/.test(texto) ? Number(texto) : null;
}

/** Lê os parâmetros e cai no padrão para o que não estiver configurado. */
export async function sla_vigente(tx: Executor): Promise<Record<string, number>> {
  const tabela: Record<string, number> = { ...SLA_PADRAO };
  for (const p of await tx.select().from(parametro)) {
    if (!p.chave.startsWith(PREFIXO_SLA)) continue;
    const coluna = p.chave.slice(PREFIXO_SLA.length);
    if (Object.hasOwn(tabela, coluna)) {
      const n = inteiro_python(p.valor);
      if (n === null) continue;
      tabela[coluna] = Math.max(0, n);
    }
  }
  return tabela;
}

export async function gravar_sla(
  tx: Executor,
  valores: Record<string, number>,
  usuario: UsuarioAtual,
): Promise<Record<string, number>> {
  usuario.exigir("catalogo.gerenciar");
  for (const [coluna, dias] of Object.entries(valores)) {
    if (!Object.hasOwn(SLA_PADRAO, coluna)) continue;
    const chave = `${PREFIXO_SLA}${coluna}`;
    const [existente] = await tx.select().from(parametro).where(eq(parametro.chave, chave));
    const anterior = existente ? existente.valor : String(SLA_PADRAO[coluna]);
    const novo = String(Math.trunc(dias));
    if (!existente) {
      await tx.insert(parametro).values({ chave, valor: novo, descricao: `SLA da coluna ${coluna} (dias)` });
    } else {
      await tx.update(parametro).set({ valor: novo }).where(eq(parametro.chave, chave));
    }
    if (anterior !== novo) {
      await auditoria.registrar(tx, {
        entidade: "parametro",
        entidade_id: 0,
        tipo_evento: "SLA_ALTERADO",
        descricao: `SLA de ${coluna}: ${anterior} -> ${novo} dias`,
        campo: chave,
        valor_anterior: anterior,
        valor_novo: novo,
        usuario,
      });
    }
  }
  return sla_vigente(tx);
}

/** Requisito de saída do estado não atendido (o `ValueError` com `motivos`). */
export class RequisitoDeSaidaNaoAtendido extends RegraViolada {
  constructor(public motivos: string[]) {
    super(motivos.join("; "));
  }
}

export interface ResumoCartao<P = Processo> {
  readonly processo: P;
  readonly coluna: string;
  readonly dias_no_estado: number;
  readonly sla: number;
  readonly atrasado: boolean;
  readonly anexos: number;
  readonly checklist_feitos: number;
  readonly checklist_total: number;
  /** maquina curta (tudo o que nao e adicional ocupacional) */
  readonly curto: boolean;
  /** as colunas do quadro para onde o cartao pode ir */
  readonly colunas_destino: string[];
}

/**
 * "Precisa de você hoje": passou do SLA, ou ainda não saiu do "A fazer".
 *
 * Uma função, e não três critérios parecidos. O cartão do painel já escrevia
 * este critério inline, o contador ao lado dele contava outra coisa
 * (`atrasado`, sobre todos os processos) e o link "Ver todos" levava a uma
 * lista que aplicava um terceiro (`?atrasados=1`, só o SLA). Três definições de
 * um fato só, lado a lado, na tela de entrada — e a de menor número era a que
 * tinha o link.
 *
 * O critério inclui `A_FAZER` de propósito: processo recém-autuado não tem
 * dias no estado para estourar SLA nenhum, e mesmo assim é exatamente o que
 * ninguém pegou ainda.
 */
export function precisa_de_atencao(resumo: Pick<ResumoCartao<unknown>, "atrasado" | "coluna">): boolean {
  return resumo.atrasado || resumo.coluna === "A_FAZER";
}

// ---------------------------------------------------------------------
// Qual máquina
// ---------------------------------------------------------------------
type ComTipo = { tipo_processo_id?: number | null; tipo_processo?: { codigo?: string | null } | null };

/**
 * O processo anda pela máquina curta? Lê a relação `tipo_processo` quando ela
 * veio carregada; senão consulta. Sem tipo nenhum, a cadeia longa (a mais
 * exigente) — é o que valia antes de haver duas máquinas.
 */
export async function fluxo_curto_de(tx: Executor, processo: ComTipo): Promise<boolean> {
  const carregado = processo.tipo_processo?.codigo;
  if (carregado) return fluxo_curto(carregado);
  if (!processo.tipo_processo_id) return false;
  const [tipo] = await tx
    .select({ codigo: tipo_processo.codigo })
    .from(tipo_processo)
    .where(eq(tipo_processo.id, processo.tipo_processo_id));
  return fluxo_curto(tipo?.codigo);
}

// ---------------------------------------------------------------------
// Requisitos de saída (§4)
// ---------------------------------------------------------------------
// Sair da triagem para estes destinos não cobra documento: arquivar, sobrestar,
// pedir o documento que falta e (de RECEBIDO) entrar na triagem.
export const SAIDAS_DA_TRIAGEM_SEM_DOCUMENTO: ReadonlySet<string> = new Set(["ARQUIVADO", "SOBRESTADO", "PENDENTE_DOCUMENTO", "EM_TRIAGEM"]);

// A justificativa da avaliação qualitativa (sem relatório de ensaio) é escrita
// NA transição, no comentário — e não basta uma palavra: é o registro que a
// perícia vai ler no lugar do ensaio.
export const MINIMO_JUSTIFICATIVA_QUALITATIVA = 20;

export interface OpcoesRequisitos {
  /** o comentário do movimento: é nele que vai a justificativa qualitativa */
  comentario?: string | null;
}

export async function requisitos_de_saida(
  tx: Executor,
  processo: Pick<Processo, "id" | "estado_tecnico" | "unidade_uorg_id"> & ComTipo,
  destino: string,
  curto: boolean | null = null,
  opcoes: OpcoesRequisitos = {},
): Promise<string[]> {
  const faltas: string[] = [];
  const origem = processo.estado_tecnico;
  // Os requisitos são da IN 15/2022: só a cadeia do adicional os cobra.
  if (curto ?? (await fluxo_curto_de(tx, processo))) return faltas;

  if (ORIGENS_DA_TRIAGEM.has(origem) && !SAIDAS_DA_TRIAGEM_SEM_DOCUMENTO.has(destino)) {
    const categorias = await _categorias_anexadas(tx, processo.id);
    if (!categorias.has("PORTARIA")) faltas.push("anexe a portaria de localização");
    if (!categorias.has("FORMULARIO")) {
      faltas.push("anexe o formulário assinado pelo servidor e pela chefia (art. 17)");
    }
  }

  // DESVIO (corrige o porte): valia qualquer texto em Observações — inclusive o
  // que foi escrito na criação, antes de alguém pensar em quantificar. A
  // justificativa agora é do ATO: vai no comentário do movimento e fica na trilha.
  if (origem === "AGUARDANDO_QUANTIFICACAO") {
    const categorias = await _categorias_anexadas(tx, processo.id);
    const justificativa = (opcoes.comentario ?? "").trim();
    if (!categorias.has("RELATORIO_CAMPO") && justificativa.length < MINIMO_JUSTIFICATIVA_QUALITATIVA) {
      faltas.push(
        "anexe o relatório de ensaio (categoria “Relatório de campo”) ou escreva no comentário do " +
          `movimento a justificativa da avaliação qualitativa (ao menos ${MINIMO_JUSTIFICATIVA_QUALITATIVA} caracteres)`,
      );
    }
  }

  // Os estados que AFIRMAM um documento só se alcançam com o documento. Sem
  // isto, o salto (ou um clique de quem nem pode assinar) deixava o processo em
  // “Parecer assinado” — e o painel o contava concluído — sem parecer nenhum.
  if (destino === "LAUDO_EMITIDO" && !(await _tem_laudo_do_processo(tx, processo))) {
    faltas.push(
      "“Laudo emitido” exige o laudo no sistema: cadastre-o em Laudos, na mesma unidade do processo",
    );
  }
  if (destino === "PARECER_PRONTO_P_ASSINATURA" && !(await _tem_parecer(tx, processo.id, ["EMITIDO", "ASSINADO"]))) {
    faltas.push(
      "“Parecer pronto para assinatura” vem da emissão: emita o parecer deste processo e ele avança sozinho",
    );
  }
  if (destino === "PARECER_ASSINADO" && !(await _tem_parecer(tx, processo.id, ["ASSINADO"]))) {
    faltas.push(
      "“Parecer assinado” vem da assinatura: marque o parecer como assinado na ficha dele e o processo avança sozinho",
    );
  }
  if ((destino === "INSERIDO_NO_SEI" || destino === "CONCLUIDO") && !(await _tem_parecer(tx, processo.id, ["ASSINADO"]))) {
    faltas.push("sem parecer assinado neste processo: ele só segue para o SEI e para a conclusão depois da assinatura");
  }

  if (ORIGENS_DA_TRIAGEM.has(origem) && destino === ATALHO_REUSO_LAUDO[1]) {
    if (!(await _tem_laudo_vigente(tx, processo))) {
      faltas.push(
        "o atalho para elaboração de parecer exige um laudo VIGENTE do mesmo " +
          "posto vinculado (IN 15/2022, art. 10, §3º)",
      );
    }
  }
  return faltas;
}

async function _categorias_anexadas(tx: Executor, processo_id: number): Promise<Set<string>> {
  const linhas = await tx
    .select({ categoria: anexo.categoria })
    .from(anexo)
    .where(and(eq(anexo.entidade, "processo"), eq(anexo.entidade_id, processo_id), eq(anexo.ativo, true)));
  return new Set(linhas.map((l) => l.categoria));
}

/**
 * O processo tem laudo: um vinculado a ele, um usado por parecer dele (não
 * anulado), ou um VIGENTE da unidade do processo — o mesmo critério do atalho
 * de reúso. O cadastro de laudo em /laudos não pede processo, e por isso a
 * unidade é o vínculo que existe na prática.
 */
async function _tem_laudo_do_processo(tx: Executor, processo: Pick<Processo, "id" | "unidade_uorg_id">): Promise<boolean> {
  const [vinculado, do_parecer, da_unidade] = await Promise.all([
    tx.select({ n: count() }).from(laudo_tecnico).where(eq(laudo_tecnico.processo_id, processo.id)),
    tx
      .select({ n: count() })
      .from(parecer_tecnico)
      .where(
        and(
          eq(parecer_tecnico.processo_id, processo.id),
          isNotNull(parecer_tecnico.laudo_id),
          ne(parecer_tecnico.situacao, "ANULADO"),
        ),
      ),
    _tem_laudo_vigente(tx, processo),
  ]);
  return (vinculado[0]?.n ?? 0) > 0 || (do_parecer[0]?.n ?? 0) > 0 || da_unidade;
}

async function _tem_parecer(tx: Executor, processo_id: number, situacoes: string[]): Promise<boolean> {
  const [linha] = await tx
    .select({ n: count() })
    .from(parecer_tecnico)
    .where(and(eq(parecer_tecnico.processo_id, processo_id), inArray(parecer_tecnico.situacao, situacoes)));
  return (linha?.n ?? 0) > 0;
}

/**
 * Os estados do parecer cujo documento AINDA NÃO existe neste processo, a
 * partir das situações dos pareceres dele: a tela não os oferece (nem de
 * destino, nem de passagem num salto), e o quadro não solta cartão neles. Quem
 * os alcança é o próprio parecer, ao ser emitido e assinado. A recusa continua
 * no serviço (`requisitos_de_saida`) — isto é só o que se mostra.
 */
export function estados_sem_documento_de(situacoes: Iterable<string>, curto: boolean): ReadonlySet<string> {
  if (curto) return new Set();
  const tem = new Set(situacoes);
  const fora = new Set<string>();
  if (!tem.has("EMITIDO") && !tem.has("ASSINADO")) fora.add("PARECER_PRONTO_P_ASSINATURA");
  if (!tem.has("ASSINADO")) fora.add("PARECER_ASSINADO");
  return fora;
}

/** O mesmo, consultando os pareceres (para quem ainda não os leu). */
export async function estados_sem_documento(
  tx: Executor,
  processo: Pick<Processo, "id"> & ComTipo,
  curto: boolean | null = null,
): Promise<ReadonlySet<string>> {
  if (curto ?? (await fluxo_curto_de(tx, processo))) return new Set();
  const linhas = await tx
    .selectDistinct({ situacao: parecer_tecnico.situacao })
    .from(parecer_tecnico)
    .where(eq(parecer_tecnico.processo_id, processo.id));
  return estados_sem_documento_de(
    linhas.map((l) => l.situacao),
    false,
  );
}

async function _tem_laudo_vigente(tx: Executor, processo: Pick<Processo, "unidade_uorg_id">): Promise<boolean> {
  if (processo.unidade_uorg_id === null) return false;
  const [linha] = await tx
    .select({ n: count() })
    .from(laudo_tecnico)
    .where(and(eq(laudo_tecnico.unidade_uorg_id, processo.unidade_uorg_id), eq(laudo_tecnico.status, "VIGENTE")));
  return (linha?.n ?? 0) > 0;
}

// ---------------------------------------------------------------------
// Transição
// ---------------------------------------------------------------------
export interface OpcoesMover {
  comentario?: string | null;
  inciso_art11?: string | null;
  laudo_reusado?: { numero_siape: string } | null;
  forcar?: boolean;
  /**
   * Movimento que é CONSEQUÊNCIA de outro ato já autorizado (o parecer emitido
   * ou assinado): não cobra `processo.status` de quem emitiu.
   */
  pelo_sistema?: boolean;
}

const rotulo_ascii = (e: string) => (Object.hasOwn(ROTULO_ESTADO, e) ? ROTULO_ESTADO[e]! : e);
const rotulo_tela = (e: string) => (Object.hasOwn(ROTULO_ESTADO_TELA, e) ? ROTULO_ESTADO_TELA[e]! : e);

/**
 * Move o processo. Na cadeia longa o destino pode estar vários estados adiante
 * (salto): passa quando os requisitos de saída de TODOS os estados pulados
 * estão atendidos, e cada passo fica na trilha. Sem caminho que passe, a
 * recusa lista o que falta em cada passo do caminho mais curto.
 */
export async function mover<P extends Processo>(
  tx: Executor,
  processo: P,
  destino: string,
  usuario: UsuarioAtual,
  opcoes: OpcoesMover = {},
): Promise<P> {
  if (!opcoes.pelo_sistema) usuario.exigir("processo.status");
  const origem = processo.estado_tecnico;
  if (origem === destino) return processo;
  const curto = await fluxo_curto_de(tx, processo);

  let caminho = [origem, destino];
  if (pode_transitar(origem, destino, curto)) {
    if (!opcoes.forcar) {
      const faltas = await requisitos_de_saida(tx, processo, destino, curto, { comentario: opcoes.comentario });
      if (faltas.length) throw new RequisitoDeSaidaNaoAtendido(faltas);
    }
  } else {
    const caminhos = curto ? [] : caminhos_de_avanco(origem, destino);
    if (!caminhos.length) exigir_transicao(origem, destino, curto); // lança
    caminho = await _caminho_que_passa(tx, processo, caminhos, opcoes.forcar ?? false, opcoes.comentario ?? null);
  }

  const inciso = opcoes.inciso_art11 ?? null;
  if (destino === "INDEFERIDO_TECNICAMENTE" && (inciso === null || !Object.hasOwn(INCISOS_ART11, inciso))) {
    throw new RequisitoDeSaidaNaoAtendido([
      "indeferimento técnico exige o inciso do art. 11: " +
        Object.entries(INCISOS_ART11)
          .map(([k, v]) => `${k} — ${v}`)
          .join("; "),
    ]);
  }

  const salto = caminho.length > 2;
  for (let k = 1; k < caminho.length; k++) {
    let comentario = opcoes.comentario || null;
    if (salto) {
      const nota = `salto ${rotulo_ascii(origem)} -> ${rotulo_ascii(destino)}`;
      comentario = comentario ? `${nota} — ${comentario}` : nota;
    }
    await _passo(tx, processo, caminho[k]!, usuario, curto, comentario, opcoes.laudo_reusado ?? null);
  }
  return processo;
}

/**
 * O primeiro caminho de avanço em que nenhum passo tem requisito pendente. Sem
 * nenhum, a recusa do mais curto, passo a passo.
 */
async function _caminho_que_passa(
  tx: Executor,
  processo: Processo,
  caminhos: string[][],
  forcar: boolean,
  comentario: string | null,
): Promise<string[]> {
  if (forcar) return caminhos[0]!;
  let primeiras: string[] | null = null;
  for (const caminho of caminhos) {
    const faltas: string[] = [];
    for (let k = 0; k + 1 < caminho.length; k++) {
      const de = caminho[k]!;
      const para = caminho[k + 1]!;
      const pulado = { ...processo, estado_tecnico: de };
      for (const falta of await requisitos_de_saida(tx, pulado, para, false, { comentario })) {
        faltas.push(`${rotulo_tela(de)} → ${rotulo_tela(para)}: ${falta}`);
      }
    }
    if (!faltas.length) return caminho;
    primeiras ??= faltas;
  }
  throw new RequisitoDeSaidaNaoAtendido(primeiras!);
}

/** Um passo: grava o estado novo e a linha da trilha. */
async function _passo<P extends Processo>(
  tx: Executor,
  processo: P,
  destino: string,
  usuario: UsuarioAtual,
  curto: boolean,
  comentario: string | null,
  laudo_reusado: { numero_siape: string } | null,
): Promise<void> {
  const origem = processo.estado_tecnico;
  let estado_anterior = processo.estado_anterior;
  if (destino === "SOBRESTADO") estado_anterior = origem;
  else if (origem === "SOBRESTADO") estado_anterior = null;

  const novos = {
    estado_anterior,
    estado_tecnico: destino,
    entrou_na_etapa_em: agora_utc(),
    etapa_id: await _etapa_da_coluna(tx, coluna_de(destino, curto)),
    situacao: destino === "CONCLUIDO" ? "CONCLUIDO" : "EM_ANDAMENTO",
    data_conclusao: destino === "CONCLUIDO" ? datas_br.hoje() : null,
    versao: processo.versao + 1,
  };
  const [gravado] = await tx.update(tabela_processo).set(novos).where(eq(tabela_processo.id, processo.id)).returning();
  Object.assign(processo, gravado ?? novos);

  await auditoria.registrar(tx, {
    entidade: "processo",
    entidade_id: processo.id,
    processo_id: processo.id,
    tipo_evento: auditoria.ESTADO_ALTERADO,
    descricao: `${rotulo_ascii(origem)} -> ${rotulo_ascii(destino)}` + (comentario ? ` — ${comentario}` : ""),
    campo: "estado_tecnico",
    valor_anterior: origem,
    valor_novo: destino,
    comentario,
    usuario,
  });

  if (!curto && ORIGENS_DA_TRIAGEM.has(origem) && destino === ATALHO_REUSO_LAUDO[1]) {
    await auditoria.registrar(tx, {
      entidade: "processo",
      entidade_id: processo.id,
      processo_id: processo.id,
      tipo_evento: auditoria.REUSO_DE_LAUDO,
      descricao:
        "Parecer em elaboração por reúso de laudo vigente " +
        `(${laudo_reusado ? laudo_reusado.numero_siape : "laudo do posto"}) ` +
        "— IN 15/2022, art. 10, §3º.",
      usuario,
    });
  }
}

// Estados fora da cadeia que ainda estão "antes" do parecer: dali o processo
// pode ser levado adiante quando o parecer anda.
const ANTES_DA_CADEIA = new Set(["NAO_INICIADO", "PENDENTE_DOCUMENTO", "EM_RECURSO"]);

/**
 * O processo acompanha o parecer: emitido -> pronto para assinatura; assinado
 * -> parecer assinado. Só na cadeia do adicional, só para a frente, e só se o
 * processo está atrás. Os requisitos de saída continuam valendo: quando um
 * deles falta, o processo fica onde está e volta o aviso (o parecer não é
 * desfeito por isso).
 */
export async function acompanhar_parecer(
  tx: Executor,
  processo_id: number | null,
  destino: "PARECER_PRONTO_P_ASSINATURA" | "PARECER_ASSINADO",
  usuario: UsuarioAtual,
  comentario: string,
): Promise<string | null> {
  if (processo_id === null) return null;
  const [processo] = await tx.select().from(tabela_processo).where(eq(tabela_processo.id, processo_id));
  if (!processo || (await fluxo_curto_de(tx, processo))) return null;
  const i = CADEIA_ADICIONAL.indexOf(processo.estado_tecnico);
  const atras = i >= 0 ? i < CADEIA_ADICIONAL.indexOf(destino) : ANTES_DA_CADEIA.has(processo.estado_tecnico);
  if (!atras) return null;
  try {
    await mover(tx, processo, destino, usuario, { comentario, pelo_sistema: true });
    return null;
  } catch (erro) {
    if (!(erro instanceof RequisitoDeSaidaNaoAtendido || erro instanceof TransicaoInvalida)) throw erro;
    const motivos = erro instanceof RequisitoDeSaidaNaoAtendido ? erro.motivos.join("; ") : erro.message;
    return `O processo ${processo.nup} continua em “${rotulo_tela(processo.estado_tecnico)}” — ${motivos}`;
  }
}

// ---------------------------------------------------------------------
// Criação
// ---------------------------------------------------------------------
/** Recusa ao cadastrar o processo (NUP, duplicata, data) — volta ao formulário. */
export class ProcessoRecusado extends RegraViolada {
  /** o campo da tela de onde a recusa veio (sem ele, o NUP) */
  campo: string | null = null;
  /** o NUP repetido: o processo que já o tem, para a tela levar até ele */
  existente_id: number | null = null;
  constructor(mensagem: string, campo: string | null = null) {
    super(mensagem);
    this.campo = campo;
  }
}

export interface DadosProcessoNovo {
  nup: string;
  tipo_processo_id: number;
  servidor_id?: number | null;
  unidade_uorg_id?: number | null;
  data_autuacao?: string | null;
  observacoes?: string | null;
  /** "confirmei no SEI": o DV não confere e a pessoa conferiu o número */
  dispensar_dv?: boolean;
  /** RN-21 em aviso: a menção a saúde nas observações é necessária */
  confirmo_mencao_saude?: boolean;
}

/**
 * Cadastra o processo em RECEBIDO. Um lugar só para o formulário de processo
 * novo e para a demanda que vira processo no encerramento. `TextoProibido`
 * (e `MencaoDeSaude`) sobem como estão; o resto da recusa é `ProcessoRecusado`.
 */
export async function criar(tx: Executor, usuario: UsuarioAtual, d: DadosProcessoNovo): Promise<Processo> {
  usuario.exigir("processo.criar");
  const resultado = servico_nup.validar(d.nup);
  if (!resultado.formato_ok) throw new ProcessoRecusado(resultado.aviso || "NUP inválido");
  if (!resultado.dv_ok && !d.dispensar_dv) {
    throw new ProcessoRecusado(`${resultado.aviso}. Marque 'confirmei no SEI' para prosseguir.`);
  }
  const [ja] = await tx
    .select({ id: tabela_processo.id })
    .from(tabela_processo)
    .where(eq(tabela_processo.nup, resultado.valor));
  if (ja) {
    const recusa = new ProcessoRecusado("já existe processo com este NUP");
    recusa.existente_id = ja.id;
    throw recusa;
  }
  // A autuação é fato ocorrido. Data no futuro deixava negativo o "dias até a
  // emissão" do painel de todo mundo (a demanda que vira processo passa aqui
  // também, e por isso a regra mora no serviço, e não só na rota).
  if (d.data_autuacao && d.data_autuacao > datas_br.hoje()) {
    throw new ProcessoRecusado(
      `Data de autuação: ${datas_br.numerica(d.data_autuacao)} ainda não chegou — a autuação é fato ocorrido, use a data do SEI.`,
      "data_autuacao",
    );
  }
  const observacoes = (d.observacoes ?? "").trim() || null;
  textos.exigir_texto_limpo(observacoes, "observações", textos.CONTEXTO_AVISO_SAUDE, d.confirmo_mencao_saude ?? false);

  const [etapa] = await tx.select().from(fluxo_etapa).where(eq(fluxo_etapa.codigo, "A_FAZER"));
  const [processo] = await tx
    .insert(tabela_processo)
    .values({
      nup: resultado.valor,
      tipo_processo_id: d.tipo_processo_id,
      etapa_id: etapa!.id,
      estado_tecnico: "RECEBIDO",
      servidor_id: d.servidor_id ?? null,
      unidade_uorg_id: d.unidade_uorg_id ?? null,
      data_autuacao: d.data_autuacao || null,
      ano_referencia: Number(datas_br.hoje().slice(0, 4)),
      observacoes,
      nup_dv_dispensado: !resultado.dv_ok,
      responsavel_id: usuario.id,
    })
    .returning();

  await auditoria.registrar(tx, {
    entidade: "processo",
    entidade_id: processo!.id,
    processo_id: processo!.id,
    tipo_evento: "PROCESSO_CRIADO",
    descricao: `Processo ${processo!.nup} criado.`,
    usuario,
  });
  if (!resultado.dv_ok) {
    await auditoria.registrar(tx, {
      entidade: "processo",
      entidade_id: processo!.id,
      processo_id: processo!.id,
      tipo_evento: auditoria.NUP_DV_DISPENSADO,
      descricao: `DV do NUP ${processo!.nup} dispensado por confirmação manual.`,
      usuario,
    });
  }
  if (d.confirmo_mencao_saude) {
    await auditoria.registrar_mencao_de_saude(tx, {
      entidade: "processo",
      entidade_id: processo!.id,
      processo_id: processo!.id,
      campo: "observações",
      texto: observacoes,
      usuario,
    });
  }
  return processo!;
}

export interface DadosCorrigidos {
  /** `undefined`: o formulário não trouxe o campo (o processo já tem parecer) */
  servidor_id?: number | null;
  unidade_uorg_id: number | null;
  data_autuacao: string | null;
  data_solicitacao_sest: string | null;
  observacoes: string | null;
  confirmo_mencao_saude?: boolean;
}

/**
 * Corrige a identificação do processo depois de criado. Antes não havia como:
 * o processo autuado sem unidade nunca alcançava "Laudo emitido" (o laudo vale
 * pela unidade), e uma data digitada errada ficava para sempre. NUP e tipo
 * ficam de fora — o NUP é a identidade, e o tipo escolhe a máquina de estados.
 * O servidor só muda enquanto não há parecer: o parecer já o traz no corpo.
 * Cada campo alterado vai para a trilha (RN-14). Devolve quantos mudaram.
 */
export async function corrigir_dados(
  tx: Executor,
  usuario: UsuarioAtual,
  processo: Processo,
  d: DadosCorrigidos,
): Promise<number> {
  usuario.exigir("processo.editar");
  for (const [campo, rotulo] of [
    ["data_autuacao", "Data de autuação"],
    ["data_solicitacao_sest", "Solicitação no SEST"],
  ] as const) {
    const valor = d[campo];
    if (valor && valor > datas_br.hoje()) {
      throw new ProcessoRecusado(
        `${rotulo}: ${datas_br.numerica(valor)} ainda não chegou — é fato ocorrido, use a data do SEI.`,
        campo,
      );
    }
  }
  const observacoes = (d.observacoes ?? "").trim() || null;
  textos.exigir_texto_limpo(observacoes, "observações", textos.CONTEXTO_AVISO_SAUDE, d.confirmo_mencao_saude ?? false);
  const novo: Partial<Processo> = {
    unidade_uorg_id: d.unidade_uorg_id,
    data_autuacao: d.data_autuacao,
    data_solicitacao_sest: d.data_solicitacao_sest,
    observacoes,
  };
  if (d.servidor_id !== undefined && d.servidor_id !== processo.servidor_id) {
    const [parecer] = await tx
      .select({ id: parecer_tecnico.id })
      .from(parecer_tecnico)
      .where(and(eq(parecer_tecnico.processo_id, processo.id), ne(parecer_tecnico.situacao, "ANULADO")))
      .limit(1);
    if (parecer) {
      throw new ProcessoRecusado(
        "O servidor não muda depois do parecer: ele já sai no corpo do documento. Anule o parecer antes de trocar.",
        "servidor",
      );
    }
    novo.servidor_id = d.servidor_id;
  }
  const antes: Record<string, unknown> = {};
  const depois: Record<string, unknown> = {};
  for (const [campo, valor] of Object.entries(novo)) {
    antes[campo] = processo[campo as keyof Processo] ?? null;
    depois[campo] = valor ?? null;
  }
  const eventos = await auditoria.registrar_diferencas(tx, {
    entidade: "processo",
    entidade_id: processo.id,
    antes,
    depois,
    usuario,
    processo_id: processo.id,
  });
  if (!eventos.length) return 0;
  await tx.update(tabela_processo).set(novo).where(eq(tabela_processo.id, processo.id));
  if (d.confirmo_mencao_saude && antes.observacoes !== observacoes) {
    await auditoria.registrar_mencao_de_saude(tx, {
      entidade: "processo",
      entidade_id: processo.id,
      processo_id: processo.id,
      campo: "observações",
      texto: observacoes,
      usuario,
    });
  }
  return eventos.length;
}

export async function voltar_do_sobrestamento<P extends Processo>(
  tx: Executor,
  processo: P,
  usuario: UsuarioAtual,
): Promise<P> {
  if (processo.estado_tecnico !== "SOBRESTADO") throw new TransicaoInvalida("o processo não está sobrestado");
  const destino = processo.estado_anterior || "EM_TRIAGEM";
  return mover(tx, processo, destino, usuario, { forcar: true });
}

async function _etapa_da_coluna(tx: Executor, coluna: string): Promise<number> {
  let [etapa] = await tx.select({ id: fluxo_etapa.id }).from(fluxo_etapa).where(eq(fluxo_etapa.codigo, coluna));
  if (!etapa) {
    [etapa] = await tx.select({ id: fluxo_etapa.id }).from(fluxo_etapa).where(eq(fluxo_etapa.codigo, "A_FAZER"));
  }
  return etapa!.id;
}

// ---------------------------------------------------------------------
// Responsável
// ---------------------------------------------------------------------
// Quem pode ser responsável por um processo: conta ATIVA, com perfil ativo e
// atribuição vigente que dê `processo.editar` ou `processo.status` — quem de
// fato trabalha o processo. Atribuir a uma conta que só lê (servidor, admin de
// TI) deixava o processo com um dono que não consegue mexer nele.
export const PERMISSOES_DE_RESPONSAVEL: readonly string[] = ["processo.editar", "processo.status"];

export interface Responsavel {
  id: number;
  nome: string;
  login: string;
}

/**
 * As contas que a lista, o lote e o quadro oferecem como responsável — o
 * mesmo desenho do `_pessoas()` de demandas, com as permissões do processo.
 * Mora aqui, e não em `repositorios/`: não há linha de processo a escopar.
 */
export async function responsaveis_possiveis(tx: Executor): Promise<Responsavel[]> {
  const hoje = datas_br.hoje();
  const com_a_permissao = tx
    .select({ id: atribuicao.usuario_id })
    .from(atribuicao)
    .innerJoin(perfil, eq(perfil.id, atribuicao.perfil_id))
    .innerJoin(perfil_permissao, eq(perfil_permissao.perfil_id, perfil.id))
    .innerJoin(permissao, eq(permissao.id, perfil_permissao.permissao_id))
    .where(
      and(
        eq(perfil.ativo, true),
        inArray(permissao.codigo, [...PERMISSOES_DE_RESPONSAVEL]),
        lte(atribuicao.vigencia_inicio, hoje),
        or(isNull(atribuicao.vigencia_fim), gte(atribuicao.vigencia_fim, hoje)),
      ),
    );
  return tx
    .select({ id: tabela_usuario.id, nome: tabela_usuario.nome, login: tabela_usuario.login })
    .from(tabela_usuario)
    .where(and(eq(tabela_usuario.ativo, true), inArray(tabela_usuario.id, com_a_permissao)))
    .orderBy(asc(tabela_usuario.nome));
}

// ---------------------------------------------------------------------
// Kanban / SLA
// ---------------------------------------------------------------------
export const CHAVES_AGRUPAMENTO: Readonly<Record<string, string>> = Object.freeze({
  estado: "Estado técnico",
  unidade: "Unidade",
  responsavel: "Responsável",
  tipo: "Tipo de processo",
});

type Agrupavel = Pick<Processo, "estado_tecnico"> & {
  unidade?: { nome_extenso: string } | null;
  responsavel?: { nome: string } | null;
  tipo_processo?: { nome: string } | null;
};

/**
 * Agrupa uma lista JÁ filtrada pelo repositório — não consulta nada, por isso
 * vive aqui e não em `repositorios/` (onde todo acesso passa pelo escopo). As
 * relações `unidade`, `responsavel` e `tipo_processo` têm de vir carregadas.
 */
export function agrupar<P extends Agrupavel>(processos: P[], chave: string): Map<string, P[]> {
  const rotulo = (p: P): string => {
    if (chave === "unidade") return p.unidade ? p.unidade.nome_extenso : "(sem unidade)";
    if (chave === "responsavel") return p.responsavel ? p.responsavel.nome : "(sem responsável)";
    if (chave === "tipo") return p.tipo_processo ? p.tipo_processo.nome : "(sem tipo)";
    // o rótulo do grupo é o <summary> que a pessoa lê em /processos, e não
    // texto de trilha: sai acentuado como o resto da tela
    return Object.hasOwn(ROTULO_ESTADO_TELA, p.estado_tecnico) ? ROTULO_ESTADO_TELA[p.estado_tecnico]! : p.estado_tecnico;
  };
  const grupos = new Map<string, P[]>();
  for (const p of processos) {
    const r = rotulo(p);
    if (!grupos.has(r)) grupos.set(r, []);
    grupos.get(r)!.push(p);
  }
  // `dict(sorted(grupos.items()))`: ordem por código de caractere, como o Python
  return new Map([...grupos.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Instancia um modelo de checklist no processo (catálogo /checklists-modelo). */
export async function aplicar_checklist_modelo(
  tx: Executor,
  processo: Pick<Processo, "id">,
  modelo: ChecklistModeloLinha,
  usuario: UsuarioAtual,
) {
  usuario.exigir("processo.editar");
  const [existente] = await tx
    .select()
    .from(checklist)
    .where(and(eq(checklist.processo_id, processo.id), eq(checklist.nome, modelo.nome)));
  if (existente) return existente;

  const [novo] = await tx.insert(checklist).values({ processo_id: processo.id, nome: modelo.nome }).returning();
  const itens = ChecklistModelo.lista_de_itens(modelo);
  let ordem = 1;
  for (const descricao of itens) {
    await tx.insert(checklist_item).values({ checklist_id: novo!.id, descricao, ordem: ordem++ });
  }
  await auditoria.registrar(tx, {
    entidade: "checklist",
    entidade_id: novo!.id,
    processo_id: processo.id,
    tipo_evento: "CHECKLIST_APLICADO",
    descricao: `Modelo '${modelo.nome}' aplicado (${itens.length} itens).`,
    usuario,
  });
  return novo!;
}

export async function resumir<P extends Pick<Processo, "id" | "estado_tecnico" | "entrou_na_etapa_em">>(
  tx: Executor,
  processo: P,
  sla: Record<string, number> | null = null,
  opcoes: OpcoesResumo = {},
): Promise<ResumoCartao<P>> {
  const [resumo] = await resumir_varios(tx, [processo], sla, opcoes);
  return resumo!;
}

export interface OpcoesResumo {
  /**
   * `false` quando a tela não mostra o menu "mover para…" (a ficha): poupa a
   * consulta dos pareceres, que só serve para tirar dele as colunas que o
   * parecer ainda não alcançou. Sem ela, `colunas_destino` sai pela tabela.
   */
  com_destinos?: boolean;
}

/**
 * O cartão de vários processos de uma vez: SLA, tipo, anexos e checklist em
 * QUATRO consultas que vão juntas ao banco (uma ida), e não quatro por processo.
 * O painel e o quadro faziam dezenas de idas só para isto.
 */
export async function resumir_varios<P extends Pick<Processo, "id" | "estado_tecnico" | "entrou_na_etapa_em">>(
  tx: Executor,
  processos: readonly P[],
  sla: Record<string, number> | null = null,
  opcoes: OpcoesResumo = {},
): Promise<ResumoCartao<P>[]> {
  if (processos.length === 0) return [];
  const com_destinos = opcoes.com_destinos ?? true;
  const ids = processos.map((p) => p.id);
  const sem_tipo = [
    ...new Set(
      processos
        .map((p) => p as ComTipo)
        .filter((p) => !p.tipo_processo?.codigo && p.tipo_processo_id)
        .map((p) => p.tipo_processo_id!),
    ),
  ];
  const [tabela_sla, tipos, anexos, contagens, pareceres] = await Promise.all([
    sla ?? sla_vigente(tx),
    sem_tipo.length
      ? tx
          .select({ id: tipo_processo.id, codigo: tipo_processo.codigo })
          .from(tipo_processo)
          .where(inArray(tipo_processo.id, sem_tipo))
      : Promise.resolve([]),
    tx
      .select({ id: anexo.entidade_id, n: count() })
      .from(anexo)
      .where(and(eq(anexo.entidade, "processo"), inArray(anexo.entidade_id, ids), eq(anexo.ativo, true)))
      .groupBy(anexo.entidade_id),
    tx
      .select({
        id: checklist.processo_id,
        total: count(),
        feitos: sql<number>`count(*) filter (where ${checklist_item.concluido})`.mapWith(Number),
      })
      .from(checklist_item)
      .innerJoin(checklist, eq(checklist.id, checklist_item.checklist_id))
      .where(inArray(checklist.processo_id, ids))
      .groupBy(checklist.processo_id),
    // o documento do parecer: sem ele o menu "mover para…" não oferece a
    // coluna que só o parecer alcança (`estados_sem_documento`)
    com_destinos
      ? tx
          .selectDistinct({ id: parecer_tecnico.processo_id, situacao: parecer_tecnico.situacao })
          .from(parecer_tecnico)
          .where(and(inArray(parecer_tecnico.processo_id, ids), inArray(parecer_tecnico.situacao, ["EMITIDO", "ASSINADO"])))
      : Promise.resolve([]),
  ]);
  const situacoes_de = new Map<number, Set<string>>();
  for (const p of pareceres) {
    if (p.id === null) continue;
    if (!situacoes_de.has(p.id)) situacoes_de.set(p.id, new Set());
    situacoes_de.get(p.id)!.add(p.situacao);
  }
  const codigo_do_tipo = new Map(tipos.map((t) => [t.id, t.codigo]));
  const anexos_de = new Map(anexos.map((a) => [a.id, a.n]));
  const checklist_de = new Map(contagens.map((c) => [c.id, c]));

  return processos.map((processo) => {
    const com_tipo = processo as ComTipo;
    // as mesmas três saídas de `fluxo_curto_de`
    const curto = com_tipo.tipo_processo?.codigo
      ? fluxo_curto(com_tipo.tipo_processo.codigo)
      : com_tipo.tipo_processo_id
        ? fluxo_curto(codigo_do_tipo.get(com_tipo.tipo_processo_id))
        : false;
    const coluna = coluna_de(processo.estado_tecnico, curto);
    const dias = datas_br.dias_desde(processo.entrou_na_etapa_em);
    const limite = tabela_sla[coluna] ?? 0;
    const contagem = checklist_de.get(processo.id);
    const evitar = com_destinos
      ? estados_sem_documento_de(situacoes_de.get(processo.id) ?? [], curto)
      : new Set<string>();
    return {
      processo,
      coluna,
      dias_no_estado: dias,
      sla: limite,
      atrasado: Boolean(limite) && dias > limite,
      anexos: anexos_de.get(processo.id) ?? 0,
      checklist_feitos: contagem?.feitos ?? 0,
      checklist_total: contagem?.total ?? 0,
      curto,
      colunas_destino: colunas_destino(processo.estado_tecnico, curto, evitar),
    };
  });
}
