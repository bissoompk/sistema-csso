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
  // 0015 (paridade com o IntegraSST, 22/10/2026): conteúdo, e por isso congeladas
  'motivo_codigo',
  'orientacao_anexo_id',
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
  // 0021 (modulo de acidentes): a CAT/SP versionada, o relatorio emitido, o
  // encaminhamento ao SIASS e a decisao pericial
  'acidente_cat_sp',
  'acidente_relatorio',
  'acidente_encaminhamento',
  'acidente_decisao_pericial',
] as const;

/**
 * As tabelas do modulo de acidentes que NAO se apagam (sem DELETE nem TRUNCATE)
 * mas se atualizam: o tramite da ocorrencia, a resposta da complementacao, o
 * expurgo parcial do nivel 2 de saude, a acao do plano. Guarda permanente
 * (POLITICA_RETENCAO §2.4).
 */
export const TABELAS_SEM_DELETE_ACIDENTE = [
  'acidente_ocorrencia',
  'acidentado',
  'acidente_testemunha',
  'acidente_investigacao',
  'acidente_acao',
  'acidente_entrevista',
  'acidente_complementacao',
  'acidente_saude',
] as const;

/**
 * `acidente_ocorrencia`, as tres familias de coluna (0021). Juntas, sao TODAS as
 * colunas da tabela (um teste confere), e cada uma aparece na funcao de
 * `travas.sql` quando e vigiada:
 *
 * - IDENTIDADE: nunca muda (protocolo, tipo, reabertura, origem, autor);
 * - FATOS: so mudam junto com uma versao NOVA da CAT/SP (`cat_sp_versao` sobe
 *   para uma versao que existe) — a retificacao;
 * - TRAMITE: mudam no dia a dia, sem trava de coluna (o servico confere a
 *   maquina de estados).
 */
export const OCORRENCIA_IDENTIDADE = [
  'id',
  'protocolo',
  'ano',
  'numero',
  'tipo_cat',
  'reabre_id',
  'origem',
  'criado_por',
  'criado_em',
  'token_envio',
] as const;

export const OCORRENCIA_FATOS = [
  'especie',
  'data_evento',
  'hora_evento',
  'minutos_apos_inicio_jornada',
  'ultimo_dia_trabalho',
  'local_tipo',
  'local_especificacao',
  'campus_id',
  'local_unidade_uorg_id',
  'local_municipio',
  'local_uf',
  'local_cnpj_contratada',
  'transito_registro_policial',
  'transito_numero_bo',
  'transito_vitima_terceiros',
  'agente_causador_id',
  'agente_doenca_id',
  'situacao_geradora_id',
  'servidor_id',
  'prazo_comunicacao',
  'restrita_sst',
] as const;

export const OCORRENCIA_TRAMITE = [
  'estado',
  'responsavel_id',
  'prazo_prorrogado_ate',
  'prorrogacao_motivo',
  'prorrogado_por',
  'prorrogado_em',
  'cancelamento_motivo',
  'cancelamento_texto',
  'conclusao_motivo',
  'concluida_em',
  'cat_sp_versao',
  'versao',
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
  // a marca de produção (tabela `instalacao`) não se desfaz pela aplicação
  'trg_instalacao_sem_update',
  'trg_instalacao_sem_delete',
  'trg_instalacao_sem_truncate',
  // 0015: a comunicação do titular se retira ou se trata, e não se apaga
  'trg_epi_comunicacao_sem_delete',
  'trg_epi_comunicacao_sem_truncate',
  // 0016: o codigo curto do treinamento e o numero impresso do certificado
  'trg_treinamento_codigo_curto',
  'trg_certificado_numero_imutavel',
  // 0017: o dono (criado_por) do treinamento e da turma não se troca
  'trg_treinamento_dono_imutavel',
  'trg_turma_dono_imutavel',
  // 0021: modulo de acidentes
  'trg_acidente_cat_sp_sem_update',
  'trg_acidente_cat_sp_sem_delete',
  'trg_acidente_cat_sp_sem_truncate',
  'trg_acidente_relatorio_sem_update',
  'trg_acidente_relatorio_sem_delete',
  'trg_acidente_relatorio_sem_truncate',
  'trg_acidente_encaminhamento_sem_update',
  'trg_acidente_encaminhamento_sem_delete',
  'trg_acidente_encaminhamento_sem_truncate',
  'trg_acidente_decisao_sem_update',
  'trg_acidente_decisao_sem_delete',
  'trg_acidente_decisao_sem_truncate',
  'trg_acidente_ocorrencia_congelada',
  'trg_acidente_ocorrencia_sem_delete',
  'trg_acidente_ocorrencia_sem_truncate',
  'trg_acidentado_sem_delete',
  'trg_acidentado_sem_truncate',
  'trg_acidente_testemunha_sem_delete',
  'trg_acidente_testemunha_sem_truncate',
  'trg_acidente_investigacao_sem_delete',
  'trg_acidente_investigacao_sem_truncate',
  'trg_acidente_acao_sem_delete',
  'trg_acidente_acao_sem_truncate',
  'trg_acidente_entrevista_sem_delete',
  'trg_acidente_entrevista_sem_truncate',
  'trg_acidente_complementacao_sem_delete',
  'trg_acidente_complementacao_sem_truncate',
  'trg_acidente_complementacao_resposta',
  'trg_acidente_saude_expurgo',
  'trg_acidente_identificacao_expurgo',
  'trg_acidente_testemunha_contato_expurgo',
  'trg_acidente_saude_sem_delete',
  'trg_acidente_saude_sem_truncate',
] as const;
