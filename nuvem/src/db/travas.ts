/**
 * As listas de colunas da trava da ficha de EPI — porte de `app/banco.py`.
 *
 * A trava em si mora em `travas.sql` (PL/pgSQL), escrita por extenso. Estas
 * listas existem para que um TESTE confira as tres coisas contra si mesmas:
 * congeladas + completaveis = todas as colunas de `epi_ficha_registro`, e cada
 * uma delas aparece na funcao de `travas.sql`. E a mesma protecao contra deriva
 * que o Python tinha: acrescentar uma coluna a ficha sem decidir se ela congela
 * ou completa quebra o teste, em vez de abrir um buraco calado na prova.
 *
 * No Python a lista era literal (e nao lida do modelo) porque o DDL da trigger
 * ia para dentro de uma migracao, e migracao le o passado. Aqui o motivo e o
 * mesmo com outra roupa: `travas.sql` e aplicado a banco que ja existe, e gerar
 * a clausula a partir do esquema faria uma coluna nova reescrever, em silencio,
 * o que a trava de hoje garante.
 */

/** As colunas de `epi_ficha_registro` que NUNCA mudam depois de gravadas. */
export const FICHA_CONGELADA = [
  'id',
  'servidor_id',
  'epi_item_id',
  'requisicao_item_id',
  'entrada_id',
  'tipo',
  'quantidade',
  'data_evento',
  'nome_epi_snapshot',
  'categoria_snapshot',
  'numero_ca_snapshot',
  'validade_ca_snapshot',
  'fabricante_snapshot',
  'lote_snapshot',
  'tamanho_snapshot',
  'nome_servidor_snapshot',
  'siape_snapshot',
  'cargo_snapshot',
  'unidade_snapshot',
  'posto_snapshot',
  'contexto_congelado',
  'previsao_troca',
  'entregue_por',
  'motivo',
  'registro_estornado_id',
  'registrado_em',
] as const;

/**
 * As tres que a linha ainda espera quando nasce. Cada uma se preenche UMA vez:
 * de nulo para valor, e nunca mais.
 *
 * 1. `evento_id` — o evento da cadeia de hash que a registrou; o evento precisa
 *    do `id` da linha, que so existe depois do INSERT.
 * 2. `comprovante_anexo_id` — o PDF assinado em papel e digitalizado depois
 *    (decisao 8): entre a entrega e o anexo ha uma janela real.
 * 3. `recebimento_confirmado_em` — quando a instituicao passou a ter a prova.
 */
export const FICHA_COMPLETAVEL = [
  'evento_id',
  'comprovante_anexo_id',
  'recebimento_confirmado_em',
] as const;

/** As tabelas append-only (RN-31 / CA-16) — sem UPDATE, DELETE nem TRUNCATE. */
export const TABELAS_APPEND_ONLY = [
  'historico_evento',
  'epi_ficha_registro',
  'epi_movimento_estoque',
  'demanda_encaminhamento',
] as const;

/**
 * O nome de cada trigger, na ordem em que `travas.sql` as cria. Os nomes vem
 * do Python (`TRIGGERS` de `app/banco.py`), e as de TRUNCATE sao novas — ver o
 * cabecalho de `travas.sql`.
 */
export const TRIGGERS = [
  'trg_historico_sem_update',
  'trg_historico_sem_delete',
  'trg_historico_sem_truncate',
  'trg_parecer_signatario_habilitado_ins',
  'trg_parecer_signatario_habilitado_upd',
  'trg_laudo_subscritor_habilitado_ins',
  'trg_laudo_subscritor_habilitado_upd',
  'trg_epi_ficha_sem_update',
  'trg_epi_ficha_sem_delete',
  'trg_epi_ficha_sem_truncate',
  'trg_epi_movimento_sem_update',
  'trg_epi_movimento_sem_delete',
  'trg_epi_movimento_sem_truncate',
  'trg_demanda_encaminhamento_sem_update',
  'trg_demanda_encaminhamento_sem_delete',
  'trg_demanda_encaminhamento_sem_truncate',
] as const;
