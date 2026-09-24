/**
 * Vocabularios fechados e `@property` de `app/modelos/epi.py`.
 *
 * O `CHECK` e montado a partir da tupla, e nao escrito a mao ao lado dela: duas
 * listas do mesmo conjunto divergem no dia em que alguem acrescenta valor a uma
 * so, e o formulario passaria a oferecer o que o banco recusa.
 */

import { somar_dias } from './datas';
import { linhas } from './dominios';
import { EPI_ITEM_DECIDIDO, EPI_REQUISICAO_ENCERRADA } from './estados';

export const TIPOS_MOVIMENTO = ['ENTRADA', 'SAIDA', 'DEVOLUCAO', 'DESCARTE', 'AJUSTE'] as const;

export const TIPOS_FICHA = ['ENTREGA', 'DEVOLUCAO', 'SUBSTITUICAO', 'DESCARTE', 'ESTORNO'] as const;

// Sugestao do formulario, e nao restricao de banco: o desenho nao fecha esta
// lista, e fecha-la travaria a compra que vier em rolo ou em galao. Vai como
// `<datalist>` na tela — sugere sem impedir.
export const UNIDADES_MEDIDA = [
  'UNIDADE',
  'PAR',
  'CAIXA',
  'CONJUNTO',
  'METRO',
  'ROLO',
  'LITRO',
] as const;

export const FINALIDADES_REQUISICAO = [
  'PRIMEIRA_ENTREGA',
  'ROTINA',
  'SUBSTITUICAO',
  'DANO',
  'PERDA',
] as const;

export const URGENCIAS_REQUISICAO = ['NORMAL', 'URGENTE'] as const;

export const EpiCategoria = {
  /**
   * `A.1 · Proteção da cabeça` — o item da norma junto do nome. Sem a
   * referencia ao lado, quem confere o cadastro contra o Anexo I precisa saber
   * de cor qual letra e qual.
   */
  rotulo(categoria: { referencia_nr6: string | null; nome: string }): string {
    return categoria.referencia_nr6 ? `${categoria.referencia_nr6} · ${categoria.nome}` : categoria.nome;
  },
};

type ItemCA = { validade_ca: string | null };

export const EpiItem = {
  lista_de_tamanhos(item: { tamanhos: string | null }): string[] {
    return linhas(item.tamanhos);
  },
  lista_de_normas(item: { normas: string | null }): string[] {
    return linhas(item.normas);
  },
  /**
   * Estado, calculado agora — nunca gravado. Vale para o CA de referencia do
   * catalogo; quem decide a entrega e o CA do LOTE (RN-25).
   */
  ca_vencido_em(item: ItemCA, quando: string): boolean {
    return item.validade_ca !== null && item.validade_ca < quando;
  },
  ca_a_vencer_em(item: ItemCA, quando: string, dias = 60): boolean {
    if (item.validade_ca === null || EpiItem.ca_vencido_em(item, quando)) return false;
    return item.validade_ca <= somar_dias(quando, dias);
  },
  /** Como a RN-26 se le na tela: "2 por 12 meses", ou "sem máximo". */
  regra_de_quantidade(item: {
    quantidade_maxima: number | null;
    periodo_maximo_meses: number | null;
  }): string {
    if (item.quantidade_maxima === null) return 'sem máximo';
    return `${item.quantidade_maxima} por ${item.periodo_maximo_meses} meses`;
  },
};

export const EpiRequisicao = {
  encerrada(requisicao: { estado: string }): boolean {
    return EPI_REQUISICAO_ENCERRADA.has(requisicao.estado);
  },
  /** `EPI-2026-0001`, ou `Rascunho #12` enquanto nao houver protocolo. */
  identificacao(requisicao: { protocolo: string | null; id: number }): string {
    return requisicao.protocolo || `Rascunho #${requisicao.id}`;
  },
};

export const EpiRequisicaoItem = {
  /** Quanto ainda falta entregar deste item. Zero quando nada foi aprovado. */
  quantidade_devida(item: { quantidade_aprovada: number | null; quantidade_entregue: number }): number {
    return Math.max(0, (item.quantidade_aprovada ?? 0) - item.quantidade_entregue);
  },
  decidido(item: { estado: string }): boolean {
    return EPI_ITEM_DECIDIDO.has(item.estado);
  },
};
