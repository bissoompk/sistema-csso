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

// =====================================================================
// Paridade com o IntegraSST (22/10/2026) — migração 0015_epi_paridade
// =====================================================================

/**
 * Fatia A — o que o TITULAR comunica sobre o EPI que está com ele. São as
 * cinco situações do legado (`L:EPI_Frontend.html:976-1005`), menos "Em uso",
 * que é a ausência de comunicação. "Extraviado" tem rótulo neutro de
 * propósito (Decisão 5): a comunicação só registra e abre pendência — não há
 * cobrança, nem efeito na ficha, nem no estoque.
 */
export const TIPOS_COMUNICACAO_TITULAR = [
  'EXTRAVIADO',
  'DESGASTE',
  'TEMPO_DE_USO',
  'PERDA_DE_EFICACIA',
  'ALTERACAO_NO_TRABALHO',
] as const;
export type TipoComunicacaoTitular = (typeof TIPOS_COMUNICACAO_TITULAR)[number];

export const ROTULO_COMUNICACAO_TITULAR: Readonly<Record<TipoComunicacaoTitular, string>> = {
  EXTRAVIADO: 'Extraviado (não está mais comigo)',
  DESGASTE: 'Troca por desgaste físico',
  TEMPO_DE_USO: 'Troca por tempo de uso',
  PERDA_DE_EFICACIA: 'Troca por perda de eficácia',
  ALTERACAO_NO_TRABALHO: 'Troca por alterações no trabalho',
};

/** Quanto tempo o titular tem para retirar a própria comunicação (conferido no servidor). */
export const JANELA_RETIRADA_COMUNICACAO_HORAS = 24;

/**
 * Fatia A — o motivo CODIFICADO de uma linha da ficha (devolução, substituição,
 * descarte). A mesma lista da comunicação, mais desligamento e "outro". O texto
 * livre continua em `motivo`; o código serve para contar (indicadores) sem ler
 * texto. Coluna congelada na trava da ficha.
 */
export const MOTIVOS_FICHA = [...TIPOS_COMUNICACAO_TITULAR, 'DESLIGAMENTO', 'OUTRO'] as const;
export type MotivoFicha = (typeof MOTIVOS_FICHA)[number];

export const ROTULO_MOTIVO_FICHA: Readonly<Record<MotivoFicha, string>> = {
  EXTRAVIADO: 'Extraviado',
  DESGASTE: 'Desgaste físico',
  TEMPO_DE_USO: 'Tempo de uso',
  PERDA_DE_EFICACIA: 'Perda de eficácia',
  ALTERACAO_NO_TRABALHO: 'Alterações no trabalho',
  DESLIGAMENTO: 'Desligamento ou mudança de lotação',
  OUTRO: 'Outro',
};

/**
 * Fatia B — o motivo de CADA item do pedido (`L:EPI_Frontend.html:704`). A
 * finalidade do pedido inteiro continua existindo (os indicadores a leem).
 */
export const MOTIVOS_ITEM_REQUISICAO = ['USO_INICIAL', 'DESGASTE', 'DANO', 'PERDA'] as const;
export type MotivoItemRequisicao = (typeof MOTIVOS_ITEM_REQUISICAO)[number];

export const ROTULO_MOTIVO_ITEM: Readonly<Record<MotivoItemRequisicao, string>> = {
  USO_INICIAL: 'Nova função / uso inicial',
  DESGASTE: 'Substituição: desgaste natural',
  DANO: 'Substituição: dano ou quebra',
  PERDA: 'Extravio ou perda',
};

/**
 * O preenchimento dos pedidos antigos (migração 0015), e a sugestão do
 * formulário: o motivo do item a partir da finalidade do pedido.
 */
export const MOTIVO_ITEM_POR_FINALIDADE: Readonly<
  Record<(typeof FINALIDADES_REQUISICAO)[number], MotivoItemRequisicao>
> = {
  PRIMEIRA_ENTREGA: 'USO_INICIAL',
  DANO: 'DANO',
  PERDA: 'PERDA',
  ROTINA: 'DESGASTE',
  SUBSTITUICAO: 'DESGASTE',
};

/**
 * Fatia B — a comunicação do titular vira pedido de troca já preenchido: o
 * motivo do item que corresponde a cada situação comunicada.
 */
export const MOTIVO_ITEM_POR_COMUNICACAO: Readonly<Record<TipoComunicacaoTitular, MotivoItemRequisicao>> = {
  EXTRAVIADO: 'PERDA',
  DESGASTE: 'DESGASTE',
  TEMPO_DE_USO: 'DESGASTE',
  PERDA_DE_EFICACIA: 'DANO',
  ALTERACAO_NO_TRABALHO: 'USO_INICIAL',
};

/** A finalidade do pedido de troca aberto a partir de uma comunicação do titular. */
export const FINALIDADE_POR_COMUNICACAO: Readonly<
  Record<TipoComunicacaoTitular, (typeof FINALIDADES_REQUISICAO)[number]>
> = {
  EXTRAVIADO: 'PERDA',
  DESGASTE: 'SUBSTITUICAO',
  TEMPO_DE_USO: 'SUBSTITUICAO',
  PERDA_DE_EFICACIA: 'SUBSTITUICAO',
  ALTERACAO_NO_TRABALHO: 'SUBSTITUICAO',
};

/**
 * Fatia B — o termo NR-06 declarado por QUEM ENVIA o pedido (Decisão 3). O
 * texto é o do legado (`L:EPI_Frontend.html:727-732`), ajustado para valer
 * também quando a chefia pede pelo servidor. **Texto publicado não muda:**
 * mudança de redação é versão nova, acrescentada aqui, e `TERMO_NR06_VIGENTE`
 * passa a apontar para ela; o pedido grava a versão que aceitou.
 */
export const TERMOS_NR06: Readonly<Record<string, string>> = {
  'NR06-2026-10':
    'Declaro, para os devidos fins legais e de Segurança do Trabalho, que as ' +
    'informações prestadas neste pedido são verdadeiras e que o uso exclusivo, a ' +
    'guarda e a conservação dos Equipamentos de Proteção Individual solicitados ' +
    'seguem as diretrizes da NR-06. O termo de guarda do titular é assinado no ' +
    'comprovante da entrega.',
};
export const TERMO_NR06_VIGENTE = 'NR06-2026-10';
export function texto_termo_nr06(versao: string = TERMO_NR06_VIGENTE): string {
  const texto = TERMOS_NR06[versao];
  if (texto === undefined) throw new Error(`versão de termo NR-06 desconhecida: ${versao}`);
  return texto;
}

/**
 * Fatia C — a foto e o PDF de orientação do catálogo. Os bytes são conferidos
 * (assinatura do arquivo), e não só a extensão.
 */
export const EPI_CATALOGO_IMAGEM_TIPOS = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const EPI_CATALOGO_IMAGEM_MAX_BYTES = 2 * 1024 * 1024;
// abaixo do teto geral de `anexos.LIMITE_BYTES` (4 MB, o corpo da função Netlify)
export const EPI_CATALOGO_PDF_MAX_BYTES = 4 * 1024 * 1024;
/** `anexo.entidade` dos arquivos do catálogo. */
export const ENTIDADE_ANEXO_EPI_ITEM = 'epi_item';
