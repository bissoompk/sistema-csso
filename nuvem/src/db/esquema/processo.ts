/**
 * Processo, laudo tecnico, parecer tecnico, exposicao e vigencia do direito.
 * Porte de `app/modelos/processo.py`.
 */

import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  unique,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

import { ESTADOS_PROCESSO } from '../../dominio/estados';
import { PADRAO_LAUDO, PADRAO_NUP, PADRAO_PARECER } from '../../dominio/processo';
import { DataPura, JSONTexto, MomentoUTC, agora_utc, check_regex, lista_sql } from './base';
import {
  agente_nocivo,
  fundamentacao_legal,
  fluxo_etapa,
  percentual_aplicavel,
  tipo_adicional,
  tipo_marco_inicial,
  tipo_movimento,
  tipo_processo,
} from './dominios';
import { campus, portaria_localizacao, posto_trabalho, servidor, unidade_uorg } from './organizacao';
import {
  autoridade_destinataria,
  profissional_habilitado,
  setor_emissor,
  usuario,
} from './seguranca';

export { PADRAO_LAUDO, PADRAO_NUP, PADRAO_PARECER };

export const processo = pgTable(
  'processo',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    nup: varchar('nup', { length: 20 }).notNull().unique(),
    tipo_processo_id: integer('tipo_processo_id')
      .notNull()
      .references(() => tipo_processo.id),
    etapa_id: integer('etapa_id')
      .notNull()
      .references(() => fluxo_etapa.id),
    estado_tecnico: varchar('estado_tecnico', { length: 32 }).notNull().default('RECEBIDO'),
    estado_anterior: varchar('estado_anterior', { length: 32 }),
    servidor_id: integer('servidor_id').references((): AnyPgColumn => servidor.id),
    unidade_uorg_id: integer('unidade_uorg_id').references((): AnyPgColumn => unidade_uorg.id),
    responsavel_id: integer('responsavel_id').references((): AnyPgColumn => usuario.id),
    ano_referencia: integer('ano_referencia'),
    data_solicitacao_sest: DataPura('data_solicitacao_sest'),
    data_autuacao: DataPura('data_autuacao'),
    prazo: DataPura('prazo'),
    data_conclusao: DataPura('data_conclusao'),
    situacao: varchar('situacao', { length: 20 }).notNull().default('EM_ANDAMENTO'),
    nivel_acesso: varchar('nivel_acesso', { length: 12 }).notNull().default('PUBLICO'),
    acompanhamento_especial: boolean('acompanhamento_especial').notNull().default(false),
    pronto_para_emissao: boolean('pronto_para_emissao').notNull().default(false),
    origem_repositorio: boolean('origem_repositorio').notNull().default(false),
    url_permanente: text('url_permanente'),
    observacoes: text('observacoes'),
    nup_dv_dispensado: boolean('nup_dv_dispensado').notNull().default(false),
    versao: integer('versao').notNull().default(1),
    origem_migracao: varchar('origem_migracao', { length: 20 }),
    origem_ref: varchar('origem_ref', { length: 64 }),
    entrou_na_etapa_em: MomentoUTC('entrou_na_etapa_em').notNull().$defaultFn(agora_utc),
    criado_em: MomentoUTC('criado_em').notNull().$defaultFn(agora_utc),
    // `onupdate=agora_utc` do SQLAlchemy: e o ORM quem carimba, nao o banco —
    // UPDATE em SQL cru nao mexe nesta coluna, la como aqui.
    atualizado_em: MomentoUTC('atualizado_em')
      .notNull()
      .$defaultFn(agora_utc)
      .$onUpdateFn(agora_utc),
  },
  (t) => [
    check_regex('ck_nup_fmt', 'nup', PADRAO_NUP),
    check('ck_acesso', sql.raw(`nivel_acesso IN ('PUBLICO','RESTRITO','SIGILOSO')`)),
    check('ck_conclusao', sql.raw(`(situacao = 'CONCLUIDO') = (data_conclusao IS NOT NULL)`)),
    check('ck_estado_tecnico', sql.raw(`estado_tecnico IN (${lista_sql(ESTADOS_PROCESSO)})`)),
    index('ix_processo_estado').on(t.estado_tecnico),
    index('ix_processo_etapa').on(t.etapa_id),
    index('ix_processo_servidor').on(t.servidor_id),
    // indice unico parcial: a mesma linha de origem da migracao nao entra duas vezes
    uniqueIndex('uq_processo_origem')
      .on(t.origem_migracao, t.origem_ref)
      .where(sql.raw(`origem_ref IS NOT NULL`)),
  ],
);

/** SEM coluna data_validade. Nunca crie. (IN 15/2022, art. 10, SS3) */
export const laudo_tecnico = pgTable(
  'laudo_tecnico',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    numero_siape: varchar('numero_siape', { length: 20 }).notNull().unique(),
    ano: integer('ano').notNull(),
    tipo_adicional_id: integer('tipo_adicional_id')
      .notNull()
      .references(() => tipo_adicional.id),
    coletivo: boolean('coletivo').notNull().default(false),
    unidade_uorg_id: integer('unidade_uorg_id')
      .notNull()
      .references((): AnyPgColumn => unidade_uorg.id),
    data_emissao: DataPura('data_emissao'),
    data_avaliacao: DataPura('data_avaliacao'),
    data_ultima_conferencia: DataPura('data_ultima_conferencia'),
    motivo_ultima_conferencia: text('motivo_ultima_conferencia'),
    subscritor_id: integer('subscritor_id').references(
      (): AnyPgColumn => profissional_habilitado.id,
    ),
    processo_id: integer('processo_id').references(() => processo.id),
    numero_documento_sei: varchar('numero_documento_sei', { length: 10 }),
    status: varchar('status', { length: 10 }).notNull().default('VIGENTE'),
    substituido_por_id: integer('substituido_por_id').references(
      (): AnyPgColumn => laudo_tecnico.id,
    ),
    observacoes: text('observacoes'),
    criado_em: MomentoUTC('criado_em').notNull().$defaultFn(agora_utc),
  },
  () => [
    check_regex('ck_laudo_fmt', 'numero_siape', PADRAO_LAUDO),
    // No SQLite era `ano = CAST(substr(numero_siape,15,4) AS integer)`, e o
    // CAST de lixo dava 0 (ano nunca e 0, entao a linha era recusada). No
    // PostgreSQL o mesmo CAST de lixo ABORTA com erro de sintaxe em vez de
    // violar a CHECK — e as CHECKs rodam em ordem alfabetica, entao esta vem
    // antes de `ck_laudo_fmt`. O CASE devolve a recusa ao lugar dela: numero
    // malformado e violacao de constraint, nao erro de conversao.
    check(
      'ck_laudo_ano',
      sql.raw(
        `CASE WHEN substr(numero_siape,15,4) ~ '^[0-9]{4}$' ` +
          `THEN ano = CAST(substr(numero_siape,15,4) AS integer) ELSE false END`,
      ),
    ),
    check('ck_laudo_status', sql.raw(`status IN ('VIGENTE','SUPERADO')`)),
  ],
);

export const laudo_posto = pgTable(
  'laudo_posto',
  {
    laudo_id: integer('laudo_id')
      .notNull()
      .references(() => laudo_tecnico.id, { onDelete: 'cascade' }),
    posto_trabalho_id: integer('posto_trabalho_id')
      .notNull()
      .references((): AnyPgColumn => posto_trabalho.id),
  },
  (t) => [primaryKey({ columns: [t.laudo_id, t.posto_trabalho_id] })],
);

/** RN-03 - sequencia por ano. Nunca MAX(numero)+1. */
export const parecer_sequencia = pgTable('parecer_sequencia', {
  ano: integer('ano').primaryKey(),
  ultimo_numero: integer('ultimo_numero').notNull().default(0),
});

export const parecer_tecnico = pgTable(
  'parecer_tecnico',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    numero: integer('numero').notNull(),
    ano: integer('ano').notNull(),
    data_emissao: DataPura('data_emissao'),
    situacao: varchar('situacao', { length: 15 }).notNull().default('RASCUNHO'),

    processo_id: integer('processo_id').references(() => processo.id),
    servidor_id: integer('servidor_id').references((): AnyPgColumn => servidor.id),
    laudo_id: integer('laudo_id').references(() => laudo_tecnico.id),
    tipo_adicional_id: integer('tipo_adicional_id').references(() => tipo_adicional.id),
    tipo_movimento_id: integer('tipo_movimento_id').references(() => tipo_movimento.id),
    unidade_uorg_id: integer('unidade_uorg_id').references((): AnyPgColumn => unidade_uorg.id),
    // UORG e campo proprio no documento e pode divergir da Unidade
    uorg_id: integer('uorg_id'),
    portaria_id: integer('portaria_id').references((): AnyPgColumn => portaria_localizacao.id),
    destinatario_id: integer('destinatario_id').references(
      (): AnyPgColumn => autoridade_destinataria.id,
    ),
    signatario_id: integer('signatario_id').references(
      (): AnyPgColumn => profissional_habilitado.id,
    ),
    setor_emissor_id: integer('setor_emissor_id').references((): AnyPgColumn => setor_emissor.id),
    campus_id: integer('campus_id').references((): AnyPgColumn => campus.id),
    parecer_anterior_id: integer('parecer_anterior_id').references(
      (): AnyPgColumn => parecer_tecnico.id,
    ),

    cargo_snapshot: varchar('cargo_snapshot', { length: 120 }),
    funcao_snapshot: varchar('funcao_snapshot', { length: 120 }),
    sigla_emissora_snapshot: varchar('sigla_emissora_snapshot', { length: 60 }),
    nome_emissor_snapshot: varchar('nome_emissor_snapshot', { length: 200 }),
    endereco_emissor_snapshot: text('endereco_emissor_snapshot'),
    telefone_emissor_snapshot: varchar('telefone_emissor_snapshot', { length: 60 }),

    tipo_marco_id: integer('tipo_marco_id').references(() => tipo_marco_inicial.id),
    data_marco_inicial: DataPura('data_marco_inicial'),
    justificativa_marco: text('justificativa_marco'),

    texto_recomendacao: text('texto_recomendacao'),
    texto_alteracao: text('texto_alteracao'),
    texto_reavaliacao: text('texto_reavaliacao'),
    texto_rodape: text('texto_rodape'),
    texto_recomendacao_literal: boolean('texto_recomendacao_literal').notNull().default(false),

    modelo_arquivo: varchar('modelo_arquivo', { length: 120 }),
    modelo_sha256: varchar('modelo_sha256', { length: 64 }),
    hash_conteudo: varchar('hash_conteudo', { length: 64 }),
    // RN-15 levada as ultimas consequencias: TODO o conteudo renderizado e
    // congelado na emissao. Sem isto, editar um catalogo (nome de agente, texto
    // de fundamentacao, nome de unidade) reescreveria o parecer ja emitido na
    // proxima reimpressao — o documento mudaria sem ninguem ter assinado nada.
    contexto_congelado: JSONTexto<Record<string, unknown>>('contexto_congelado'),

    horas_semanais_fonte: numeric('horas_semanais_fonte', { precision: 5, scale: 2, mode: 'string' }),
    portaria_designacao_dirigente_id: integer('portaria_designacao_dirigente_id'),
    area_radiologica: varchar('area_radiologica', { length: 16 }),

    arquivo_docx_id: integer('arquivo_docx_id'),
    arquivo_pdf_id: integer('arquivo_pdf_id'),
    numero_documento_sei: varchar('numero_documento_sei', { length: 10 }),
    motivo_anulacao: text('motivo_anulacao'),

    origem_migracao: varchar('origem_migracao', { length: 20 }),
    origem_ref: varchar('origem_ref', { length: 64 }),
    ano_inferido: boolean('ano_inferido').notNull().default(false),
    versao: integer('versao').notNull().default(1),

    criado_por: integer('criado_por').references((): AnyPgColumn => usuario.id),
    criado_em: MomentoUTC('criado_em').notNull().$defaultFn(agora_utc),
    emitido_por: integer('emitido_por').references((): AnyPgColumn => usuario.id),
    emitido_em: MomentoUTC('emitido_em'),
    assinado_em: MomentoUTC('assinado_em'),
  },
  (t) => [
    // nome da migracao `a652091b8419`, que acrescentou a coluna
    foreignKey({ name: 'fk_parecer_uorg', columns: [t.uorg_id], foreignColumns: [unidade_uorg.id] }),
    unique('uq_parecer').on(t.numero, t.ano),
    check(
      'ck_situacao',
      sql.raw(
        `situacao IN ('RESERVADO','RASCUNHO','EM_REVISAO','EMITIDO','ASSINADO','ANULADO')`,
      ),
    ),
    check(
      'ck_data_ano',
      sql.raw(`data_emissao IS NULL OR EXTRACT(YEAR FROM data_emissao) = ano`),
    ),
    check(
      'ck_area',
      sql.raw(
        `area_radiologica IS NULL OR area_radiologica IN ('CONTROLADA','SUPERVISIONADA')`,
      ),
    ),
    check(
      'ck_completo',
      sql.raw(
        `situacao NOT IN ('EMITIDO','ASSINADO') OR (` +
          `servidor_id IS NOT NULL AND laudo_id IS NOT NULL AND data_emissao IS NOT NULL ` +
          `AND signatario_id IS NOT NULL AND destinatario_id IS NOT NULL ` +
          `AND portaria_id IS NOT NULL AND processo_id IS NOT NULL ` +
          `AND tipo_adicional_id IS NOT NULL AND tipo_movimento_id IS NOT NULL ` +
          `AND unidade_uorg_id IS NOT NULL AND texto_recomendacao IS NOT NULL ` +
          `AND tipo_marco_id IS NOT NULL AND data_marco_inicial IS NOT NULL)`,
      ),
    ),
    check('ck_anulado', sql.raw(`situacao <> 'ANULADO' OR motivo_anulacao IS NOT NULL`)),
    index('ix_parecer_ano').on(t.ano),
    index('ix_parecer_processo').on(t.processo_id),
  ],
);

export const parecer_posto = pgTable(
  'parecer_posto',
  {
    parecer_id: integer('parecer_id')
      .notNull()
      .references(() => parecer_tecnico.id, { onDelete: 'cascade' }),
    posto_trabalho_id: integer('posto_trabalho_id')
      .notNull()
      .references((): AnyPgColumn => posto_trabalho.id),
    ordem: smallint('ordem').notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.parecer_id, t.posto_trabalho_id] })],
);

export const exposicao = pgTable(
  'exposicao',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    parecer_id: integer('parecer_id')
      .notNull()
      .references(() => parecer_tecnico.id, { onDelete: 'cascade' }),
    agente_nocivo_id: integer('agente_nocivo_id')
      .notNull()
      .references(() => agente_nocivo.id),
    percentual_id: integer('percentual_id')
      .notNull()
      .references(() => percentual_aplicavel.id),
    fundamentacao_id: integer('fundamentacao_id')
      .notNull()
      .references(() => fundamentacao_legal.id),
    posto_trabalho_id: integer('posto_trabalho_id').references(
      (): AnyPgColumn => posto_trabalho.id,
    ),
    principal: boolean('principal').notNull().default(false),
    tempo_exposicao: varchar('tempo_exposicao', { length: 60 }),
    horas_exposicao_mensais: numeric('horas_exposicao_mensais', {
      precision: 6,
      scale: 2,
      mode: 'string',
    }),
    jornada_mensal_horas: numeric('jornada_mensal_horas', { precision: 6, scale: 2, mode: 'string' }),
    percentual_jornada: numeric('percentual_jornada', { precision: 5, scale: 2, mode: 'string' }),
    classificacao_exposicao: varchar('classificacao_exposicao', { length: 16 }),
    // De onde veio a classificacao: CALCULADA a partir das horas, ou INFORMADA
    // pelo tecnico quando nao ha medicao de jornada. Guardar a origem e o que
    // permite auditar depois se a habitualidade do art. 9o foi medida ou julgada.
    // O default e tambem de BANCO (`server_default` da migracao `b4a719a434de`).
    classificacao_origem: varchar('classificacao_origem', { length: 10 })
      .notNull()
      .default('CALCULADA'),
    excecao_art9_par_unico: boolean('excecao_art9_par_unico').notNull().default(false),
    justificativa_art9: text('justificativa_art9'),
    intensidade: numeric('intensidade', { precision: 12, scale: 4, mode: 'string' }),
    unidade_medida: varchar('unidade_medida', { length: 20 }),
    limite_tolerancia: numeric('limite_tolerancia', { precision: 12, scale: 4, mode: 'string' }),
    metodologia: varchar('metodologia', { length: 120 }),
    data_avaliacao: DataPura('data_avaliacao'),

    // SS7 do desenho de EPI. Tres colunas e NENHUMA FK para tabela de EPI: o
    // desacoplamento e deliberado. O que o modulo de EPI publica e uma consulta
    // de leitura; a DECISAO mora aqui, no parecer, e a prova de quais fichas a
    // sustentaram vai para o `contexto_congelado`. Uma FK faria o esquema do
    // parecer depender do esquema do almoxarifado, e apagar um lote passaria a
    // ter opiniao sobre um documento assinado. Default tambem de banco
    // (`server_default` da migracao da neutralizacao por EPI).
    epi_neutraliza: varchar('epi_neutraliza', { length: 20 }).notNull().default('NAO_AVALIADO'),
    justificativa_epi: text('justificativa_epi'),
    epi_avaliado_em: DataPura('epi_avaliado_em'),
  },
  (t) => [
    unique('uq_exposicao').on(t.parecer_id, t.agente_nocivo_id),
    check(
      'ck_exposicao',
      sql.raw(
        `classificacao_exposicao IS NULL OR classificacao_exposicao IN ` +
          `('EVENTUAL','HABITUAL','PERMANENTE')`,
      ),
    ),
    // `excecao_art9_par_unico = 0` no SQLite; booleano usado como booleano aqui
    check('ck_excecao', sql.raw(`NOT excecao_art9_par_unico OR justificativa_art9 IS NOT NULL`)),
    check('ck_class_origem', sql.raw(`classificacao_origem IN ('CALCULADA','INFORMADA')`)),
    check(
      'ck_exposicao_epi',
      sql.raw(
        `epi_neutraliza IN ('NAO_AVALIADO','NAO_NEUTRALIZA','NEUTRALIZA_PARCIAL','NEUTRALIZA')`,
      ),
    ),
    // Alegar neutralizacao e reduzir ou cessar o direito de alguem. O banco
    // cobra o porque por escrito, pelo mesmo motivo do `ck_excecao`: decisao
    // que corta pagamento e nao explica nao e decisao tecnica.
    check(
      'ck_exposicao_epi_justificada',
      sql.raw(
        `epi_neutraliza IN ('NAO_AVALIADO','NAO_NEUTRALIZA') OR justificativa_epi IS NOT NULL`,
      ),
    ),
    // no maximo UMA exposicao principal por parecer
    uniqueIndex('uq_exposicao_principal').on(t.parecer_id).where(sql.raw(`principal IS TRUE`)),
  ],
);

/** Maquina B - o direito concedido. */
export const adicional_vigencia = pgTable(
  'adicional_vigencia',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    servidor_id: integer('servidor_id')
      .notNull()
      .references((): AnyPgColumn => servidor.id),
    parecer_id: integer('parecer_id')
      .notNull()
      .references(() => parecer_tecnico.id),
    tipo_adicional_id: integer('tipo_adicional_id')
      .notNull()
      .references(() => tipo_adicional.id),
    percentual_id: integer('percentual_id')
      .notNull()
      .references(() => percentual_aplicavel.id),
    estado: varchar('estado', { length: 16 }).notNull().default('PROPOSTO'),
    portaria_concessao: varchar('portaria_concessao', { length: 120 }),
    data_portaria_concessao: DataPura('data_portaria_concessao'),
    data_inicio: DataPura('data_inicio'),
    data_fim: DataPura('data_fim'),
    motivo_suspensao: varchar('motivo_suspensao', { length: 30 }),
    base_legal_suspensao: varchar('base_legal_suspensao', { length: 120 }),
    registro_opcao_anexo_id: integer('registro_opcao_anexo_id'),
  },
  (t) => [
    check(
      'ck_estado',
      sql.raw(
        `estado IN ('PROPOSTO','VIGENTE','SUSPENSO','EM_REAVALIACAO','ALTERADO','CESSADO')`,
      ),
    ),
    check(
      'ck_motivo_susp',
      sql.raw(
        `motivo_suspensao IS NULL OR motivo_suspensao IN ` +
          `('CESSACAO_RISCO','AFASTAMENTO_DO_LOCAL','AFASTAMENTO_LEGAL',` +
          `'DECISAO_ADMINISTRATIVA')`,
      ),
    ),
    // um direito VIGENTE por servidor
    uniqueIndex('uq_adicional_vigente').on(t.servidor_id).where(sql.raw(`estado = 'VIGENTE'`)),
  ],
);
