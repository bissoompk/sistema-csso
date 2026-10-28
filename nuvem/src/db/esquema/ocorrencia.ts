/**
 * Ocorrências de urgência e emergência (28/10/2026): o registro geral, de
 * qualquer pessoa na universidade, sem CAT/SP (`dominio/ocorrencia.ts`). Mora
 * à parte de `acidente_*`: o acidente em serviço é do servidor e tem prazo e
 * perícia; a ocorrência é o socorro, de quem for, e só ENCAMINHA ao acidente
 * (`acidente_id`) quando for o caso.
 *
 * Dado pessoal: o nome da pessoa atendida e o relato são sensíveis (podem dizer
 * de saúde). Só a equipe (`ocorrencia.ver`) e quem registrou os leem, e a trilha
 * guarda identificadores, nunca o conteúdo (RN-19).
 */
import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, integer, pgTable, primaryKey, text, uniqueIndex, varchar } from 'drizzle-orm/pg-core';
import { MomentoUTC, agora_utc, check_regex, lista_sql } from './base';
import { campus } from './organizacao';
import { usuario } from './seguranca';
import { acidente_ocorrencia } from './acidente';
import {
  MEIOS_DESLOCAMENTO,
  NIVEIS_ENSINO,
  PADRAO_PROTOCOLO,
  SIM_NAO_NAO_SEI,
  SITUACOES,
  VINCULOS,
} from '../../dominio/ocorrencia';

/** A sequência do protocolo `OCO-AAAA-NNNN`: nunca `MAX+1`, e cancelar não devolve o número. */
export const ocorrencia_sequencia = pgTable(
  'ocorrencia_sequencia',
  {
    ano: integer('ano').notNull(),
    ultimo_numero: integer('ultimo_numero').notNull().default(0),
  },
  (t) => [primaryKey({ name: 'pk_ocorrencia_sequencia', columns: [t.ano] })],
);

export const ocorrencia = pgTable(
  'ocorrencia',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    protocolo: varchar('protocolo', { length: 16 }).notNull(),
    ano: integer('ano').notNull(),
    numero: integer('numero').notNull(),
    situacao: varchar('situacao', { length: 20 }).notNull().default('REGISTRADA'),

    // onde e quando
    data_hora: MomentoUTC('data_hora').notNull(),
    campus_id: integer('campus_id').notNull(),
    local_descricao: varchar('local_descricao', { length: 200 }).notNull(),

    // o que aconteceu: códigos de `TIPOS` separados por vírgula, e o aberto de «Outra»
    tipos: varchar('tipos', { length: 300 }).notNull(),
    tipo_outro: varchar('tipo_outro', { length: 120 }),
    descricao: text('descricao').notNull(),
    observacoes: text('observacoes'),
    durante_atividade: varchar('durante_atividade', { length: 8 }),

    // quem foi atendido (identificação restrita à equipe e a quem registrou)
    pessoa_nome: varchar('pessoa_nome', { length: 160 }),
    pessoa_vinculo: varchar('pessoa_vinculo', { length: 12 }).notNull(),
    pessoa_vinculo_outro: varchar('pessoa_vinculo_outro', { length: 80 }),
    nivel_ensino: varchar('nivel_ensino', { length: 14 }),
    curso: varchar('curso', { length: 120 }),
    setor_lotacao: varchar('setor_lotacao', { length: 120 }),
    acidente_em_servico: varchar('acidente_em_servico', { length: 8 }),
    empresa: varchar('empresa', { length: 120 }),
    funcao: varchar('funcao', { length: 120 }),

    // quem avisou
    registrado_por: integer('registrado_por').notNull(),
    notificante_eh_a_pessoa: boolean('notificante_eh_a_pessoa').notNull(),
    notificante_nome: varchar('notificante_nome', { length: 160 }).notNull(),
    notificante_telefone: varchar('notificante_telefone', { length: 30 }),
    notificante_email: varchar('notificante_email', { length: 254 }),

    // o socorro prestado
    encaminhada_pronto_atendimento: boolean('encaminhada_pronto_atendimento').notNull().default(false),
    meio_deslocamento: varchar('meio_deslocamento', { length: 20 }),
    meio_deslocamento_outro: varchar('meio_deslocamento_outro', { length: 80 }),

    // o trâmite da equipe
    assumida_por: integer('assumida_por'),
    assumida_em: MomentoUTC('assumida_em'),
    concluida_em: MomentoUTC('concluida_em'),
    conclusao: text('conclusao'),
    // a CAT/SP, quando o caso virou acidente em serviço
    acidente_id: integer('acidente_id'),

    criado_em: MomentoUTC('criado_em').notNull().$defaultFn(agora_utc),
    atualizado_em: MomentoUTC('atualizado_em'),
  },
  (t) => [
    foreignKey({ name: 'fk_ocorrencia_campus', columns: [t.campus_id], foreignColumns: [campus.id] }),
    foreignKey({ name: 'fk_ocorrencia_registrado_por', columns: [t.registrado_por], foreignColumns: [usuario.id] }),
    foreignKey({ name: 'fk_ocorrencia_assumida_por', columns: [t.assumida_por], foreignColumns: [usuario.id] }),
    foreignKey({ name: 'fk_ocorrencia_acidente', columns: [t.acidente_id], foreignColumns: [acidente_ocorrencia.id] }),
    uniqueIndex('uq_ocorrencia_protocolo').on(t.protocolo),
    uniqueIndex('uq_ocorrencia_ano_numero').on(t.ano, t.numero),
    check_regex('ck_ocorrencia_protocolo', 'protocolo', PADRAO_PROTOCOLO),
    check('ck_ocorrencia_situacao', sql.raw(`situacao IN (${lista_sql(SITUACOES)})`)),
    check('ck_ocorrencia_vinculo', sql.raw(`pessoa_vinculo IN (${lista_sql(VINCULOS)})`)),
    check('ck_ocorrencia_nivel_ensino', sql.raw(`nivel_ensino IS NULL OR nivel_ensino IN (${lista_sql(NIVEIS_ENSINO)})`)),
    check('ck_ocorrencia_durante_atividade', sql.raw(`durante_atividade IS NULL OR durante_atividade IN (${lista_sql(SIM_NAO_NAO_SEI)})`)),
    check('ck_ocorrencia_em_servico', sql.raw(`acidente_em_servico IS NULL OR acidente_em_servico IN (${lista_sql(SIM_NAO_NAO_SEI)})`)),
    check('ck_ocorrencia_meio', sql.raw(`meio_deslocamento IS NULL OR meio_deslocamento IN (${lista_sql(MEIOS_DESLOCAMENTO)})`)),
    // o meio só existe quando houve encaminhamento
    check('ck_ocorrencia_meio_exige_encaminhamento', sql.raw(`meio_deslocamento IS NULL OR encaminhada_pronto_atendimento`)),
    index('ix_ocorrencia_situacao').on(t.situacao),
    index('ix_ocorrencia_campus').on(t.campus_id),
    index('ix_ocorrencia_registrado_por').on(t.registrado_por),
    index('ix_ocorrencia_data').on(t.data_hora),
  ],
);

/** O que a equipe foi registrando no acompanhamento (só acrescenta). */
export const ocorrencia_acompanhamento = pgTable(
  'ocorrencia_acompanhamento',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    ocorrencia_id: integer('ocorrencia_id').notNull(),
    texto: text('texto').notNull(),
    autor_id: integer('autor_id').notNull(),
    criado_em: MomentoUTC('criado_em').notNull().$defaultFn(agora_utc),
  },
  (t) => [
    foreignKey({ name: 'fk_ocorrencia_acomp_ocorrencia', columns: [t.ocorrencia_id], foreignColumns: [ocorrencia.id] }),
    foreignKey({ name: 'fk_ocorrencia_acomp_autor', columns: [t.autor_id], foreignColumns: [usuario.id] }),
    index('ix_ocorrencia_acomp_ocorrencia').on(t.ocorrencia_id),
  ],
);

export type Ocorrencia = typeof ocorrencia.$inferSelect;
export type OcorrenciaAcompanhamento = typeof ocorrencia_acompanhamento.$inferSelect;
