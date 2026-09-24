/**
 * Anexos, checklist, historico append-only e tabelas de staging da migracao.
 * Porte de `app/modelos/auditoria.py`.
 */

import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

import { CATEGORIAS_ANEXO } from '../../dominio/auditoria';
import { DataPura, Inet, JSONTexto, MomentoUTC, agora_utc, lista_sql } from './base';
import { laudo_tecnico, parecer_tecnico, processo } from './processo';
import { usuario } from './seguranca';

export { CATEGORIAS_ANEXO };

export const anexo = pgTable(
  'anexo',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    entidade: varchar('entidade', { length: 30 }).notNull(),
    entidade_id: integer('entidade_id').notNull(),
    nome_arquivo: varchar('nome_arquivo', { length: 255 }).notNull(),
    nome_original: varchar('nome_original', { length: 255 }).notNull(),
    mime_type: varchar('mime_type', { length: 100 }).notNull(),
    tamanho_bytes: bigint('tamanho_bytes', { mode: 'number' }).notNull(),
    sha256: varchar('sha256', { length: 64 }).notNull(),
    storage_key: text('storage_key').notNull(),
    categoria: varchar('categoria', { length: 30 }).notNull().default('OUTRO'),
    nivel_acesso: varchar('nivel_acesso', { length: 12 }).notNull().default('PUBLICO'),
    numero_documento_sei: varchar('numero_documento_sei', { length: 10 }),
    assinado: boolean('assinado').notNull().default(false),
    versao: integer('versao').notNull().default(1),
    ativo: boolean('ativo').notNull().default(true),
    origem_migracao: varchar('origem_migracao', { length: 20 }),
    origem_ref: varchar('origem_ref', { length: 200 }),
    enviado_por: integer('enviado_por').references((): AnyPgColumn => usuario.id),
    enviado_em: MomentoUTC('enviado_em').notNull().$defaultFn(agora_utc),
  },
  (t) => [
    // As oito primeiras sao do Processos SEI; as oito seguintes entraram de uma
    // vez para EPI, Certificados e Acidentes. A lista mora em
    // `src/dominio/auditoria.ts` (`CATEGORIAS_ANEXO`, a mesma de
    // `anexos.CATEGORIAS` no Python) e a CHECK sai dela.
    check('ck_anexo_cat', sql.raw(`categoria IN (${lista_sql(CATEGORIAS_ANEXO)})`)),
    uniqueIndex('uq_anexo_dedup').on(t.entidade, t.entidade_id, t.sha256),
    index('ix_anexo_sha').on(t.sha256),
    // RN-12 - no maximo um PARECER_ASSINADO ativo por parecer
    uniqueIndex('uq_parecer_assinado_ativo')
      .on(t.entidade_id)
      .where(
        sql.raw(
          `entidade = 'parecer_tecnico' AND categoria = 'PARECER_ASSINADO' AND ativo IS TRUE`,
        ),
      ),
  ],
);

export const checklist = pgTable('checklist', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  processo_id: integer('processo_id')
    .notNull()
    .references((): AnyPgColumn => processo.id, { onDelete: 'cascade' }),
  nome: varchar('nome', { length: 120 }).notNull(),
  ordem: smallint('ordem').notNull().default(1),
});

export const checklist_item = pgTable('checklist_item', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  checklist_id: integer('checklist_id')
    .notNull()
    .references(() => checklist.id, { onDelete: 'cascade' }),
  descricao: varchar('descricao', { length: 255 }).notNull(),
  concluido: boolean('concluido').notNull().default(false),
  concluido_em: MomentoUTC('concluido_em'),
  concluido_por: integer('concluido_por').references((): AnyPgColumn => usuario.id),
  ordem: smallint('ordem').notNull().default(1),
});

/**
 * Tarefa com dono e prazo. Alimenta o sino e a RN-06.
 *
 * Diferente do checklist (que e uma lista livre do processo), a pendencia nasce
 * de uma regra: agente quimico exige avaliacao quantitativa, laudo superado
 * exige reavaliacao, parecer emitido exige inclusao no SEI.
 */
export const pendencia = pgTable(
  'pendencia',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    tipo: varchar('tipo', { length: 40 }).notNull(),
    descricao: text('descricao').notNull(),
    processo_id: integer('processo_id').references((): AnyPgColumn => processo.id),
    parecer_id: integer('parecer_id').references((): AnyPgColumn => parecer_tecnico.id),
    laudo_id: integer('laudo_id').references((): AnyPgColumn => laudo_tecnico.id),
    // Ancora generica, o mesmo par de `historico_evento` e `anexo`. As tres FKs
    // acima sao do Processos SEI; CA a vencer, reciclagem de treinamento e prazo
    // do art. 214 nao tem nenhuma delas, e sem ancora a tela mostra a descricao
    // e nao leva a lugar nenhum.
    entidade: varchar('entidade', { length: 30 }),
    entidade_id: integer('entidade_id'),
    responsavel_id: integer('responsavel_id').references((): AnyPgColumn => usuario.id),
    prazo: DataPura('prazo'),
    concluida: boolean('concluida').notNull().default(false),
    concluida_em: MomentoUTC('concluida_em'),
    concluida_por: integer('concluida_por').references((): AnyPgColumn => usuario.id),
    criada_em: MomentoUTC('criada_em').notNull().$defaultFn(agora_utc),
    // chave de deduplicacao: a mesma regra nao abre duas pendencias iguais
    chave: varchar('chave', { length: 120 }).notNull(),
  },
  (t) => [
    // meia ancora nao leva a lugar nenhum: ou o par esta completo, ou e nulo
    check(
      'ck_pendencia_entidade',
      sql.raw(
        `(entidade IS NULL AND entidade_id IS NULL) ` +
          `OR (entidade IS NOT NULL AND entidade_id IS NOT NULL)`,
      ),
    ),
    uniqueIndex('uq_pendencia_chave').on(t.chave),
    index('ix_pendencia_aberta').on(t.concluida, t.prazo),
    index('ix_pendencia_entidade').on(t.entidade, t.entidade_id),
  ],
);

/**
 * Append-only: trigger de banco aborta UPDATE, DELETE e TRUNCATE (CA-16) — ver
 * `src/db/travas.sql`.
 *
 * `id` e bigint (o `BigInteger().with_variant(Integer, "sqlite")` do Python: no
 * SQLite so o INTEGER vira rowid autoincrementado). `mode: 'number'` porque o
 * id entra no digest e em URL; 2^53 eventos nao e horizonte deste sistema.
 */
export const historico_evento = pgTable(
  'historico_evento',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
    entidade: varchar('entidade', { length: 30 }).notNull(),
    entidade_id: integer('entidade_id').notNull(),
    processo_id: integer('processo_id').references((): AnyPgColumn => processo.id),
    tipo_evento: varchar('tipo_evento', { length: 40 }).notNull(),
    descricao: text('descricao').notNull(),
    comentario: text('comentario'),
    campo: varchar('campo', { length: 60 }),
    valor_anterior: JSONTexto('valor_anterior'),
    valor_novo: JSONTexto('valor_novo'),
    usuario_id: integer('usuario_id').references((): AnyPgColumn => usuario.id),
    usuario_nome: varchar('usuario_nome', { length: 160 }).notNull(),
    ocorrido_em: MomentoUTC('ocorrido_em').notNull().$defaultFn(agora_utc),
    registrado_em: MomentoUTC('registrado_em').notNull().$defaultFn(agora_utc),
    origem: varchar('origem', { length: 20 }).notNull().default('SISTEMA'),
    origem_ref: varchar('origem_ref', { length: 64 }),
    ip: Inet('ip'),
    user_agent: text('user_agent'),
    // encadeamento anti-adulteracao
    hash_anterior: varchar('hash_anterior', { length: 64 }),
    hash_atual: varchar('hash_atual', { length: 64 }),
  },
  (t) => [
    index('ix_hist_entidade').on(t.entidade, t.entidade_id),
    index('ix_hist_processo').on(t.processo_id),
    index('ix_hist_ocorrido').on(t.ocorrido_em),
  ],
);

/**
 * O resultado guardado de uma conferencia da cadeia INTEIRA (Q-2).
 *
 * A conferencia completa refaz um SHA-256 por evento; a tela passou a conferir
 * so a janela exibida, e o passe completo virou ato deliberado (botao ou rotina
 * agendada). Como ele deixou de rodar a cada abertura, alguem tem de guardar
 * QUANDO rodou pela ultima vez e o que deu; e esta tabela.
 *
 * **Sem FK para `historico_evento`.** `ultimo_evento_id` e `primeiro_defeito_id`
 * apontam para a trilha por numero, e nao por chave estrangeira: a linha aqui e
 * o LAUDO sobre aquela tabela, e laudo que o banco recusa gravar porque o objeto
 * do laudo mudou nao serve de laudo. No dia em que o alvo sumisse, e justamente
 * esta linha que precisa sobreviver para dizer que sumiu.
 */
export const conferencia_cadeia = pgTable(
  'conferencia_cadeia',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    iniciada_em: MomentoUTC('iniciada_em').notNull().$defaultFn(agora_utc),
    concluida_em: MomentoUTC('concluida_em').notNull(),
    // o numero que diz quando a conferencia completa deixa de caber num clique
    duracao_ms: integer('duracao_ms').notNull(),
    eventos: integer('eventos').notNull(),
    ultimo_evento_id: bigint('ultimo_evento_id', { mode: 'number' }),
    integra: boolean('integra').notNull(),
    primeiro_defeito_id: bigint('primeiro_defeito_id', { mode: 'number' }),
    origem: varchar('origem', { length: 10 }).notNull(),
    usuario_id: integer('usuario_id').references((): AnyPgColumn => usuario.id),
  },
  () => [
    check('ck_conferencia_origem', sql.raw(`origem IN ('BOTAO','ROTINA')`)),
    // cadeia rompida sem apontar onde e diagnostico sem endereco; e cadeia
    // integra com defeito apontado e contradicao gravada. (`integra = 1` no
    // SQLite; booleano usado como booleano aqui.)
    check(
      'ck_conferencia_defeito',
      sql.raw(
        `(integra AND primeiro_defeito_id IS NULL) ` +
          `OR (NOT integra AND primeiro_defeito_id IS NOT NULL)`,
      ),
    ),
  ],
);

export const migracao_rejeitada = pgTable(
  'migracao_rejeitada',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    origem: varchar('origem', { length: 20 }).notNull(),
    ref: varchar('ref', { length: 200 }).notNull(),
    motivo: text('motivo').notNull(),
    payload: JSONTexto('payload').notNull(),
    expurgar_apos: DataPura('expurgar_apos'),
    criado_em: MomentoUTC('criado_em').notNull().$defaultFn(agora_utc),
  },
  (t) => [index('ix_rejeitada_origem').on(t.origem, t.ref)],
);

/** As 25 colunas da planilha como texto puro + linha de origem. */
export const stg_planilha_parecer = pgTable(
  'stg_planilha_parecer',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    arquivo: varchar('arquivo', { length: 255 }).notNull(),
    linha_origem: integer('linha_origem').notNull(),
    col_a_data_solicitacao: text('col_a_data_solicitacao'),
    col_b_numero_parecer: text('col_b_numero_parecer'),
    col_c_nome_servidor: text('col_c_nome_servidor'),
    col_d_ano: text('col_d_ano'),
    col_e_data: text('col_e_data'),
    col_f_laudo_de: text('col_f_laudo_de'),
    col_g_unidade: text('col_g_unidade'),
    col_h_posto_trabalho: text('col_h_posto_trabalho'),
    col_i_uorg: text('col_i_uorg'),
    col_j_tipo_laudo: text('col_j_tipo_laudo'),
    col_k_numero_processo: text('col_k_numero_processo'),
    col_l_matricula: text('col_l_matricula'),
    col_m_cargo: text('col_m_cargo'),
    col_n_funcao: text('col_n_funcao'),
    col_o_laudo_siape: text('col_o_laudo_siape'),
    col_p_agente_nocivo: text('col_p_agente_nocivo'),
    col_q_tipo_risco: text('col_q_tipo_risco'),
    col_r_percentual: text('col_r_percentual'),
    col_s_portaria: text('col_s_portaria'),
    col_t_fundamentacao: text('col_t_fundamentacao'),
    col_u_alteracao: text('col_u_alteracao'),
    col_v_recomendacao: text('col_v_recomendacao'),
    col_w_reavaliacao: text('col_w_reavaliacao'),
    col_x_pro_reitor: text('col_x_pro_reitor'),
    // O "Y" maiusculo e do Python e fica: o Drizzle poe aspas em todo
    // identificador, entao a coluna se chama literalmente "col_Y_sem_cabecalho"
    // no PostgreSQL. SQL escrito a mao precisa das aspas para acha-la.
    col_Y_sem_cabecalho: text('col_Y_sem_cabecalho'),
    classificacao: varchar('classificacao', { length: 12 }),
    importado_em: MomentoUTC('importado_em').notNull().$defaultFn(agora_utc),
  },
  (t) => [uniqueIndex('uq_stg_planilha').on(t.arquivo, t.linha_origem)],
);

export const stg_trello_cartao = pgTable('stg_trello_cartao', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  card_id: varchar('card_id', { length: 40 }).notNull().unique(),
  nome: text('nome'),
  descricao: text('descricao'),
  lista: text('lista'),
  payload: JSONTexto('payload').notNull(),
  parecer_candidato: varchar('parecer_candidato', { length: 12 }),
  laudo_candidato: varchar('laudo_candidato', { length: 24 }),
});

export const stg_trello_acao = pgTable('stg_trello_acao', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  action_id: varchar('action_id', { length: 40 }).notNull().unique(),
  card_id: varchar('card_id', { length: 40 }),
  tipo: varchar('tipo', { length: 60 }),
  data: varchar('data', { length: 40 }),
  autor: varchar('autor', { length: 160 }),
  payload: JSONTexto('payload').notNull(),
});
