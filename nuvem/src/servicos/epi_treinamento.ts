/**
 * Fatia E da paridade de EPI com o IntegraSST: `epi_item.exige_treinamento`
 * passa a valer, ligado ao catálogo de treinamentos de Certificados.
 *
 * O catálogo de EPI diz QUAL treinamento o item exige (`epi_item_treinamento`,
 * configurado com `epi.catalogo`); a análise do pedido e a entrega perguntam a
 * este serviço se quem recebe tem certificado EM VIGOR de cada um deles.
 *
 * DECISÕES (registradas aqui porque o catálogo e a entrega dependem delas):
 *
 * - **Vários treinamentos vinculados = todos exigidos.** Um item que exige
 *   NR-35 e NR-33 exige os dois; basta faltar um para a etiqueta aparecer, e a
 *   etiqueta diz QUAL falta (o nome do treinamento é dado do catálogo, não do
 *   certificado).
 * - **`exige_treinamento` é a chave; o vínculo diz qual.** Vincular um
 *   treinamento a um item que não exigia marca `exige_treinamento` (é o que se
 *   quis dizer ao vincular). Desvincular o último NÃO desmarca: o item continua
 *   exigindo, e o catálogo avisa "exige treinamento, mas nenhum está vinculado
 *   — não dá para conferir". Desmarcar `exige_treinamento` na edição mantém os
 *   vínculos guardados, mas eles deixam de ser conferidos (o catálogo diz isso).
 * - **Exige e não tem vínculo (`SEM_VINCULO`)**: a entrega avisa, sem pedir a
 *   confirmação — o sistema não sabe o que conferir, e uma caixa a marcar sobre
 *   algo que ninguém conferiu vira clique automático. Quem resolve é o catálogo.
 * - **Decisão 2: avisa, não bloqueia.** `SEM_TREINAMENTO` exige, na entrega, a
 *   confirmação marcada por quem entrega ("Entrego mesmo sem treinamento em
 *   vigor"); confirmada, ela vira evento próprio na trilha e fica no
 *   `contexto_congelado` da linha da ficha. A recusa continua possível pelo
 *   motivo `SEM_TREINAMENTO` do catálogo de motivos.
 *
 * PRIVACIDADE: a equipe de EPI recebe só "tem ou não tem certificado em vigor".
 * Nada daqui devolve número, data, nota, turma ou chave do certificado — as
 * consultas nem selecionam essas colunas.
 *
 * "Em vigor" na data `quando`: certificado EMITIDO (o anulado nunca valeu),
 * emitido até `quando`, e que não expira (`data_vencimento` nula — validade
 * zero no treinamento) ou vence em `quando` ou depois (`Certificado.vencido_em`
 * é `data_vencimento < quando`). A pessoa é ligada ao certificado pelo
 * participante (`participante.servidor_id`, único) — e também pelo
 * `certificado.servidor_id` denormalizado, que vale para o mesmo fim.
 */
import { and, asc, eq, inArray, isNull, lte, gte, or } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  certificado as tabela_certificado,
  epi_item as tabela_epi_item,
  epi_item_treinamento,
  participante as tabela_participante,
  treinamento as tabela_treinamento,
} from "../db/esquema/index.js";
import { RegraViolada } from "../nucleo/erros.js";
import * as auditoria from "./auditoria.js";
import type { UsuarioAtual } from "./rbac.js";

export const EPI_ITEM_TREINAMENTO_VINCULADO = "EPI_ITEM_TREINAMENTO_VINCULADO";
export const EPI_ITEM_TREINAMENTO_DESVINCULADO = "EPI_ITEM_TREINAMENTO_DESVINCULADO";
export const EPI_SEM_TREINAMENTO_CONFIRMADO = "EPI_SEM_TREINAMENTO_CONFIRMADO";

/** O código do motivo de recusa que cobre o caso (semeado em `sementes.ts`). */
export const MOTIVO_RECUSA_SEM_TREINAMENTO = "SEM_TREINAMENTO";

/** A chave no `contexto_congelado` da linha da ficha (congelada no INSERT). */
export const CHAVE_CONGELADO = "sem_treinamento_confirmado";

export type CodigoSituacao = "SEM_EXIGENCIA" | "EM_VIGOR" | "SEM_TREINAMENTO" | "SEM_VINCULO";

export const ROTULO_SITUACAO: Readonly<Record<CodigoSituacao, string>> = {
  SEM_EXIGENCIA: "não exige treinamento",
  EM_VIGOR: "treinamento em vigor",
  SEM_TREINAMENTO: "sem treinamento em vigor",
  SEM_VINCULO: "exige treinamento, sem vínculo configurado",
};

export interface TreinamentoVinculado {
  id: number;
  codigo: string;
  nome: string;
  validade_meses: number;
}

export interface SituacaoTreinamento {
  codigo: CodigoSituacao;
  rotulo: string;
  /** os treinamentos que o item exige (vazio sem exigência ou sem vínculo) */
  exigidos: TreinamentoVinculado[];
  /** os exigidos SEM certificado em vigor — só o nome do treinamento */
  faltam: TreinamentoVinculado[];
  /** a entrega só sai com a confirmação marcada */
  pede_confirmacao: boolean;
}

function _situacao(codigo: CodigoSituacao, exigidos: TreinamentoVinculado[] = [], faltam: TreinamentoVinculado[] = []): SituacaoTreinamento {
  return { codigo, rotulo: ROTULO_SITUACAO[codigo], exigidos, faltam, pede_confirmacao: codigo === "SEM_TREINAMENTO" };
}

export const SEM_EXIGENCIA: SituacaoTreinamento = Object.freeze(_situacao("SEM_EXIGENCIA")) as SituacaoTreinamento;

// =====================================================================
// O vínculo item × treinamento
// =====================================================================
/** Os treinamentos vinculados a cada item (uma consulta só, para a lista). */
export async function vinculados(tx: Executor, item_ids: readonly number[]): Promise<Map<number, TreinamentoVinculado[]>> {
  const saida = new Map<number, TreinamentoVinculado[]>();
  const ids = [...new Set(item_ids)];
  if (!ids.length) return saida;
  const linhas = await tx
    .select({
      epi_item_id: epi_item_treinamento.epi_item_id,
      id: tabela_treinamento.id,
      codigo: tabela_treinamento.codigo,
      nome: tabela_treinamento.nome,
      validade_meses: tabela_treinamento.validade_meses,
    })
    .from(epi_item_treinamento)
    .innerJoin(tabela_treinamento, eq(tabela_treinamento.id, epi_item_treinamento.treinamento_id))
    .where(inArray(epi_item_treinamento.epi_item_id, ids))
    .orderBy(asc(tabela_treinamento.nome));
  for (const l of linhas) {
    const lista = saida.get(l.epi_item_id) ?? [];
    lista.push({ id: l.id, codigo: l.codigo, nome: l.nome, validade_meses: l.validade_meses });
    saida.set(l.epi_item_id, lista);
  }
  return saida;
}

/** Os treinamentos do catálogo de Certificados que podem ser escolhidos (ativos). */
export async function treinamentos_do_catalogo(tx: Executor): Promise<TreinamentoVinculado[]> {
  return tx
    .select({
      id: tabela_treinamento.id,
      codigo: tabela_treinamento.codigo,
      nome: tabela_treinamento.nome,
      validade_meses: tabela_treinamento.validade_meses,
    })
    .from(tabela_treinamento)
    .where(eq(tabela_treinamento.ativo, true))
    .orderBy(asc(tabela_treinamento.nome));
}

export class VinculoRecusado extends RegraViolada {}

type ItemDoCatalogo = typeof tabela_epi_item.$inferSelect;

function _validade(t: { validade_meses: number }): string {
  return t.validade_meses ? `validade ${t.validade_meses} meses` : "não expira";
}

/**
 * Vincula o treinamento ao item e, se o item ainda não exigia treinamento,
 * passa a exigir (é o que se quis dizer ao vincular). Idempotente: vincular o
 * que já está vinculado é recusado com recado, sem evento.
 */
export async function vincular(
  tx: Executor,
  usuario: UsuarioAtual,
  item: ItemDoCatalogo,
  treinamento_id: number,
): Promise<{ treinamento: TreinamentoVinculado; passou_a_exigir: boolean }> {
  usuario.exigir("epi.catalogo");
  const [treinamento] = await tx
    .select({
      id: tabela_treinamento.id,
      codigo: tabela_treinamento.codigo,
      nome: tabela_treinamento.nome,
      validade_meses: tabela_treinamento.validade_meses,
      ativo: tabela_treinamento.ativo,
    })
    .from(tabela_treinamento)
    .where(eq(tabela_treinamento.id, treinamento_id));
  if (!treinamento) throw new VinculoRecusado("Treinamento não encontrado no catálogo de Certificados.");
  if (!treinamento.ativo) throw new VinculoRecusado(`'${treinamento.nome}' está inativo no catálogo de treinamentos.`);
  const [ja] = await tx
    .select({ epi_item_id: epi_item_treinamento.epi_item_id })
    .from(epi_item_treinamento)
    .where(and(eq(epi_item_treinamento.epi_item_id, item.id), eq(epi_item_treinamento.treinamento_id, treinamento.id)));
  if (ja) throw new VinculoRecusado(`'${treinamento.nome}' já está vinculado a '${item.nome}'.`);

  await tx.insert(epi_item_treinamento).values({ epi_item_id: item.id, treinamento_id: treinamento.id, vinculado_por: usuario.id });
  const passou_a_exigir = !item.exige_treinamento;
  if (passou_a_exigir) {
    await tx.update(tabela_epi_item).set({ exige_treinamento: true }).where(eq(tabela_epi_item.id, item.id));
  }
  await auditoria.registrar(tx, {
    entidade: "epi_item",
    entidade_id: item.id,
    tipo_evento: EPI_ITEM_TREINAMENTO_VINCULADO,
    descricao:
      `${item.nome} passa a exigir o treinamento ${treinamento.codigo} · ${treinamento.nome} (${_validade(treinamento)})` +
      (passou_a_exigir ? " · o item foi marcado como “exige treinamento”" : ""),
    campo: "treinamento",
    valor_novo: { treinamento_id: treinamento.id, exige_treinamento: true },
    usuario,
  });
  const { ativo: _ativo, ...vinculado } = treinamento;
  return { treinamento: vinculado, passou_a_exigir };
}

/** Desfaz o vínculo. O último a sair NÃO desmarca `exige_treinamento` (ver o cabeçalho). */
export async function desvincular(
  tx: Executor,
  usuario: UsuarioAtual,
  item: ItemDoCatalogo,
  treinamento_id: number,
): Promise<{ treinamento: TreinamentoVinculado; restam: number }> {
  usuario.exigir("epi.catalogo");
  const atuais = (await vinculados(tx, [item.id])).get(item.id) ?? [];
  const treinamento = atuais.find((t) => t.id === treinamento_id);
  if (!treinamento) throw new VinculoRecusado("Esse treinamento não está vinculado a este item.");
  await tx
    .delete(epi_item_treinamento)
    .where(and(eq(epi_item_treinamento.epi_item_id, item.id), eq(epi_item_treinamento.treinamento_id, treinamento_id)));
  const restam = atuais.length - 1;
  await auditoria.registrar(tx, {
    entidade: "epi_item",
    entidade_id: item.id,
    tipo_evento: EPI_ITEM_TREINAMENTO_DESVINCULADO,
    descricao:
      `${item.nome} deixa de exigir o treinamento ${treinamento.codigo} · ${treinamento.nome}` +
      (restam === 0 && item.exige_treinamento ? " · nenhum treinamento vinculado: a exigência fica sem conferência" : ""),
    campo: "treinamento",
    valor_anterior: { treinamento_id: treinamento.id },
    usuario,
  });
  return { treinamento, restam };
}

// =====================================================================
// A situação de quem recebe
// =====================================================================
export interface ParConsulta {
  servidor_id: number;
  /** o item já carregado (só `id` e `exige_treinamento` interessam) — poupa uma ida ao banco */
  item: { id: number; exige_treinamento: boolean };
}

export function chave(servidor_id: number, epi_item_id: number): string {
  return `${servidor_id}:${epi_item_id}`;
}

/**
 * Os pares (servidor, treinamento) com certificado em vigor em `quando`. Só
 * as duas colunas: o certificado em si nunca sai daqui.
 */
async function _em_vigor(
  tx: Executor,
  servidor_ids: number[],
  treinamento_ids: number[],
  quando: string,
): Promise<Set<string>> {
  const linhas = await tx
    .select({
      servidor_certificado: tabela_certificado.servidor_id,
      servidor_participante: tabela_participante.servidor_id,
      treinamento_id: tabela_certificado.treinamento_id,
    })
    .from(tabela_certificado)
    .innerJoin(tabela_participante, eq(tabela_participante.id, tabela_certificado.participante_id))
    .where(
      and(
        eq(tabela_certificado.situacao, "EMITIDO"),
        inArray(tabela_certificado.treinamento_id, treinamento_ids),
        or(inArray(tabela_certificado.servidor_id, servidor_ids), inArray(tabela_participante.servidor_id, servidor_ids)),
        lte(tabela_certificado.data_emissao, quando),
        or(isNull(tabela_certificado.data_vencimento), gte(tabela_certificado.data_vencimento, quando)),
      ),
    );
  const saida = new Set<string>();
  for (const l of linhas) {
    if (l.servidor_certificado !== null) saida.add(chave(l.servidor_certificado, l.treinamento_id));
    if (l.servidor_participante !== null) saida.add(chave(l.servidor_participante, l.treinamento_id));
  }
  return saida;
}

/**
 * A situação de cada par, chaveada por `chave(servidor_id, epi_item_id)`.
 * Desenhada para listas: no máximo DUAS idas ao banco, qualquer que seja o
 * tamanho da lista — e nenhuma quando nenhum item exige treinamento.
 */
export async function situacoes_de_treinamento(
  tx: Executor,
  pares: readonly ParConsulta[],
  quando: string,
): Promise<Map<string, SituacaoTreinamento>> {
  const saida = new Map<string, SituacaoTreinamento>();
  const exigentes = pares.filter((p) => p.item.exige_treinamento);
  for (const p of pares) if (!p.item.exige_treinamento) saida.set(chave(p.servidor_id, p.item.id), SEM_EXIGENCIA);
  if (!exigentes.length) return saida;

  const por_item = await vinculados(
    tx,
    exigentes.map((p) => p.item.id),
  );
  const treinamento_ids = [...new Set([...por_item.values()].flat().map((t) => t.id))];
  const servidor_ids = [...new Set(exigentes.filter((p) => por_item.has(p.item.id)).map((p) => p.servidor_id))];
  const em_vigor = treinamento_ids.length && servidor_ids.length ? await _em_vigor(tx, servidor_ids, treinamento_ids, quando) : new Set<string>();

  for (const p of exigentes) {
    const exigidos = por_item.get(p.item.id) ?? [];
    if (!exigidos.length) {
      saida.set(chave(p.servidor_id, p.item.id), _situacao("SEM_VINCULO"));
      continue;
    }
    const faltam = exigidos.filter((t) => !em_vigor.has(chave(p.servidor_id, t.id)));
    saida.set(chave(p.servidor_id, p.item.id), _situacao(faltam.length ? "SEM_TREINAMENTO" : "EM_VIGOR", exigidos, faltam));
  }
  return saida;
}

/**
 * A situação de UM servidor diante de UM item na data `quando`: sem exigência,
 * em vigor, sem treinamento em vigor, ou exige sem vínculo configurado.
 */
export async function situacao_de_treinamento(
  tx: Executor,
  servidor_id: number,
  epi_item_id: number | { id: number; exige_treinamento: boolean },
  quando: string,
): Promise<SituacaoTreinamento> {
  let item: { id: number; exige_treinamento: boolean } | undefined;
  if (typeof epi_item_id === "number") {
    [item] = await tx
      .select({ id: tabela_epi_item.id, exige_treinamento: tabela_epi_item.exige_treinamento })
      .from(tabela_epi_item)
      .where(eq(tabela_epi_item.id, epi_item_id));
  } else {
    item = epi_item_id;
  }
  if (!item) return SEM_EXIGENCIA;
  const mapa = await situacoes_de_treinamento(tx, [{ servidor_id, item }], quando);
  return mapa.get(chave(servidor_id, item.id)) ?? SEM_EXIGENCIA;
}

/** Os nomes dos treinamentos que faltam, para recado e trilha. */
export function nomes(lista: readonly TreinamentoVinculado[]): string {
  return lista.map((t) => t.nome).join(", ");
}
