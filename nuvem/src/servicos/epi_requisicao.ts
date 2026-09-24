/**
 * A requisição de EPI: o pedido formal, com protocolo, decisão e prazo.
 * Porte de `app/servicos/epi_requisicao.py` (fatias 4, 5 e 7 do módulo EPI).
 *
 * **Duas máquinas, e não uma.** O envelope (`epi_requisicao`, máquina C) diz em
 * que ponto do trâmite o pedido está; o item (`epi_requisicao_item`, máquina D)
 * é onde a decisão acontece — aprovar a luva e recusar o respirador do mesmo
 * pedido é o caso comum.
 *
 * Quatro regras moram aqui:
 * 1. **RN-03 aplicada ao protocolo.** `EPI-AAAA-NNNN` é consumido no ENVIO por
 *    `numeracao.proximo_numero_requisicao_epi`; rascunho abandonado não gasta número.
 * 2. **RN-26 conta a FICHA, não requisições aprovadas.** Estourar a janela é
 *    bloqueio até alguém justificar e assinar com o próprio `usuario.id`.
 * 3. **RN-27 congela o texto da recusa** (`texto_recusa_snapshot`).
 * 4. **RN-28 é bloqueio duro** — ver `_exigir_analista_diferente`.
 *
 * A reserva (fatia 5): `APROVADO → RESERVADO → ENTREGUE` é o caminho normal. A
 * reserva impede que dois pedidos prometam o mesmo par de botas; ela é ato
 * explícito do almoxarifado (nunca automática na entrada de lote), a entrega
 * continua sendo `epi_ficha.registrar_entrega` (com a reserva solta imediatamente
 * antes), e soltar reserva é sempre com motivo e vai para `SEM_ESTOQUE`.
 *
 * **Adaptação do porte.** No Python as linhas eram objetos do ORM com relações
 * preguiçosas (`linha.requisicao`, `linha.item`, `requisicao.itens`). Aqui as
 * funções recebem a linha do banco (`$inferSelect`), recarregam as relações de
 * que a regra precisa e, ao escrever, gravam com `UPDATE` E atualizam o objeto
 * recebido (`Object.assign`) — é o que o `flush` do ORM fazia com a identidade
 * em memória. Quem guardou OUTRO objeto da mesma linha deve relê-lo.
 */
import { and, asc, count, desc, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  agora_utc,
  epi_entrada_estoque,
  epi_item,
  epi_motivo_recusa,
  epi_requisicao,
  epi_requisicao_item,
  pendencia as tabela_pendencia,
  servidor as tabela_servidor,
  usuario as tabela_usuario,
} from "../db/esquema/index.js";
import { EpiItem as EpiItemDominio, EpiRequisicao as EpiRequisicaoDominio, EpiRequisicaoItem as EpiRequisicaoItemDominio, FINALIDADES_REQUISICAO, URGENCIAS_REQUISICAO } from "../dominio/epi.js";
import {
  EPI_ITEM_DECIDIDO,
  EPI_ITEM_PENDENTE_DE_ATENDIMENTO,
  ROTULO_EPI_ITEM,
  ROTULO_EPI_REQUISICAO,
  exigir_transicao_epi_item,
  exigir_transicao_epi_requisicao,
} from "../dominio/estados.js";
import { RegraViolada } from "../nucleo/erros.js";
import * as auditoria from "./auditoria.js";
import * as datas_br from "./datas_br.js";
import * as epi_estoque from "./epi_estoque.js";
import * as epi_ficha from "./epi_ficha.js";
import { EPI_MAXIMO_EXCEDIDO } from "./epi_ficha.js";
import * as numeracao from "./numeracao.js";
import * as pendencias from "./pendencias.js";
import * as servico_servidores from "./servidores.js";
import * as textos from "./textos.js";
import { ESCOPO_PROPRIO, ESCOPO_UNIDADE, PermissaoNegada, aplicar_escopo, type UsuarioAtual } from "./rbac.js";

export type EpiRequisicao = typeof epi_requisicao.$inferSelect;
export type EpiRequisicaoItem = typeof epi_requisicao_item.$inferSelect;
export type EpiItem = typeof epi_item.$inferSelect;
export type EpiMotivoRecusa = typeof epi_motivo_recusa.$inferSelect;
export type EpiEntradaEstoque = typeof epi_entrada_estoque.$inferSelect;
export type Servidor = typeof tabela_servidor.$inferSelect;

export { EPI_MAXIMO_EXCEDIDO };

// --- eventos do envelope (máquina C) ---
export const EPI_REQUISICAO_CRIADA = "EPI_REQUISICAO_CRIADA";
export const EPI_REQUISICAO_ENVIADA = "EPI_REQUISICAO_ENVIADA";
export const EPI_REQUISICAO_EM_ANALISE = "EPI_REQUISICAO_EM_ANALISE";
export const EPI_REQUISICAO_DEVOLVIDA = "EPI_REQUISICAO_DEVOLVIDA";
export const EPI_REQUISICAO_ANALISADA = "EPI_REQUISICAO_ANALISADA";
export const EPI_REQUISICAO_INDEFERIDA = "EPI_REQUISICAO_INDEFERIDA";
export const EPI_REQUISICAO_RECONSIDERADA = "EPI_REQUISICAO_RECONSIDERADA";
export const EPI_REQUISICAO_EM_ATENDIMENTO = "EPI_REQUISICAO_EM_ATENDIMENTO";
export const EPI_REQUISICAO_ATENDIDA = "EPI_REQUISICAO_ATENDIDA";
export const EPI_REQUISICAO_CANCELADA = "EPI_REQUISICAO_CANCELADA";
export const EPI_REQUISICAO_EXCLUIDA = "EPI_REQUISICAO_EXCLUIDA";

// --- eventos do item (máquina D) ---
export const EPI_ITEM_APROVADO = "EPI_ITEM_APROVADO";
export const EPI_ITEM_RECUSADO = "EPI_ITEM_RECUSADO";
export const EPI_ITEM_CANCELADO = "EPI_ITEM_CANCELADO";
export const EPI_ITEM_ENTREGUE = "EPI_ITEM_ENTREGUE";
export const EPI_ITEM_RESERVADO = "EPI_ITEM_RESERVADO";
export const EPI_ITEM_SEM_ESTOQUE = "EPI_ITEM_SEM_ESTOQUE";
// a reserva desfeita tem evento PRÓPRIO: "faltou comprar" é planejamento;
// "prometi e não pude cumprir" diz que o estoque está sendo prometido duas vezes
export const EPI_ITEM_RESERVA_SOLTA = "EPI_ITEM_RESERVA_SOLTA";

export const ENTIDADE = "epi_requisicao";
export const ENTIDADE_ITEM = "epi_requisicao_item";

export const TIPO_PENDENCIA_SEM_ESTOQUE = "EPI_SEM_ESTOQUE";
// Os dois avisos que vão para o REQUERENTE, e não para a CSSO.
export const TIPO_PENDENCIA_DECISAO = "EPI_DECISAO_A_LER";
export const TIPO_PENDENCIA_RETIRADA = "EPI_RETIRADA_DISPONIVEL";

// Estados com decisão tomada e pedido não terminado: fora deles a tarefa de LER
// perdeu o objeto. `EM_ATENDIMENTO` fica DENTRO para não apagar, pela pressa do
// almoxarifado, o aviso de que houve item RECUSADO.
export const DECIDIDO_E_NAO_LIDO: ReadonlySet<string> = new Set(["ANALISADA", "EM_ATENDIMENTO", "INDEFERIDA"]);

// Só o rascunho admite edição de conteúdo: protocolado, o pedido é documento.
export const EDITAVEL: ReadonlySet<string> = new Set(["RASCUNHO"]);

/** O que impede esta operação, tudo de uma vez. */
export class RequisicaoBloqueada extends RegraViolada {
  constructor(public motivos: string[]) {
    super("Requisição bloqueada: " + motivos.join("; "));
  }
}

/**
 * RN-28 — quem analisa não é quem requisita. Bloqueio duro, sem exceção.
 *
 * Registrar a autoanálise gravaria "analisado por X" num pedido de X: a
 * aparência de um controle que não houve. A regra não trava trabalho — a
 * entrega avulsa de balcão existe —, e a mensagem diz as duas saídas.
 */
export class AutoanaliseProibida extends PermissaoNegada {
  requisicao_id: number;
  constructor(requisicao: EpiRequisicao, nome_servidor: string) {
    super(
      "epi.analisar",
      `Quem analisa não é quem requisita (RN-28): a requisição ` +
        `${identificacao(requisicao)} é de ${nome_servidor}, e essa pessoa é ` +
        "você. Há duas saídas legítimas, e nenhuma delas é analisar o " +
        "próprio pedido: (1) outra pessoa com a permissão de analisar EPI " +
        "decide esta requisição; ou (2) o equipamento sai pela entrega " +
        "avulsa de balcão (/epis/entregas/nova), que registra a ficha, o " +
        "lote, o CA e o comprovante assinado do mesmo jeito — só não produz " +
        "um pedido decidido por quem o fez.",
    );
    this.requisicao_id = requisicao.id;
  }
}

// =====================================================================
// Propriedades do modelo e relações (o que o ORM dava de graça)
// =====================================================================
export function identificacao(requisicao: Pick<EpiRequisicao, "protocolo" | "id">): string {
  return EpiRequisicaoDominio.identificacao(requisicao);
}

export function quantidade_devida(linha: Pick<EpiRequisicaoItem, "quantidade_aprovada" | "quantidade_entregue">): number {
  return EpiRequisicaoItemDominio.quantidade_devida(linha);
}

function rotulo_req(estado: string): string {
  return ROTULO_EPI_REQUISICAO[estado] ?? estado;
}
function rotulo_item(estado: string): string {
  return ROTULO_EPI_ITEM[estado] ?? estado;
}

/** `requisicao.itens`, na ordem em que nasceram. */
export async function itens_de(tx: Executor, requisicao_id: number): Promise<EpiRequisicaoItem[]> {
  return tx
    .select()
    .from(epi_requisicao_item)
    .where(eq(epi_requisicao_item.requisicao_id, requisicao_id))
    .orderBy(asc(epi_requisicao_item.id));
}

async function _item(tx: Executor, epi_item_id: number): Promise<EpiItem> {
  const [item] = await tx.select().from(epi_item).where(eq(epi_item.id, epi_item_id));
  return item!;
}

async function _requisicao_da_linha(tx: Executor, linha: EpiRequisicaoItem): Promise<EpiRequisicao> {
  const [r] = await tx.select().from(epi_requisicao).where(eq(epi_requisicao.id, linha.requisicao_id));
  return r!;
}

/** Grava campos do envelope e reflete no objeto recebido (o `flush`). */
async function _gravar(tx: Executor, requisicao: EpiRequisicao, campos: Partial<EpiRequisicao>): Promise<void> {
  Object.assign(requisicao, campos);
  await tx.update(epi_requisicao).set(campos).where(eq(epi_requisicao.id, requisicao.id));
}

async function _gravar_linha(tx: Executor, linha: EpiRequisicaoItem, campos: Partial<EpiRequisicaoItem>): Promise<void> {
  Object.assign(linha, campos);
  await tx.update(epi_requisicao_item).set(campos).where(eq(epi_requisicao_item.id, linha.id));
}

/** A requisição com o que a tela lê dela — o `lazy="selectin"` do Python. */
export async function carregar(tx: Executor, requisicao_id: number) {
  return tx.query.epi_requisicao.findFirst({
    where: eq(epi_requisicao.id, requisicao_id),
    with: {
      servidor: true,
      chefia: true,
      unidade: true,
      motivo_recusa: true,
      itens: {
        with: { item: { with: { categoria: true } }, motivo_recusa: true },
        orderBy: [asc(epi_requisicao_item.id)],
      },
    },
  });
}
export type RequisicaoCompleta = NonNullable<Awaited<ReturnType<typeof carregar>>>;

// =====================================================================
// RN-28 — o bloqueio, num lugar só
// =====================================================================
/**
 * `epi.analisar` mais a conferência de que o analista não é o requerente.
 * Compara `servidor_id` — quem VAI USAR o equipamento, e não quem digitou.
 */
async function _exigir_analista_diferente(tx: Executor, usuario: UsuarioAtual, requisicao: EpiRequisicao): Promise<void> {
  usuario.exigir("epi.analisar");
  if (usuario.servidor_id === null) return;
  if (requisicao.servidor_id !== usuario.servidor_id) return;
  const [servidor] = await tx.select().from(tabela_servidor).where(eq(tabela_servidor.id, requisicao.servidor_id));
  throw new AutoanaliseProibida(requisicao, servidor ? servidor.nome : "você mesmo");
}

// =====================================================================
// As duas transições, no formato de `processo.mover()`
// =====================================================================
export async function _mover(
  tx: Executor,
  requisicao: EpiRequisicao,
  destino: string,
  usuario: UsuarioAtual | null,
  opcoes: { tipo_evento: string; comentario?: string | null; campos?: Partial<EpiRequisicao> },
): Promise<EpiRequisicao> {
  const origem = requisicao.estado;
  exigir_transicao_epi_requisicao(origem, destino);
  // `campos` entram no MESMO UPDATE do estado: as CHECKs do Postgres valem por
  // comando (ck_req_protocolo amarra protocolo e estado), e o flush do Python
  // gravava as duas coisas juntas.
  await _gravar(tx, requisicao, {
    ...(opcoes.campos ?? {}),
    estado_anterior: origem,
    estado: destino,
    entrou_no_estado_em: agora_utc(),
    versao: requisicao.versao + 1,
  });
  const comentario = opcoes.comentario ?? null;
  await auditoria.registrar(tx, {
    entidade: ENTIDADE,
    entidade_id: requisicao.id,
    tipo_evento: opcoes.tipo_evento,
    descricao:
      `${identificacao(requisicao)}: ${rotulo_req(origem)} → ${rotulo_req(destino)}` +
      (comentario ? ` — ${comentario}` : ""),
    campo: "estado",
    valor_anterior: origem,
    valor_novo: destino,
    comentario,
    usuario,
  });
  // a porta única do envelope: o aviso ao requerente pendura aqui, e não em
  // cada uma das arestas que entram ou saem de ANALISADA/INDEFERIDA
  await sincronizar_pendencia_de_decisao(tx, requisicao, usuario);
  return requisicao;
}

export async function _mover_item(
  tx: Executor,
  linha: EpiRequisicaoItem,
  destino: string,
  usuario: UsuarioAtual | null,
  opcoes: {
    tipo_evento: string;
    comentario?: string | null;
    valor_novo?: unknown;
    detalhe?: string;
    campos?: Partial<EpiRequisicaoItem>;
  },
): Promise<EpiRequisicaoItem> {
  const origem = linha.estado;
  exigir_transicao_epi_item(origem, destino);
  // `campos` no MESMO UPDATE do estado (ck_item_lote: RESERVADO exige lote)
  await _gravar_linha(tx, linha, { ...(opcoes.campos ?? {}), estado: destino });
  const item = await _item(tx, linha.epi_item_id);
  const detalhe = opcoes.detalhe ?? "";
  await auditoria.registrar(tx, {
    entidade: ENTIDADE_ITEM,
    entidade_id: linha.id,
    tipo_evento: opcoes.tipo_evento,
    descricao: `${item.nome}: ${rotulo_item(origem)} → ${rotulo_item(destino)}` + (detalhe ? ` — ${detalhe}` : ""),
    campo: "estado",
    valor_anterior: origem,
    // RN-27: a recusa leva o CÓDIGO do motivo em `valor_novo`
    valor_novo: opcoes.valor_novo === undefined || opcoes.valor_novo === null ? destino : opcoes.valor_novo,
    comentario: opcoes.comentario ?? null,
    usuario,
  });
  // a pendência de falta e a de retirada entram na porta única do item
  await sincronizar_pendencia_de_falta(tx, linha, usuario);
  await sincronizar_pendencia_de_retirada(tx, linha, usuario);
  return linha;
}

// =====================================================================
// Fatia 7 — o item parado em SEM_ESTOQUE vai para o sino
// =====================================================================
export function chave_da_pendencia_de_falta(linha_id: number): string {
  return `sem_estoque:requisicao_item:${linha_id}`;
}

async function _pendencia_por_chave(tx: Executor, chave: string) {
  const [p] = await tx.select().from(tabela_pendencia).where(eq(tabela_pendencia.chave, chave));
  return p ?? null;
}

/**
 * Abre a pendência do item sem estoque, ou a fecha quando ela perdeu o objeto.
 * Não reserva nada: põe a lembrança no sino, com dono (quem marcou a falta) e
 * prazo. Fecha sozinha na saída do estado, seja qual for.
 */
export async function sincronizar_pendencia_de_falta(
  tx: Executor,
  linha: EpiRequisicaoItem,
  usuario: UsuarioAtual | null = null,
): Promise<void> {
  if (usuario === null) return;
  const chave = chave_da_pendencia_de_falta(linha.id);
  const existente = await _pendencia_por_chave(tx, chave);
  if (linha.estado !== "SEM_ESTOQUE") {
    if (existente && !existente.concluida) await pendencias.concluir(tx, existente, usuario);
    return;
  }
  // ida e volta é o caminho normal: `abrir` é idempotente por chave e não reabre
  if (existente) {
    if (existente.concluida) await pendencias.reabrir(tx, existente, usuario, "o item voltou a esperar estoque");
    return;
  }
  const requisicao = await _requisicao_da_linha(tx, linha);
  const item = await _item(tx, linha.epi_item_id);
  await pendencias.abrir(tx, {
    tipo: TIPO_PENDENCIA_SEM_ESTOQUE,
    chave,
    // RN-19: o pedido é identificado pelo protocolo, que não nomeia ninguém
    descricao:
      `${quantidade_devida(linha)} × '${item.nome}'` +
      (linha.tamanho ? ` tamanho ${linha.tamanho}` : "") +
      ` do pedido ${identificacao(requisicao)} está aprovado e sem lote ` +
      "desde " +
      datas_br.numerica(datas_br.hoje()) +
      ". Compre, reserve o " +
      "que entrar ou diga ao requerente que o item não vem — item aprovado " +
      "que ninguém mais olha é proteção que a pessoa não recebeu.",
    entidade: ENTIDADE_ITEM,
    entidade_id: linha.id,
    usuario,
  });
}

// =====================================================================
// Os dois avisos do requerente — a jornada que morria depois do protocolo
// =====================================================================
/**
 * A conta que deve receber o aviso: a de quem vai USAR o equipamento; sem
 * ela, quem digitou (`solicitado_por_id`).
 */
async function _conta_do_requerente(tx: Executor, requisicao: EpiRequisicao): Promise<number | null> {
  const [conta] = await tx
    .select({ id: tabela_usuario.id })
    .from(tabela_usuario)
    .where(and(eq(tabela_usuario.servidor_id, requisicao.servidor_id), eq(tabela_usuario.ativo, true)))
    .orderBy(asc(tabela_usuario.id))
    .limit(1);
  return conta?.id || requisicao.solicitado_por_id;
}

export function chave_da_pendencia_de_decisao(requisicao_id: number): string {
  return `decisao:requisicao:${requisicao_id}`;
}

export function chave_da_pendencia_de_retirada(linha_id: number): string {
  return `retirada:requisicao_item:${linha_id}`;
}

/**
 * Põe a decisão no sino de quem pediu — e a tira de lá quando ela envelhece.
 * Uma tarefa por PEDIDO, e não por item. RN-19: a descrição não nomeia ninguém.
 */
export async function sincronizar_pendencia_de_decisao(
  tx: Executor,
  requisicao: EpiRequisicao,
  usuario: UsuarioAtual | null = null,
): Promise<void> {
  if (usuario === null) return;
  const chave = chave_da_pendencia_de_decisao(requisicao.id);
  const existente = await _pendencia_por_chave(tx, chave);

  if (!DECIDIDO_E_NAO_LIDO.has(requisicao.estado)) {
    if (existente && !existente.concluida) await pendencias.concluir(tx, existente, usuario);
    return;
  }
  if (existente) {
    // decidir de novo é decisão NOVA sobre o mesmo pedido
    if (existente.concluida) await pendencias.reabrir(tx, existente, usuario, "o pedido foi decidido de novo");
    return;
  }

  const dono = await _conta_do_requerente(tx, requisicao);
  if (dono === null) return;

  let descricao: string;
  if (requisicao.estado === "INDEFERIDA") {
    const motivo =
      requisicao.motivo_recusa_id !== null
        ? (await tx.select().from(epi_motivo_recusa).where(eq(epi_motivo_recusa.id, requisicao.motivo_recusa_id)))[0]
        : undefined;
    descricao =
      `O pedido ${identificacao(requisicao)} foi indeferido` +
      (motivo ? ` — motivo ${motivo.codigo}` : "") +
      ". Abra o pedido e leia a negativa: o texto é o que estava vigente " +
      "no dia da decisão e não muda depois (RN-27). Discordando, o caminho " +
      "é pedir reconsideração à CSSO, não abrir outro pedido igual.";
  } else {
    const itens = await itens_de(tx, requisicao.id);
    const aprovados = itens.filter((i) => i.estado === "APROVADO").length;
    const recusados = itens.filter((i) => i.estado === "RECUSADO").length;
    descricao =
      `O pedido ${identificacao(requisicao)} foi decidido: ${aprovados} item(ns) ` +
      `aprovado(s) e ${recusados} recusado(s). Abra o pedido e leia — o ` +
      "motivo de cada recusa fica escrito como você o recebeu, e o que foi " +
      "aprovado ainda depende de haver lote no estoque.";
  }

  await pendencias.abrir(tx, {
    tipo: TIPO_PENDENCIA_DECISAO,
    chave,
    descricao,
    entidade: ENTIDADE,
    entidade_id: requisicao.id,
    responsavel_id: dono,
    usuario,
  });
}

/**
 * O aviso que faz a pessoa ir buscar — e some quando ela buscou. Enquanto o
 * item está `RESERVADO` a tarefa existe; em qualquer saída ela fecha sozinha.
 */
export async function sincronizar_pendencia_de_retirada(
  tx: Executor,
  linha: EpiRequisicaoItem,
  usuario: UsuarioAtual | null = null,
): Promise<void> {
  if (usuario === null) return;
  const chave = chave_da_pendencia_de_retirada(linha.id);
  const existente = await _pendencia_por_chave(tx, chave);

  if (linha.estado !== "RESERVADO") {
    if (existente && !existente.concluida) await pendencias.concluir(tx, existente, usuario);
    return;
  }
  if (existente) {
    if (existente.concluida) await pendencias.reabrir(tx, existente, usuario, "o item voltou a ter lote reservado");
    return;
  }

  const requisicao = await _requisicao_da_linha(tx, linha);
  const dono = await _conta_do_requerente(tx, requisicao);
  if (dono === null) return;
  const item = await _item(tx, linha.epi_item_id);

  await pendencias.abrir(tx, {
    tipo: TIPO_PENDENCIA_RETIRADA,
    chave,
    // RN-19: quantidade, item e protocolo
    descricao:
      `${linha.quantidade_reservada} × '${item.nome}'` +
      (linha.tamanho ? ` tamanho ${linha.tamanho}` : "") +
      ` do pedido ${identificacao(requisicao)} está separado no lote ` +
      `${await _rotulo_do_lote(tx, linha.entrada_id)} e espera você retirar. Abra ` +
      "o pedido: é lá que está onde e quando retirar. Reserva parada segura " +
      "estoque que nenhum outro pedido pode receber.",
    entidade: ENTIDADE,
    entidade_id: requisicao.id,
    responsavel_id: dono,
    usuario,
  });
}

export async function requisicoes_de(tx: Executor, servidor_id: number): Promise<EpiRequisicao[]> {
  return tx
    .select()
    .from(epi_requisicao)
    .where(eq(epi_requisicao.servidor_id, servidor_id))
    .orderBy(desc(epi_requisicao.id));
}

/**
 * A terceira camada sobre `epi_requisicao` — com as duas ressalvas do modelo.
 * Devolve a CONDIÇÃO (ver `aplicar_escopo` em DESVIOS.md).
 *
 * - Unidade: `campus_id` só é congelado no envio; rascunho sem campus não é de
 *   outra unidade, é de nenhuma ainda.
 * - Próprio: o pedido tem duas pessoas, e `solicitado_por_id` é a segunda.
 */
export function _no_escopo(usuario: UsuarioAtual): SQL | undefined {
  if (usuario.escopo === ESCOPO_UNIDADE && usuario.campi.length) {
    return or(inArray(epi_requisicao.campus_id, [...usuario.campi]), isNull(epi_requisicao.campus_id));
  }
  if (usuario.escopo === ESCOPO_PROPRIO) {
    return or(
      eq(epi_requisicao.servidor_id, usuario.servidor_id || -1),
      eq(epi_requisicao.solicitado_por_id, usuario.id),
    );
  }
  return aplicar_escopo(usuario, epi_requisicao);
}

/**
 * A única leitura de requisição por id. Fora do escopo e inexistente devolvem
 * a mesma coisa de propósito.
 */
export async function no_escopo(tx: Executor, usuario: UsuarioAtual, requisicao_id: number): Promise<EpiRequisicao | null> {
  const [r] = await tx
    .select()
    .from(epi_requisicao)
    .where(and(eq(epi_requisicao.id, requisicao_id), _no_escopo(usuario)));
  return r ?? null;
}

/**
 * A fila de `/epis/requisicoes`, do mais antigo para o mais novo (por `id`).
 * `usuario` é obrigatório: fila sem escopo foi exatamente o defeito.
 */
export async function fila(
  tx: Executor,
  usuario: UsuarioAtual,
  opcoes: { estados?: readonly string[] } = {},
): Promise<EpiRequisicao[]> {
  const estados = opcoes.estados ?? [];
  return tx
    .select()
    .from(epi_requisicao)
    .where(and(estados.length ? inArray(epi_requisicao.estado, [...estados]) : undefined, _no_escopo(usuario)))
    .orderBy(asc(epi_requisicao.id));
}

// =====================================================================
// O rascunho
// =====================================================================
export interface CamposCabecalho {
  chefia_servidor_id?: number | null;
  finalidade?: string;
  descricao_atividade?: string;
  riscos_declarados?: string;
  urgencia?: string;
  justificativa_urgencia?: string;
}

/** O pedido em digitação. **Não consome protocolo** — ver RN-03. */
export async function criar_rascunho(
  tx: Executor,
  usuario: UsuarioAtual,
  opcoes: { servidor: Pick<Servidor, "id"> } & CamposCabecalho,
): Promise<EpiRequisicao> {
  usuario.exigir("epi.requisitar");
  const campos = _campos_do_cabecalho({
    finalidade: opcoes.finalidade ?? "ROTINA",
    descricao_atividade: opcoes.descricao_atividade ?? "",
    riscos_declarados: opcoes.riscos_declarados ?? "",
    urgencia: opcoes.urgencia ?? "NORMAL",
    justificativa_urgencia: opcoes.justificativa_urgencia ?? "",
  });
  const [requisicao] = await tx
    .insert(epi_requisicao)
    .values({
      servidor_id: opcoes.servidor.id,
      solicitado_por_id: usuario.id,
      chefia_servidor_id: opcoes.chefia_servidor_id ?? null,
      estado: "RASCUNHO",
      ...campos,
    })
    .returning();
  await auditoria.registrar(tx, {
    entidade: ENTIDADE,
    entidade_id: requisicao!.id,
    tipo_evento: EPI_REQUISICAO_CRIADA,
    // RN-19 na ESCRITA: o pedido sai pelo id do servidor
    descricao: `Rascunho de requisição de EPI para o servidor #${opcoes.servidor.id} ` + `aberto por ${usuario.nome}`,
    campo: "estado",
    valor_novo: "RASCUNHO",
    usuario,
  });
  return requisicao!;
}

/** Edita o cabeçalho enquanto ele é rascunho, e só enquanto. */
export async function atualizar_rascunho(
  tx: Executor,
  usuario: UsuarioAtual,
  requisicao: EpiRequisicao,
  opcoes: CamposCabecalho = {},
): Promise<EpiRequisicao> {
  usuario.exigir("epi.requisitar");
  _exigir_editavel(requisicao, "editar o pedido");
  const campos = _campos_do_cabecalho({
    finalidade: opcoes.finalidade ?? "ROTINA",
    descricao_atividade: opcoes.descricao_atividade ?? "",
    riscos_declarados: opcoes.riscos_declarados ?? "",
    urgencia: opcoes.urgencia ?? "NORMAL",
    justificativa_urgencia: opcoes.justificativa_urgencia ?? "",
  });
  const antes: Record<string, unknown> = {};
  for (const campo of Object.keys(campos)) antes[campo] = (requisicao as Record<string, unknown>)[campo];
  antes["chefia_servidor_id"] = requisicao.chefia_servidor_id;
  await _gravar(tx, requisicao, { ...campos, chefia_servidor_id: opcoes.chefia_servidor_id ?? null });
  const depois: Record<string, unknown> = {};
  for (const campo of Object.keys(antes)) depois[campo] = (requisicao as Record<string, unknown>)[campo];
  await auditoria.registrar_diferencas(tx, {
    entidade: ENTIDADE,
    entidade_id: requisicao.id,
    antes,
    depois,
    usuario,
  });
  return requisicao;
}

/** Valida e limpa o cabeçalho. RN-30 antes de qualquer gravação. */
function _campos_do_cabecalho(c: {
  finalidade: string;
  descricao_atividade: string;
  riscos_declarados: string;
  urgencia: string;
  justificativa_urgencia: string;
}) {
  const problemas: string[] = [];
  if (!(FINALIDADES_REQUISICAO as readonly string[]).includes(c.finalidade)) {
    problemas.push(`finalidade desconhecida: '${c.finalidade}'. Conhecidas: ` + FINALIDADES_REQUISICAO.join(", "));
  }
  if (!(URGENCIAS_REQUISICAO as readonly string[]).includes(c.urgencia)) {
    problemas.push(`urgência desconhecida: '${c.urgencia}'. Conhecidas: ` + URGENCIAS_REQUISICAO.join(", "));
  }
  const justificativa = (c.justificativa_urgencia || "").trim();
  if (c.urgencia === "URGENTE" && !justificativa) {
    problemas.push(
      "pedido urgente exige a justificativa da urgência: sem ela " +
        "'urgente' vira o padrão de todo mundo e deixa de ordenar a fila",
    );
  }
  if (problemas.length) throw new RequisicaoBloqueada(problemas);

  return {
    finalidade: c.finalidade,
    descricao_atividade: textos.exigir_texto_limpo((c.descricao_atividade || "").trim(), "rotina de trabalho") || null,
    riscos_declarados: textos.exigir_texto_limpo((c.riscos_declarados || "").trim(), "riscos declarados") || null,
    urgencia: c.urgencia,
    justificativa_urgencia: textos.exigir_texto_limpo(justificativa, "justificativa da urgência") || null,
  };
}

function _exigir_editavel(requisicao: EpiRequisicao, acao: string): void {
  if (EDITAVEL.has(requisicao.estado)) return;
  throw new RequisicaoBloqueada([
    `${acao} só é possível enquanto a requisição é rascunho, e ` +
      `${identificacao(requisicao)} está em ` +
      `${rotulo_req(requisicao.estado).toLowerCase()}. ` +
      "Pedido protocolado se corrige por cancelamento com motivo e pedido " +
      "novo (RN-31) — não por edição em silêncio do que já circulou",
  ]);
}

/**
 * RN-31 — o único estado que some de verdade. O evento de exclusão é gravado
 * ANTES do delete, e sobrevive a ele.
 */
export async function excluir_rascunho(tx: Executor, usuario: UsuarioAtual, requisicao: EpiRequisicao): Promise<void> {
  usuario.exigir("epi.requisitar");
  if (requisicao.estado !== "RASCUNHO") {
    throw new RequisicaoBloqueada([
      `${identificacao(requisicao)} está em ` +
        `${rotulo_req(requisicao.estado).toLowerCase()} ` +
        "e não se exclui: requisição enviada cancela com motivo (RN-31). " +
        "Só rascunho pode sumir de verdade",
    ]);
  }
  const itens = await itens_de(tx, requisicao.id);
  await auditoria.registrar(tx, {
    entidade: ENTIDADE,
    entidade_id: requisicao.id,
    tipo_evento: EPI_REQUISICAO_EXCLUIDA,
    descricao:
      `Rascunho #${requisicao.id} de requisição de EPI para o servidor ` +
      `#${requisicao.servidor_id} excluído por ${usuario.nome} — ` +
      `${itens.length} item(ns) em digitação`,
    campo: "estado",
    valor_anterior: "RASCUNHO",
    valor_novo: null,
    usuario,
  });
  // os itens vão junto (ON DELETE CASCADE, o `delete-orphan` do Python)
  await tx.delete(epi_requisicao).where(eq(epi_requisicao.id, requisicao.id));
}

// =====================================================================
// Os itens do rascunho
// =====================================================================
/**
 * Uma linha do pedido. Item inativo não entra; quantidade tem de ser > 0. A
 * RN-29 (justificativa onde o catálogo exige) é cobrada no ENVIO.
 */
export async function adicionar_item(
  tx: Executor,
  usuario: UsuarioAtual,
  requisicao: EpiRequisicao,
  opcoes: { item: EpiItem; quantidade: number; tamanho?: string; justificativa?: string },
): Promise<EpiRequisicaoItem> {
  usuario.exigir("epi.requisitar");
  _exigir_editavel(requisicao, "acrescentar item");
  const { item, quantidade } = opcoes;
  const problemas: string[] = [];
  if (quantidade <= 0) problemas.push("a quantidade pedida tem de ser maior que zero");
  if (!item.ativo) problemas.push(`'${item.nome}' está inativo no catálogo e não pode ser requisitado`);
  const limpo = (opcoes.tamanho || "").trim();
  const tamanhos = EpiItemDominio.lista_de_tamanhos(item);
  if (tamanhos.length && limpo && !tamanhos.includes(limpo)) {
    problemas.push(`'${limpo}' não é um dos tamanhos cadastrados para '${item.nome}': ` + tamanhos.join(", "));
  }
  if (tamanhos.length && !limpo) {
    problemas.push(
      `'${item.nome}' tem tamanho cadastrado (${tamanhos.join(", ")}): ` +
        "pedir sem dizer qual é pedir o que não se pode separar da prateleira",
    );
  }
  if ((await _linha_igual(tx, requisicao, item.id, limpo)) !== null) {
    problemas.push(
      `'${item.nome}' já está no pedido com este tamanho: some as ` + "quantidades numa linha só, em vez de repetir o item",
    );
  }
  if (problemas.length) throw new RequisicaoBloqueada(problemas);

  const [linha] = await tx
    .insert(epi_requisicao_item)
    .values({
      requisicao_id: requisicao.id,
      epi_item_id: item.id,
      tamanho: limpo || null,
      quantidade_solicitada: quantidade,
      justificativa: textos.exigir_texto_limpo((opcoes.justificativa || "").trim(), "justificativa do item") || null,
      estado: "SOLICITADO",
    })
    .returning();
  return linha!;
}

export async function editar_item(
  tx: Executor,
  usuario: UsuarioAtual,
  linha: EpiRequisicaoItem,
  opcoes: { quantidade: number; tamanho?: string; justificativa?: string },
): Promise<EpiRequisicaoItem> {
  usuario.exigir("epi.requisitar");
  const requisicao = await _requisicao_da_linha(tx, linha);
  _exigir_editavel(requisicao, "editar item");
  const item = await _item(tx, linha.epi_item_id);
  const problemas: string[] = [];
  if (opcoes.quantidade <= 0) problemas.push("a quantidade pedida tem de ser maior que zero");
  const limpo = (opcoes.tamanho || "").trim();
  const tamanhos = EpiItemDominio.lista_de_tamanhos(item);
  if (tamanhos.length && !tamanhos.includes(limpo)) {
    problemas.push(`'${limpo || "—"}' não é um dos tamanhos cadastrados para ` + `'${item.nome}': ` + tamanhos.join(", "));
  }
  const outra = await _linha_igual(tx, requisicao, linha.epi_item_id, limpo);
  if (outra !== null && outra.id !== linha.id) {
    problemas.push(`já existe outra linha de '${item.nome}' com este tamanho`);
  }
  if (problemas.length) throw new RequisicaoBloqueada(problemas);

  await _gravar_linha(tx, linha, {
    quantidade_solicitada: opcoes.quantidade,
    tamanho: limpo || null,
    justificativa: textos.exigir_texto_limpo((opcoes.justificativa || "").trim(), "justificativa do item") || null,
  });
  return linha;
}

/** Some de verdade — mas só dentro do rascunho, que também some. */
export async function remover_item(tx: Executor, usuario: UsuarioAtual, linha: EpiRequisicaoItem): Promise<void> {
  usuario.exigir("epi.requisitar");
  const requisicao = await _requisicao_da_linha(tx, linha);
  _exigir_editavel(requisicao, "remover item");
  await tx.delete(epi_requisicao_item).where(eq(epi_requisicao_item.id, linha.id));
}

/** A conferência que o `uq_req_item` faz no banco, feita antes, para a mensagem. */
async function _linha_igual(
  tx: Executor,
  requisicao: EpiRequisicao,
  epi_item_id: number,
  tamanho: string,
): Promise<EpiRequisicaoItem | null> {
  const alvo = tamanho || null;
  for (const linha of await itens_de(tx, requisicao.id)) {
    if (linha.epi_item_id === epi_item_id && (linha.tamanho || null) === alvo) return linha;
  }
  return null;
}

// =====================================================================
// Enviar — o protocolo, o congelamento e a RN-29
// =====================================================================
/**
 * RASCUNHO → ENVIADA. A ordem: permissão e estado; validar tudo (≥1 item e
 * RN-29) ANTES de gastar número; congelar a lotação; consumir o protocolo;
 * mover e auditar.
 */
export async function enviar(
  tx: Executor,
  usuario: UsuarioAtual,
  requisicao: EpiRequisicao,
  opcoes: { quando?: string | null } = {},
): Promise<EpiRequisicao> {
  usuario.exigir("epi.requisitar");
  const quando = opcoes.quando || datas_br.hoje();
  if (requisicao.estado !== "RASCUNHO") {
    throw new RequisicaoBloqueada([`${identificacao(requisicao)} já foi enviada — o protocolo é ` + "consumido uma vez só"]);
  }

  const itens = await itens_de(tx, requisicao.id);
  const problemas: string[] = [];
  if (!itens.length) {
    problemas.push("o pedido não tem nenhum item: um envelope vazio ocuparia protocolo " + "e fila sem pedir nada");
  }
  // RN-29 — justificativa onde o CATÁLOGO exige
  for (const linha of itens) {
    const item = await _item(tx, linha.epi_item_id);
    if (item.exige_justificativa && !(linha.justificativa || "").trim()) {
      problemas.push(
        `'${item.nome}' exige justificativa no catálogo e a linha ` +
          "está sem: diga por que este equipamento é necessário neste posto",
      );
    }
    if (!item.ativo) {
      problemas.push(
        `'${item.nome}' foi inativado no catálogo depois de entrar ` +
          "no rascunho: remova a linha ou escolha o item que o substituiu",
      );
    }
  }
  if (problemas.length) throw new RequisicaoBloqueada(problemas);

  await _congelar_lotacao(tx, requisicao, quando);

  const ano = Number(quando.slice(0, 4));
  const numero = await numeracao.proximo_numero_requisicao_epi(tx, ano);
  const campos = { ano, numero, protocolo: protocolo_de(ano, numero), enviada_em: agora_utc() };

  return _mover(tx, requisicao, "ENVIADA", usuario, {
    campos,
    tipo_evento: EPI_REQUISICAO_ENVIADA,
    comentario: `${itens.length} item(ns) · ` + `${requisicao.urgencia === "URGENTE" ? "URGENTE" : "normal"}`,
  });
}

/** `EPI-2026-0001`. Passando de 9999, o formato cresce em vez de truncar. */
export function protocolo_de(ano: number, numero: number): string {
  return `EPI-${ano}-${String(numero).padStart(4, "0")}`;
}

/** Onde a pessoa estava NO ENVIO — não onde ela está hoje. */
async function _congelar_lotacao(tx: Executor, requisicao: EpiRequisicao, quando: string): Promise<void> {
  const servidor = await tx.query.servidor.findFirst({
    where: eq(tabela_servidor.id, requisicao.servidor_id),
    with: { unidade: true, cargo: true },
  });
  if (!servidor) return;
  const lotacao = await servico_servidores.lotacao_em(tx, servidor.id, quando);
  const unidade = (lotacao ? lotacao.unidade : null) || servidor.unidade;
  const postos = lotacao ? lotacao.postos : [];
  const cargo = (lotacao ? lotacao.cargo : null) || servidor.cargo;
  const funcao = (lotacao ? lotacao.funcao : null) || servidor.funcao;
  await _gravar(tx, requisicao, {
    unidade_uorg_id: unidade ? unidade.id : null,
    campus_id: unidade ? unidade.campus_id : null,
    // um posto, e o primeiro da ordem: o pedido é sobre o risco de UM posto
    posto_trabalho_id: postos.length ? postos[0]!.id : null,
    cargo_snapshot: cargo ? cargo.nome : null,
    funcao_snapshot: funcao || null,
  });
}

// =====================================================================
// A análise — envelope
// =====================================================================
/** ENVIADA → EM_ANALISE. Quem pega o pedido assume o nome nele. */
export async function iniciar_analise(tx: Executor, usuario: UsuarioAtual, requisicao: EpiRequisicao): Promise<EpiRequisicao> {
  await _exigir_analista_diferente(tx, usuario, requisicao);
  await _gravar(tx, requisicao, { analisado_por: usuario.id, analisado_em: agora_utc() });
  return _mover(tx, requisicao, "EM_ANALISE", usuario, {
    tipo_evento: EPI_REQUISICAO_EM_ANALISE,
    comentario: `em análise com ${usuario.nome}`,
  });
}

/** EM_ANALISE → ENVIADA. Decidir sem base é pior do que devolver. */
export async function devolver_para_fila(
  tx: Executor,
  usuario: UsuarioAtual,
  requisicao: EpiRequisicao,
  motivo: string,
): Promise<EpiRequisicao> {
  await _exigir_analista_diferente(tx, usuario, requisicao);
  const limpo = _motivo_obrigatorio(motivo, "motivo da devolução à fila");
  await _gravar(tx, requisicao, { analisado_por: null, analisado_em: null });
  return _mover(tx, requisicao, "ENVIADA", usuario, { tipo_evento: EPI_REQUISICAO_DEVOLVIDA, comentario: limpo });
}

/** EM_ANALISE → ANALISADA: todo item decidido, e ao menos um APROVADO. */
export async function concluir_analise(
  tx: Executor,
  usuario: UsuarioAtual,
  requisicao: EpiRequisicao,
  opcoes: { parecer?: string } = {},
): Promise<EpiRequisicao> {
  await _exigir_analista_diferente(tx, usuario, requisicao);
  const itens = await itens_de(tx, requisicao.id);
  const pendentes = itens.filter((i) => !EPI_ITEM_DECIDIDO.has(i.estado));
  const problemas: string[] = [];
  if (pendentes.length) {
    const nomes: string[] = [];
    for (const i of pendentes) nomes.push((await _item(tx, i.epi_item_id)).nome);
    problemas.push(
      "ainda há item sem decisão: " + nomes.sort().join(", ") + ". Analisar pela metade tiraria da fila o que ninguém decidiu",
    );
  }
  if (!itens.some((i) => i.estado === "APROVADO")) {
    problemas.push(
      "nenhum item foi aprovado: se a resposta é negativa em tudo, o " +
        "caminho é indeferir, que exige o motivo do catálogo (RN-27)",
    );
  }
  if (problemas.length) throw new RequisicaoBloqueada(problemas);

  await _gravar(tx, requisicao, {
    parecer_analise: textos.exigir_texto_limpo((opcoes.parecer || "").trim(), "parecer da análise") || null,
    analisado_por: usuario.id,
    analisado_em: agora_utc(),
  });
  return _mover(tx, requisicao, "ANALISADA", usuario, {
    tipo_evento: EPI_REQUISICAO_ANALISADA,
    comentario: requisicao.parecer_analise,
  });
}

/** EM_ANALISE → INDEFERIDA: todo item RECUSADO, com motivo do catálogo. */
export async function indeferir(
  tx: Executor,
  usuario: UsuarioAtual,
  requisicao: EpiRequisicao,
  opcoes: { motivo: EpiMotivoRecusa; complemento?: string; parecer?: string },
): Promise<EpiRequisicao> {
  await _exigir_analista_diferente(tx, usuario, requisicao);
  const { motivo } = opcoes;
  const limpo = textos.exigir_texto_limpo((opcoes.complemento || "").trim(), "complemento do indeferimento");
  const itens = await itens_de(tx, requisicao.id);
  const problemas: string[] = [];
  if (!itens.length) problemas.push("não há item para indeferir");
  const nao_recusados = itens.filter((i) => i.estado !== "RECUSADO");
  if (nao_recusados.length) {
    const nomes: string[] = [];
    for (const i of nao_recusados) nomes.push((await _item(tx, i.epi_item_id)).nome);
    problemas.push(
      "indeferir é a resposta quando TODO item foi recusado, e ainda há " +
        nomes.sort().join(", ") +
        " fora disso. Com item aprovado, o caminho é concluir a análise",
    );
  }
  if (!motivo.ativo) problemas.push(`o motivo ${motivo.codigo} está inativo no catálogo`);
  if (motivo.exige_complemento && !limpo) problemas.push(`o motivo ${motivo.codigo} exige o complemento por escrito`);
  if (problemas.length) throw new RequisicaoBloqueada(problemas);

  await _gravar(tx, requisicao, {
    motivo_recusa_id: motivo.id,
    complemento_recusa: limpo || null,
    parecer_analise: textos.exigir_texto_limpo((opcoes.parecer || "").trim(), "parecer da análise") || null,
    analisado_por: usuario.id,
    analisado_em: agora_utc(),
  });
  return _mover(tx, requisicao, "INDEFERIDA", usuario, {
    tipo_evento: EPI_REQUISICAO_INDEFERIDA,
    comentario: `${motivo.codigo}: ${motivo.rotulo}` + (limpo ? ` — ${limpo}` : ""),
  });
}

/**
 * INDEFERIDA → EM_ANALISE. O único caminho de volta de um terminal. Os itens
 * NÃO voltam sozinhos.
 */
export async function reconsiderar(
  tx: Executor,
  usuario: UsuarioAtual,
  requisicao: EpiRequisicao,
  motivo: string,
): Promise<EpiRequisicao> {
  await _exigir_analista_diferente(tx, usuario, requisicao);
  const limpo = _motivo_obrigatorio(motivo, "motivo da reconsideração");
  await _gravar(tx, requisicao, { analisado_por: usuario.id, analisado_em: agora_utc() });
  return _mover(tx, requisicao, "EM_ANALISE", usuario, { tipo_evento: EPI_REQUISICAO_RECONSIDERADA, comentario: limpo });
}

/**
 * A desistência, com motivo — em qualquer estado antes da entrega. Aceita
 * `epi.requisitar` OU `epi.analisar`; a RN-28 governa a decisão, não a
 * desistência.
 */
export async function cancelar(
  tx: Executor,
  usuario: UsuarioAtual,
  requisicao: EpiRequisicao,
  motivo: string,
): Promise<EpiRequisicao> {
  if (!(usuario.pode("epi.requisitar") || usuario.pode("epi.analisar"))) throw new PermissaoNegada("epi.requisitar");
  const limpo = _motivo_obrigatorio(motivo, "motivo do cancelamento");
  const itens = await itens_de(tx, requisicao.id);
  const entregues = itens.filter((i) => i.quantidade_entregue > 0);
  if (entregues.length) {
    const partes: string[] = [];
    for (const i of entregues) partes.push(`${i.quantidade_entregue} × ${(await _item(tx, i.epi_item_id)).nome}`);
    throw new RequisicaoBloqueada([
      "já houve entrega neste pedido (" +
        partes.join(", ") +
        "), e o que foi entregue não se desfaz por cancelamento. A " +
        "ficha registra a entrega; devolver o equipamento é devolução, " +
        "e corrigir o registro é estorno",
    ]);
  }
  await _gravar(tx, requisicao, { motivo_cancelamento: limpo });
  // os itens abertos vão junto, e soltam a reserva
  for (const linha of itens) {
    if (["SOLICITADO", "APROVADO", "RESERVADO", "SEM_ESTOQUE"].includes(linha.estado)) {
      await _mover_item(tx, linha, "CANCELADO", usuario, {
        campos: LIBERAR_RESERVA,
        tipo_evento: EPI_ITEM_CANCELADO,
        comentario: limpo,
        detalhe: "pedido cancelado",
      });
    }
  }
  return _mover(tx, requisicao, "CANCELADA", usuario, { tipo_evento: EPI_REQUISICAO_CANCELADA, comentario: limpo });
}

// =====================================================================
// A análise — item a item (é aqui que a decisão acontece)
// =====================================================================
/**
 * SOLICITADO → APROVADO, com a RN-26 contada NA FICHA. Estourar a janela é
 * bloqueio até alguém autorizar a exceção, com justificativa e com o nome.
 */
export async function aprovar_item(
  tx: Executor,
  usuario: UsuarioAtual,
  linha: EpiRequisicaoItem,
  opcoes: { quantidade_aprovada?: number | null; justificativa?: string; autorizar_excesso?: boolean; quando?: string | null } = {},
): Promise<EpiRequisicaoItem> {
  const requisicao = await _requisicao_da_linha(tx, linha);
  await _exigir_analista_diferente(tx, usuario, requisicao);
  const quando = opcoes.quando || datas_br.hoje();
  const limpa = textos.exigir_texto_limpo((opcoes.justificativa || "").trim(), "justificativa do item");
  const quantidade =
    opcoes.quantidade_aprovada === undefined || opcoes.quantidade_aprovada === null
      ? linha.quantidade_solicitada
      : opcoes.quantidade_aprovada;
  const item = await _item(tx, linha.epi_item_id);

  const problemas: string[] = [];
  if (requisicao.estado !== "EM_ANALISE") {
    problemas.push(
      `decidir item exige a requisição em análise, e ` +
        `${identificacao(requisicao)} está em ` +
        `${rotulo_req(requisicao.estado).toLowerCase()}`,
    );
  }
  if (quantidade <= 0) {
    problemas.push(
      "aprovar zero não é aprovar: se o item não vai sair, o caminho é " +
        "recusar com motivo do catálogo (RN-27), que é o que o requerente " +
        "precisa receber por escrito",
    );
  }
  if (quantidade > linha.quantidade_solicitada) {
    problemas.push(`foram pedidos ${linha.quantidade_solicitada} de ` + `'${item.nome}' e a aprovação registra ${quantidade}`);
  }

  // RN-26, com a conta saindo da ficha
  let excedeu = false;
  let ja = 0;
  if (item.quantidade_maxima !== null && quantidade > 0) {
    ja = await epi_ficha.entregue_na_janela(tx, requisicao.servidor_id, item, quando);
    if (ja + quantidade > item.quantidade_maxima) {
      excedeu = true;
      const recado =
        `a ficha registra ${ja} de '${item.nome}' entregue(s) nos ` +
        `últimos ${item.periodo_maximo_meses} meses, o máximo é ` +
        `${item.quantidade_maxima} e esta aprovação soma ` +
        `${ja + quantidade}`;
      if (!opcoes.autorizar_excesso) {
        problemas.push(`${recado}. Para aprovar assim mesmo, autorize a exceção: ` + "ela fica registrada com o seu nome (RN-26)");
      } else if (!limpa) {
        problemas.push(
          `${recado}. A exceção exige a justificativa por escrito — é ` + "ela que sustenta a decisão de quem a assinou",
        );
      }
    }
  }
  if (problemas.length) throw new RequisicaoBloqueada(problemas);

  const campos: Partial<EpiRequisicaoItem> = {
    quantidade_aprovada: quantidade,
    decidido_por: usuario.id,
    decidido_em: agora_utc(),
  };
  if (limpa) campos.justificativa = limpa;
  if (excedeu) {
    campos.excedeu_maximo = true;
    campos.autorizado_por = usuario.id;
  }
  await _gravar_linha(tx, linha, campos);

  await _mover_item(tx, linha, "APROVADO", usuario, {
    tipo_evento: EPI_ITEM_APROVADO,
    detalhe: `${quantidade} de ${linha.quantidade_solicitada} pedido(s)`,
    comentario: limpa || null,
  });
  if (excedeu) {
    await auditoria.registrar(tx, {
      entidade: ENTIDADE_ITEM,
      entidade_id: linha.id,
      tipo_evento: EPI_MAXIMO_EXCEDIDO,
      descricao:
        `Máximo de '${item.nome}' (${EpiItemDominio.regra_de_quantidade(item)}) ` +
        `excedido em ${identificacao(requisicao)} e autorizado por ` +
        `${usuario.nome}: ${linha.justificativa}`,
      campo: "excedeu_maximo",
      // inteiros de verdade: a trava da auditoria recusa valor que não volta igual
      valor_anterior: ja,
      valor_novo: ja + quantidade,
      comentario: linha.justificativa,
      usuario,
    });
  }
  return linha;
}

/**
 * SOLICITADO → RECUSADO. RN-27: fundamentada, catalogada e CONGELADA — o texto
 * vigente do motivo é copiado para `texto_recusa_snapshot` no ato, e o CÓDIGO
 * do motivo vai em `valor_novo` do evento (a contagem sai da trilha).
 */
export async function recusar_item(
  tx: Executor,
  usuario: UsuarioAtual,
  linha: EpiRequisicaoItem,
  opcoes: { motivo: EpiMotivoRecusa; complemento?: string },
): Promise<EpiRequisicaoItem> {
  const requisicao = await _requisicao_da_linha(tx, linha);
  await _exigir_analista_diferente(tx, usuario, requisicao);
  const { motivo } = opcoes;
  const limpo = textos.exigir_texto_limpo((opcoes.complemento || "").trim(), "complemento da recusa");
  const problemas: string[] = [];
  if (requisicao.estado !== "EM_ANALISE") {
    problemas.push(
      `decidir item exige a requisição em análise, e ` +
        `${identificacao(requisicao)} está em ` +
        `${rotulo_req(requisicao.estado).toLowerCase()}`,
    );
  }
  if (!motivo.ativo) problemas.push(`o motivo ${motivo.codigo} está inativo no catálogo`);
  if (motivo.exige_complemento && !limpo) {
    problemas.push(
      `o motivo ${motivo.codigo} exige o complemento por escrito: sem ele ` + "a negativa não diz à pessoa o que fazer a seguir",
    );
  }
  if (problemas.length) throw new RequisicaoBloqueada(problemas);

  await _gravar_linha(tx, linha, {
    motivo_recusa_id: motivo.id,
    complemento_recusa: limpo || null,
    // o texto vai INTEIRO, e não um ponteiro
    texto_recusa_snapshot: motivo.texto,
    quantidade_aprovada: 0,
    decidido_por: usuario.id,
    decidido_em: agora_utc(),
  });
  let unidade: string | null = null;
  if (requisicao.unidade_uorg_id !== null) {
    const u = await tx.query.unidade_uorg.findFirst({
      where: (t, { eq: igual }) => igual(t.id, requisicao.unidade_uorg_id!),
    });
    unidade = u ? u.nome_extenso : null;
  }
  return _mover_item(tx, linha, "RECUSADO", usuario, {
    tipo_evento: EPI_ITEM_RECUSADO,
    detalhe: `${motivo.codigo} — ${motivo.rotulo}`,
    comentario: limpo || null,
    valor_novo: {
      estado: "RECUSADO",
      motivo: motivo.codigo,
      rotulo: motivo.rotulo,
      base_normativa: motivo.base_normativa,
      complemento: limpo || null,
      unidade,
    },
  });
}

/**
 * A linha sai do pedido sem virar recusa. Motivo obrigatório. Cancelar solta
 * a reserva.
 */
export async function cancelar_item(
  tx: Executor,
  usuario: UsuarioAtual,
  linha: EpiRequisicaoItem,
  motivo: string,
): Promise<EpiRequisicaoItem> {
  if (!(usuario.pode("epi.requisitar") || usuario.pode("epi.analisar"))) throw new PermissaoNegada("epi.analisar");
  const limpo = _motivo_obrigatorio(motivo, "motivo do cancelamento do item");
  if (linha.quantidade_entregue > 0) {
    const item = await _item(tx, linha.epi_item_id);
    throw new RequisicaoBloqueada([
      `'${item.nome}' já teve ${linha.quantidade_entregue} ` +
        "entregue(s), e entrega registrada não se desfaz por " +
        "cancelamento: a ficha é a prova de que o equipamento saiu",
    ]);
  }
  await _gravar_linha(tx, linha, { decidido_por: usuario.id, decidido_em: agora_utc() });
  const resultado = await _mover_item(tx, linha, "CANCELADO", usuario, {
    campos: LIBERAR_RESERVA,
    tipo_evento: EPI_ITEM_CANCELADO,
    comentario: limpo,
    detalhe: limpo,
  });
  await sincronizar_atendimento(tx, await _requisicao_da_linha(tx, linha), usuario);
  return resultado;
}

// =====================================================================
// A reserva (fatia 5) — é ela que impede dois pedidos de prometerem a
// mesma bota
// =====================================================================
export const RESERVAVEL: ReadonlySet<string> = new Set(["APROVADO", "SEM_ESTOQUE"]);
// O envelope em que o almoxarifado opera.
export const ATENDIVEL: readonly string[] = ["ANALISADA", "EM_ATENDIMENTO"];

/**
 * APROVADO (ou SEM_ESTOQUE) → RESERVADO, com RN-24 e RN-25 na porta.
 *
 * Ato explícito, nunca automático na entrada de lote: reserva automática
 * mudaria saldo sem ninguém mandar, e escolher quem recebe estoque escasso é
 * decisão, não ordem de laço.
 *
 * Concorrência: no SQLite o `BEGIN IMMEDIATE` fazia a leitura do disponível e
 * a gravação caberem numa transação sem outro escritor. No Postgres a linha do
 * lote é travada (`SELECT ... FOR UPDATE`) antes da leitura: duas reservas no
 * mesmo lote se enfileiram, e a segunda lê o disponível já sem a primeira.
 */
export async function reservar_item(
  tx: Executor,
  usuario: UsuarioAtual,
  linha: EpiRequisicaoItem,
  opcoes: { entrada: EpiEntradaEstoque; quantidade?: number | null; quando?: string | null },
): Promise<EpiRequisicaoItem> {
  usuario.exigir("epi.estoque");
  const { entrada } = opcoes;
  const requisicao = await _requisicao_da_linha(tx, linha);
  const quando = opcoes.quando || datas_br.hoje();
  const quantidade = opcoes.quantidade === undefined || opcoes.quantidade === null ? quantidade_devida(linha) : opcoes.quantidade;
  const item = await _item(tx, linha.epi_item_id);

  const problemas: string[] = [];
  if (!ATENDIVEL.includes(requisicao.estado)) {
    problemas.push(
      `reservar exige a requisição analisada, e ` +
        `${identificacao(requisicao)} está em ` +
        `${rotulo_req(requisicao.estado).toLowerCase()}`,
    );
  }
  if (!RESERVAVEL.has(linha.estado)) {
    problemas.push(
      `'${item.nome}' está em ` +
        `${rotulo_item(linha.estado).toLowerCase()} e só se ` +
        "reserva o que foi aprovado e ainda não saiu",
    );
  }
  if (quantidade <= 0) {
    problemas.push("a quantidade a reservar tem de ser maior que zero");
  } else if (quantidade > quantidade_devida(linha)) {
    problemas.push(
      `foram aprovados ${linha.quantidade_aprovada} de ` +
        `'${item.nome}', ${linha.quantidade_entregue} já saíram e a ` +
        `reserva pede ${quantidade}: reservar mais do que se deve é prometer ` +
        "a prateleira a quem não tem direito a ela",
    );
  }
  if (entrada.epi_item_id !== linha.epi_item_id) {
    problemas.push("o lote escolhido é de outro item do catálogo");
  } else if (linha.tamanho && entrada.tamanho && entrada.tamanho !== linha.tamanho) {
    problemas.push(
      `o pedido é do tamanho ${linha.tamanho} e o lote é do tamanho ` +
        `${entrada.tamanho}: '40 luvas' não quer dizer nada se são todas P`,
    );
  }

  // RN-25, primeiro dos dois momentos: é o lote que manda, não o catálogo
  const impedimento = epi_estoque.impedimento_do_lote(entrada, item, quando);
  if (impedimento) problemas.push(`o lote não pode ser prometido — ${impedimento}`);

  // RN-24 — agregado sobre outra tabela; a linha do lote travada antes (ver acima)
  await _travar_lote(tx, entrada.id);
  const livre = await epi_estoque.disponivel(tx, entrada.id);
  if (quantidade > livre) {
    problemas.push(
      `o lote ${entrada.lote || "—"} tem ${livre} disponível(is) ` +
        `(físico ${await epi_estoque.saldo_fisico(tx, entrada.id)}, ` +
        `${await epi_estoque.reservado(tx, entrada.id)} já prometido(s) a outro ` +
        `pedido) e a reserva pede ${quantidade}: saldo não fica negativo ` +
        "(RN-24)",
    );
  }
  if (problemas.length) throw new RequisicaoBloqueada(problemas);

  await _gravar_linha(tx, linha, { entrada_id: entrada.id, quantidade_reservada: quantidade });
  const resultado = await _mover_item(tx, linha, "RESERVADO", usuario, {
    tipo_evento: EPI_ITEM_RESERVADO,
    detalhe: `${quantidade} × lote ${entrada.lote || "—"} ` + `(CA ${entrada.numero_ca || "—"})`,
  });
  // §4.2: ANALISADA → EM_ATENDIMENTO é automática na PRIMEIRA reserva
  await sincronizar_atendimento(tx, requisicao, usuario);
  return resultado;
}

/** A linha do lote travada até o fim da transação (o `BEGIN IMMEDIATE` do Python). */
async function _travar_lote(tx: Executor, entrada_id: number): Promise<void> {
  await tx.select({ id: epi_entrada_estoque.id }).from(epi_entrada_estoque).where(eq(epi_entrada_estoque.id, entrada_id)).for("update");
}

/**
 * APROVADO → SEM_ESTOQUE: o item é devido e a prateleira não tem. RECUSA
 * quando existe lote elegível com saldo — "sem estoque" com prateleira cheia
 * vira pregão para item que já existe.
 */
export async function marcar_sem_estoque(
  tx: Executor,
  usuario: UsuarioAtual,
  linha: EpiRequisicaoItem,
  opcoes: { complemento?: string; quando?: string | null } = {},
): Promise<EpiRequisicaoItem> {
  usuario.exigir("epi.estoque");
  const requisicao = await _requisicao_da_linha(tx, linha);
  const quando = opcoes.quando || datas_br.hoje();
  const limpo = textos.exigir_texto_limpo((opcoes.complemento || "").trim(), "complemento da falta de estoque");
  const item = await _item(tx, linha.epi_item_id);

  const problemas: string[] = [];
  if (!ATENDIVEL.includes(requisicao.estado)) {
    problemas.push(
      `marcar falta de estoque exige a requisição analisada, e ` +
        `${identificacao(requisicao)} está em ` +
        `${rotulo_req(requisicao.estado).toLowerCase()}`,
    );
  }
  if (linha.estado === "RESERVADO") {
    problemas.push(
      `'${item.nome}' está reservado: desfazer promessa feita é ` +
        "soltar a reserva, que exige o motivo por escrito — e o evento é " +
        "outro, porque 'faltou comprar' e 'prometi e não pude cumprir' são " +
        "fatos diferentes",
    );
  } else if (linha.estado !== "APROVADO") {
    problemas.push(
      `'${item.nome}' está em ` + `${rotulo_item(linha.estado).toLowerCase()} e só ` + "fica sem estoque o que foi aprovado",
    );
  }

  const candidatos =
    linha.estado === "APROVADO"
      ? (await epi_estoque.lotes_de(tx, item, { quando, tamanho: linha.tamanho || null })).filter((lote) => lote.pode_sair)
      : [];
  if (candidatos.length) {
    problemas.push(
      "há lote elegível deste item com saldo — " +
        candidatos.map((lote) => `${lote.rotulo}`).join("; ") +
        ". 'Sem estoque' com prateleira cheia vira pedido de compra para " +
        "item que já existe: reserve o que houver, mesmo que seja menos do " +
        "que o pedido",
    );
  }
  if (problemas.length) throw new RequisicaoBloqueada(problemas);

  const detalhe = "nenhum lote elegível com saldo" + (limpo ? ` — ${limpo}` : "");
  const resultado = await _mover_item(tx, linha, "SEM_ESTOQUE", usuario, {
    tipo_evento: EPI_ITEM_SEM_ESTOQUE,
    comentario: limpo || null,
    detalhe,
  });
  await sincronizar_atendimento(tx, requisicao, usuario);
  return resultado;
}

/** RESERVADO → SEM_ESTOQUE. A promessa se desfaz, e diz por quê. */
export async function soltar_reserva(
  tx: Executor,
  usuario: UsuarioAtual,
  linha: EpiRequisicaoItem,
  motivo: string,
): Promise<EpiRequisicaoItem> {
  usuario.exigir("epi.estoque");
  const limpo = _motivo_obrigatorio(motivo, "motivo para soltar a reserva");
  if (linha.estado !== "RESERVADO") {
    const item = await _item(tx, linha.epi_item_id);
    throw new RequisicaoBloqueada([
      `'${item.nome}' está em ` + `${rotulo_item(linha.estado).toLowerCase()} e não ` + "há reserva a soltar",
    ]);
  }
  return _soltar(tx, usuario, linha, limpo);
}

/**
 * Solta o que o lote prometeu e já não tem lastro. Devolve quantas soltou.
 * `tudo=false` solta só o excedente (descarte, ajuste para menos); `tudo=true`
 * solta todas (lote inativado). Da mais nova para a mais antiga.
 */
export async function soltar_reservas_do_lote(
  tx: Executor,
  usuario: UsuarioAtual,
  entrada: Pick<EpiEntradaEstoque, "id">,
  opcoes: { motivo: string; tudo?: boolean },
): Promise<number> {
  const itens = await tx
    .select()
    .from(epi_requisicao_item)
    .where(and(eq(epi_requisicao_item.entrada_id, entrada.id), eq(epi_requisicao_item.estado, "RESERVADO")))
    .orderBy(desc(epi_requisicao_item.id));
  if (!itens.length) return 0;

  let alvos: EpiRequisicaoItem[];
  if (opcoes.tudo) {
    alvos = itens;
  } else {
    const fisico = await epi_estoque.saldo_fisico(tx, entrada.id);
    let prometido = itens.reduce((s, i) => s + i.quantidade_reservada, 0);
    alvos = [];
    for (const item of itens) {
      if (prometido <= fisico) break;
      alvos.push(item);
      prometido -= item.quantidade_reservada;
    }
  }
  for (const item of alvos) await _soltar(tx, usuario, item, opcoes.motivo);
  return alvos.length;
}

/** A soltura em si: zera a promessa, move e sincroniza o envelope. */
async function _soltar(tx: Executor, usuario: UsuarioAtual, linha: EpiRequisicaoItem, motivo: string): Promise<EpiRequisicaoItem> {
  const resultado = await _mover_item(tx, linha, "SEM_ESTOQUE", usuario, {
    campos: LIBERAR_RESERVA,
    tipo_evento: EPI_ITEM_RESERVA_SOLTA,
    comentario: motivo,
    detalhe: motivo,
  });
  await sincronizar_atendimento(tx, await _requisicao_da_linha(tx, linha), usuario);
  return resultado;
}

/**
 * Devolve à prateleira o que este item tinha prometido. Zera AS DUAS colunas:
 * `entrada_id` é o ponteiro da reserva (o lote da entrega fica na ficha).
 *
 * No Python só mexia no objeto (o `flush` seguinte gravava); aqui grava.
 */
export const LIBERAR_RESERVA: Readonly<Partial<EpiRequisicaoItem>> = Object.freeze({
  quantidade_reservada: 0,
  entrada_id: null,
});

/**
 * (No porte as portas internas passam `LIBERAR_RESERVA` junto da transição,
 * no mesmo UPDATE: zerar o lote com a linha ainda RESERVADO violaria
 * `ck_item_lote`, que o Postgres confere por comando.)
 */
export async function liberar_reserva(tx: Executor, linha: EpiRequisicaoItem): Promise<void> {
  await _gravar_linha(tx, linha, { quantidade_reservada: 0, entrada_id: null });
}

/** Como o lote aparece na mensagem: número, não `id` interno. */
async function _rotulo_do_lote(tx: Executor, entrada_id: number | null): Promise<string> {
  if (!entrada_id) return "—";
  const [entrada] = await tx.select().from(epi_entrada_estoque).where(eq(epi_entrada_estoque.id, entrada_id));
  if (!entrada) return "—";
  return entrada.lote || `sem número (#${entrada.id})`;
}

/**
 * Quem está em `SEM_ESTOQUE` — a fila que a entrada de lote pode atender. É o
 * substituto da reserva automática: mostra a fila e deixa a decisão com gente.
 */
export async function itens_esperando_estoque(
  tx: Executor,
  opcoes: { epi_item_id?: number | null; tamanho?: string | null } = {},
): Promise<EpiRequisicaoItem[]> {
  let linhas = await tx
    .select()
    .from(epi_requisicao_item)
    .where(
      and(
        eq(epi_requisicao_item.estado, "SEM_ESTOQUE"),
        opcoes.epi_item_id !== undefined && opcoes.epi_item_id !== null
          ? eq(epi_requisicao_item.epi_item_id, opcoes.epi_item_id)
          : undefined,
      ),
    )
    .orderBy(asc(epi_requisicao_item.id));
  if (opcoes.tamanho) {
    // linha sem tamanho casa com qualquer lote
    linhas = linhas.filter((i) => !i.tamanho || i.tamanho === opcoes.tamanho);
  }
  return linhas;
}

// =====================================================================
// A entrega — RESERVADO → ENTREGUE é o caminho normal (fatia 5)
// =====================================================================
/**
 * RESERVADO → ENTREGUE (ou APROVADO → ENTREGUE), reaproveitando a fatia 2:
 * nenhuma baixa de estoque nem linha de ficha escrita aqui — é
 * `epi_ficha.registrar_entrega`. A reserva é solta imediatamente ANTES de
 * delegar (senão a RN-24 recusaria a entrega pela própria promessa). A entrega
 * não troca o lote da reserva. A exceção da RN-26 autorizada na aprovação é
 * repassada como `justificativa_excecao`.
 */
export async function entregar_item(
  tx: Executor,
  usuario: UsuarioAtual,
  linha: EpiRequisicaoItem,
  opcoes: { entrada?: EpiEntradaEstoque | null; quantidade?: number | null; data_evento?: string | null; observacao?: string } = {},
): Promise<epi_ficha.EpiFichaRegistro> {
  usuario.exigir("epi.entregar");
  const requisicao = await _requisicao_da_linha(tx, linha);
  const item = await _item(tx, linha.epi_item_id);
  const reservado = linha.estado === "RESERVADO";
  let quantidade = opcoes.quantidade;
  if (quantidade === undefined || quantidade === null) {
    quantidade = reservado ? linha.quantidade_reservada : quantidade_devida(linha);
  }
  let entrada = opcoes.entrada ?? null;
  if (reservado && entrada === null && linha.entrada_id !== null) {
    // o lote da reserva é o padrão: quem reservou já escolheu
    const [e] = await tx.select().from(epi_entrada_estoque).where(eq(epi_entrada_estoque.id, linha.entrada_id));
    entrada = e ?? null;
  }

  const problemas: string[] = [];
  if (!ATENDIVEL.includes(requisicao.estado)) {
    problemas.push(
      `entregar exige a requisição analisada, e ` +
        `${identificacao(requisicao)} está em ` +
        `${rotulo_req(requisicao.estado).toLowerCase()}`,
    );
  }
  if (!["APROVADO", "RESERVADO"].includes(linha.estado)) {
    problemas.push(
      `'${item.nome}' está em ` +
        `${rotulo_item(linha.estado).toLowerCase()} e só se ` +
        "entrega o que foi aprovado ou reservado",
    );
  }
  if (quantidade <= 0) {
    problemas.push("a quantidade a entregar tem de ser maior que zero");
  } else if (quantidade > quantidade_devida(linha)) {
    problemas.push(
      `foram aprovados ${linha.quantidade_aprovada} de ` +
        `'${item.nome}', ${linha.quantidade_entregue} já saíram e a ` +
        `entrega pede ${quantidade}`,
    );
  }
  if (reservado) {
    if (entrada === null || entrada.id !== linha.entrada_id) {
      problemas.push(
        `'${item.nome}' está reservado no lote ` +
          `${await _rotulo_do_lote(tx, linha.entrada_id)}, e a entrega tem de sair ` +
          "dele: trocar de lote no balcão deixaria a reserva de pé sobre um " +
          "saldo que ninguém mais vai buscar. Solte a reserva com motivo e " +
          "reserve no lote certo",
      );
    } else if (quantidade > linha.quantidade_reservada) {
      problemas.push(
        `a reserva é de ${linha.quantidade_reservada} × ` +
          `'${item.nome}' e a entrega pede ${quantidade}: o que passa ` +
          "da reserva não está prometido a este pedido. Reserve o restante " +
          "antes, se o lote tiver saldo",
      );
    } else {
      // RN-24 com a folga REAL deste item: o disponível já desconta a própria reserva
      const folga = (await epi_estoque.disponivel(tx, entrada.id)) + linha.quantidade_reservada;
      if (quantidade > folga) {
        problemas.push(
          `o lote ${entrada.lote || "—"} tem ${folga} para este pedido ` +
            `e a entrega pede ${quantidade}: saldo não fica negativo ` +
            "(RN-24)",
        );
      }
    }
  }
  if (problemas.length) throw new RequisicaoBloqueada(problemas);

  if (reservado) {
    // solta ANTES de delegar, para que `epi_ficha.validar` enxergue a folga
    await _gravar_linha(tx, linha, { quantidade_reservada: linha.quantidade_reservada - quantidade });
  }

  const [servidor] = await tx.select().from(tabela_servidor).where(eq(tabela_servidor.id, requisicao.servidor_id));
  const registro = await epi_ficha.registrar_entrega(tx, usuario, {
    servidor: servidor!,
    item,
    quantidade,
    entrada,
    tamanho: linha.tamanho || "",
    data_evento: opcoes.data_evento ?? null,
    observacao: opcoes.observacao ?? "",
    // a exceção já foi autorizada, por escrito e com nome, na aprovação
    justificativa_excecao: linha.excedeu_maximo ? linha.justificativa || "" : "",
    requisicao_item_id: linha.id,
  });

  const campos: Partial<EpiRequisicaoItem> = { quantidade_entregue: linha.quantidade_entregue + quantidade };
  if (entrada !== null) campos.entrada_id = entrada.id;
  await _gravar_linha(tx, linha, campos);
  // a entrega parcial não fecha o item
  if (quantidade_devida(linha) === 0) {
    await _mover_item(tx, linha, "ENTREGUE", usuario, {
      tipo_evento: EPI_ITEM_ENTREGUE,
      detalhe: `${linha.quantidade_entregue} × ${item.nome} · ` + `ficha ${registro.id}`,
    });
  } else if (linha.estado === "RESERVADO" && linha.quantidade_reservada === 0) {
    // a reserva era menor que o devido e foi consumida inteira: RESERVADO com
    // zero reservado seria estado que não corresponde a fato nenhum
    await _soltar(
      tx,
      usuario,
      linha,
      `a reserva de ${quantidade} × '${item.nome}' foi entregue ` +
        `inteira e o pedido ainda deve ${quantidade_devida(linha)}: reserve ` +
        "de novo quando houver lote",
    );
  }
  await sincronizar_atendimento(tx, requisicao, usuario);
  return registro;
}

/**
 * ANALISADA → EM_ATENDIMENTO → ATENDIDA, sem ninguém clicar. `EM_ATENDIMENTO`
 * chega na primeira RESERVA (ou entrega); `ATENDIDA` quando todo item aprovado
 * está ENTREGUE ou CANCELADO.
 */
export async function sincronizar_atendimento(
  tx: Executor,
  requisicao: EpiRequisicao,
  usuario: UsuarioAtual | null,
): Promise<void> {
  // relê o estado: quem chama pode segurar um objeto que outra porta já moveu
  const [atual] = await tx.select().from(epi_requisicao).where(eq(epi_requisicao.id, requisicao.id));
  if (atual) Object.assign(requisicao, atual);
  if (!["ANALISADA", "EM_ATENDIMENTO"].includes(requisicao.estado)) return;
  const itens = await itens_de(tx, requisicao.id);
  const primeiro = itens.find((i) => i.quantidade_entregue > 0 || i.estado === "RESERVADO");
  const comecou = primeiro
    ? primeiro.quantidade_entregue > 0
      ? "primeira entrega registrada"
      : "primeira reserva de lote registrada"
    : "";
  if (requisicao.estado === "ANALISADA" && comecou) {
    await _mover(tx, requisicao, "EM_ATENDIMENTO", usuario, {
      tipo_evento: EPI_REQUISICAO_EM_ATENDIMENTO,
      comentario: comecou,
    });
  }
  if (requisicao.estado !== "EM_ATENDIMENTO") return;
  if (itens.some((i) => EPI_ITEM_PENDENTE_DE_ATENDIMENTO.has(i.estado))) return;
  await _mover(tx, requisicao, "ATENDIDA", usuario, {
    tipo_evento: EPI_REQUISICAO_ATENDIDA,
    comentario: "todo item aprovado foi entregue ou cancelado",
  });
}

// =====================================================================
function _motivo_obrigatorio(motivo: string, campo: string): string {
  const limpo = textos.exigir_texto_limpo((motivo || "").trim(), campo);
  if (!limpo) {
    throw new RequisicaoBloqueada([
      `${campo} é obrigatório: é o único registro que sobra para quem ` +
        "ler o pedido depois e perguntar por que ele terminou assim",
    ]);
  }
  return limpo;
}

/**
 * `{estado: quantas}` — conta o mesmo conjunto que a fila mostra. `usuario`
 * opcional só para o indicador do módulo (agregado sob `indicador.ver`).
 */
export async function resumo_de_estados(tx: Executor, usuario: UsuarioAtual | null = null): Promise<Record<string, number>> {
  const linhas = await tx
    .select({ estado: epi_requisicao.estado, quantas: count(epi_requisicao.id) })
    .from(epi_requisicao)
    .where(usuario ? _no_escopo(usuario) : undefined)
    .groupBy(epi_requisicao.estado);
  const saida: Record<string, number> = {};
  for (const { estado, quantas } of linhas) saida[estado] = Number(quantas);
  return saida;
}

/** Há quantos dias o pedido está parado no estado atual. Calculado, nunca gravado. */
export function prazo_em_analise(requisicao: Pick<EpiRequisicao, "entrou_no_estado_em">, agora: Date | null = null): number {
  const fim = (agora ?? agora_utc()).getTime();
  return Math.floor((fim - new Date(requisicao.entrou_no_estado_em).getTime()) / 86_400_000);
}
