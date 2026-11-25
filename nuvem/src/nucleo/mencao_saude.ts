/**
 * A caixa "confirmo que a menção é necessária" no EPI (filtro de saúde em dois níveis, 24/11/2026).
 *
 * O EPI tem ~20 campos de texto que falam da pessoa, espalhados por ~15 serviços. Em vez de levar
 * a marcação por parâmetro até cada um, ela vale para o PEDIDO HTTP inteiro: o middleware lê o campo
 * do formulário e roda a requisição dentro deste contexto (`AsyncLocalStorage`).
 *
 * - `textos.exigir_texto_limpo` (contexto EPI-pessoa) consulta `marcada()`: só os termos do grupo de
 *   AVISO passam com ela; o grupo de bloqueio recusa marcada ou não.
 * - Cada termo que passou pela caixa é anotado aqui, e `auditoria.registrar` grava a confirmação na
 *   trilha logo depois do primeiro evento que a operação registrar — mesma entidade, mesma conta,
 *   mesma transação: se a operação desfaz, a confirmação desfaz junto.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export const CAMPO_CONFIRMACAO = "confirmo_mencao_saude";

export interface MencaoConfirmada {
  campo: string;
  termos: string[];
}

interface Estado {
  marcada: boolean;
  pendentes: MencaoConfirmada[];
}

const contexto = new AsyncLocalStorage<Estado>();

/** Roda `f` com a caixa marcada (ou não). Os testes de serviço usam direto. */
export function com_confirmacao<T>(marcada: boolean, f: () => T): T {
  return contexto.run({ marcada, pendentes: [] }, f);
}

/** A caixa foi marcada neste pedido? */
export function marcada(): boolean {
  return contexto.getStore()?.marcada ?? false;
}

/** Um campo passou pela caixa: a trilha registra no próximo evento da operação. */
export function anotar(campo: string, termos: string[]): void {
  const estado = contexto.getStore();
  if (estado && termos.length) estado.pendentes.push({ campo, termos: [...termos] });
}

/** As confirmações ainda não registradas — e esvazia a lista (registra-se uma vez). */
export function retirar(): MencaoConfirmada[] {
  const estado = contexto.getStore();
  if (!estado || !estado.pendentes.length) return [];
  const pendentes = estado.pendentes;
  estado.pendentes = [];
  return pendentes;
}
