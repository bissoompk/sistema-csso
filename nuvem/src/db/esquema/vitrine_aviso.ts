/**
 * "Quero ser avisado" da vitrine pública (/cursos): quem pediu, por e-mail, o
 * aviso da próxima turma de um curso, de um setor ou de qualquer curso. Base
 * legal: consentimento (LGPD art. 7º, I). Só nome e e-mail: nenhum telefone.
 *
 * Retenção (`servicos/privacidade.ts`): o cadastro não confirmado sai em 7
 * dias; o confirmado expira em 12 meses; o cancelado sai em 30 dias; o IP do
 * consentimento sai em 90 dias. A equipe só vê CONTAGENS.
 *
 * O link de saída de cada aviso é assinado com a chave do sistema
 * (`aviso_interesse.token_de_saida`), por isso não há coluna de hash dele.
 */
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, pgTable, primaryKey, uniqueIndex, varchar } from 'drizzle-orm/pg-core';
import { email_saida } from './operacao';
import { DataPura, Inet, MomentoUTC, agora_utc } from './base';
import { campus, unidade_uorg } from './organizacao';
import { treinamento, turma } from './treinamento';

export const aviso_interesse = pgTable(
  'aviso_interesse',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    nome: varchar('nome', { length: 120 }).notNull(),
    email: varchar('email', { length: 254 }).notNull(),
    email_normalizado: varchar('email_normalizado', { length: 254 }).notNull(),
    // TREINAMENTO (este curso), SETOR (cursos do setor) ou QUALQUER (qualquer curso)
    tipo: varchar('tipo', { length: 12 }).notNull(),
    treinamento_id: integer('treinamento_id'),
    unidade_id: integer('unidade_id'),
    campus_id: integer('campus_id'),
    consentimento_em: MomentoUTC('consentimento_em').notNull(),
    // a versão do texto de finalidade que a pessoa viu
    consentimento_versao: varchar('consentimento_versao', { length: 16 }).notNull(),
    // apagado em 90 dias (rotina de privacidade)
    ip_consentimento: Inet('ip_consentimento'),
    // SHA-256 do token da confirmação; nulo depois de confirmado
    confirmacao_hash: varchar('confirmacao_hash', { length: 64 }),
    confirmacao_enviada_em: MomentoUTC('confirmacao_enviada_em'),
    confirmado_em: MomentoUTC('confirmado_em'),
    cancelado_em: MomentoUTC('cancelado_em'),
    ultimo_aviso_em: MomentoUTC('ultimo_aviso_em'),
    // confirmado_em + 12 meses; nulo enquanto não confirmado
    expira_em: DataPura('expira_em'),
    criado_em: MomentoUTC('criado_em').notNull().$defaultFn(agora_utc),
  },
  (t) => [
    foreignKey({ name: 'fk_aviso_interesse_treinamento', columns: [t.treinamento_id], foreignColumns: [treinamento.id] }),
    foreignKey({ name: 'fk_aviso_interesse_unidade', columns: [t.unidade_id], foreignColumns: [unidade_uorg.id] }),
    foreignKey({ name: 'fk_aviso_interesse_campus', columns: [t.campus_id], foreignColumns: [campus.id] }),
    check('ck_aviso_interesse_tipo', sql`${t.tipo} IN ('TREINAMENTO','SETOR','QUALQUER')`),
    check('ck_aviso_interesse_treinamento', sql`(${t.tipo} = 'TREINAMENTO') = (${t.treinamento_id} IS NOT NULL)`),
    check('ck_aviso_interesse_unidade', sql`(${t.tipo} = 'SETOR') = (${t.unidade_id} IS NOT NULL)`),
    // um cadastro ativo por e-mail e interesse
    uniqueIndex('uq_aviso_interesse_ativo')
      .on(t.email_normalizado, t.tipo, sql`coalesce(${t.treinamento_id}, 0)`, sql`coalesce(${t.unidade_id}, 0)`)
      .where(sql`${t.cancelado_em} IS NULL`),
    index('ix_aviso_interesse_casamento').on(t.tipo, t.treinamento_id, t.unidade_id),
  ],
);

/** Um aviso por pessoa por turma: a republicação não manda de novo. */
export const aviso_interesse_envio = pgTable(
  'aviso_interesse_envio',
  {
    aviso_id: integer('aviso_id').notNull(),
    turma_id: integer('turma_id').notNull(),
    email_id: integer('email_id'),
  },
  (t) => [
    primaryKey({ name: 'pk_aviso_interesse_envio', columns: [t.aviso_id, t.turma_id] }),
    foreignKey({ name: 'fk_aviso_envio_aviso', columns: [t.aviso_id], foreignColumns: [aviso_interesse.id] }).onDelete('cascade'),
    foreignKey({ name: 'fk_aviso_envio_turma', columns: [t.turma_id], foreignColumns: [turma.id] }),
    foreignKey({ name: 'fk_aviso_envio_email', columns: [t.email_id], foreignColumns: [email_saida.id] }).onDelete('set null'),
  ],
);
