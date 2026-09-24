/**
 * Usuarios, perfis, permissoes, atribuicoes, sessoes e habilitacao tecnica.
 * Porte de `app/modelos/seguranca.py`.
 */

import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  unique,
  varchar,
} from 'drizzle-orm/pg-core';

import { DataPura, Inet, MomentoUTC, agora_utc } from './base';
import { campus, servidor } from './organizacao';
import { processo } from './processo';

export const usuario = pgTable(
  'usuario',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    login: varchar('login', { length: 64 }).notNull().unique(),
    nome: varchar('nome', { length: 160 }).notNull(),
    email: varchar('email', { length: 160 }).notNull().unique(),
    senha_hash: varchar('senha_hash', { length: 255 }).notNull(),
    provedor: varchar('provedor', { length: 16 }).notNull().default('LOCAL'),
    identificador_externo: varchar('identificador_externo', { length: 120 }),
    servidor_id: integer('servidor_id').references((): AnyPgColumn => servidor.id),
    precisa_trocar_senha: boolean('precisa_trocar_senha').notNull().default(true),
    ativo: boolean('ativo').notNull().default(true),
    tentativas_falhas: smallint('tentativas_falhas').notNull().default(0),
    bloqueado_ate: MomentoUTC('bloqueado_ate'),
    ultimo_login_em: MomentoUTC('ultimo_login_em'),
    criado_em: MomentoUTC('criado_em').notNull().$defaultFn(agora_utc),
  },
  () => [check('ck_usuario_provedor', sql.raw(`provedor IN ('LOCAL','LDAP','SSO_UFVJM')`))],
);

export const perfil = pgTable('perfil', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  codigo: varchar('codigo', { length: 32 }).notNull().unique(),
  nome: varchar('nome', { length: 80 }).notNull(),
  base_normativa: text('base_normativa'),
  ativo: boolean('ativo').notNull().default(true),
});

export const permissao = pgTable('permissao', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  codigo: varchar('codigo', { length: 64 }).notNull().unique(),
  modulo: varchar('modulo', { length: 32 }).notNull().default('ADICIONAL'),
  descricao: text('descricao').notNull(),
});

export const perfil_permissao = pgTable(
  'perfil_permissao',
  {
    perfil_id: integer('perfil_id')
      .notNull()
      .references(() => perfil.id),
    permissao_id: integer('permissao_id')
      .notNull()
      .references(() => permissao.id),
  },
  (t) => [primaryKey({ columns: [t.perfil_id, t.permissao_id] })],
);

export const atribuicao = pgTable('atribuicao', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  usuario_id: integer('usuario_id')
    .notNull()
    .references(() => usuario.id),
  perfil_id: integer('perfil_id')
    .notNull()
    .references(() => perfil.id),
  coordenadoria: varchar('coordenadoria', { length: 16 }).notNull().default('CSSO'),
  campus_id: integer('campus_id').references((): AnyPgColumn => campus.id),
  vigencia_inicio: DataPura('vigencia_inicio').notNull(),
  vigencia_fim: DataPura('vigencia_fim'),
  ato_normativo: text('ato_normativo'),
  concedido_por: integer('concedido_por').references(() => usuario.id),
});

export const sessao = pgTable('sessao', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  token_hash: varchar('token_hash', { length: 64 }).notNull().unique(),
  usuario_id: integer('usuario_id')
    .notNull()
    .references(() => usuario.id),
  criada_em: MomentoUTC('criada_em').notNull().$defaultFn(agora_utc),
  expira_em: MomentoUTC('expira_em').notNull(),
  ip: Inet('ip'),
  user_agent: text('user_agent'),
  revogada: boolean('revogada').notNull().default(false),
});

/** IN SGP/SEDGG/ME 15/2022, art. 10, SS2, I - quem NAO esta aqui nao assina. */
export const profissional_habilitado = pgTable(
  'profissional_habilitado',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    usuario_id: integer('usuario_id').references(() => usuario.id),
    servidor_id: integer('servidor_id').references((): AnyPgColumn => servidor.id),
    nome: varchar('nome', { length: 160 }).notNull(),
    siape: varchar('siape', { length: 7 }),
    habilitacao: varchar('habilitacao', { length: 30 }).notNull(),
    titulo_assinatura: varchar('titulo_assinatura', { length: 60 }).notNull(),
    conselho: varchar('conselho', { length: 8 }),
    registro_conselho: varchar('registro_conselho', { length: 30 }),
    documento_especializacao: varchar('documento_especializacao', { length: 120 }),
    externo: boolean('externo').notNull().default(false),
    justificativa_art10_par5: text('justificativa_art10_par5'),
    vigencia_inicio: DataPura('vigencia_inicio').notNull(),
    vigencia_fim: DataPura('vigencia_fim'),
    atestado_por: integer('atestado_por').references(() => usuario.id),
    atestado_em: MomentoUTC('atestado_em'),
  },
  () => [
    check(
      'ck_habilitacao',
      sql.raw(`habilitacao IN ('MED_TRABALHO','ENG_SEG_TRABALHO','ARQ_SEG_TRABALHO')`),
    ),
    // `externo = 0` no SQLite, onde booleano e inteiro. No PostgreSQL booleano
    // nao se compara com inteiro — usa-se como booleano, e diz a mesma coisa.
    check('ck_externo', sql.raw(`NOT externo OR justificativa_art10_par5 IS NOT NULL`)),
  ],
);

export const autoridade_destinataria = pgTable('autoridade_destinataria', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  nome: varchar('nome', { length: 160 }).notNull(),
  cargo: varchar('cargo', { length: 120 }).notNull(),
  tratamento: varchar('tratamento', { length: 80 }).notNull(),
  vigencia_inicio: DataPura('vigencia_inicio').notNull(),
  vigencia_fim: DataPura('vigencia_fim'),
});

export const setor_emissor = pgTable(
  'setor_emissor',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    sigla_composta: varchar('sigla_composta', { length: 60 }).notNull(),
    nome_extenso: varchar('nome_extenso', { length: 200 }).notNull(),
    unidade_sei: varchar('unidade_sei', { length: 40 }),
    email: varchar('email', { length: 160 }),
    endereco: text('endereco'),
    // cidade do LOCAL DE EMISSAO, nao do campus avaliado: o parecer 2/2026 e da
    // FAMMUC (Teofilo Otoni) e mesmo assim foi datado em Diamantina, onde o
    // setor emissor funciona.
    cidade: varchar('cidade', { length: 80 }).notNull().default('Diamantina'),
    telefone: varchar('telefone', { length: 60 }),
    vigencia_inicio: DataPura('vigencia_inicio').notNull(),
    vigencia_fim: DataPura('vigencia_fim'),
    base_normativa: text('base_normativa'),
  },
  // a sigla se repete ao longo do tempo: o mesmo SEST/DASA/PROGEP mudou de
  // nome extenso entre 2025 e 2026. A chave e (sigla, inicio de vigencia).
  (t) => [unique('uq_setor_vigencia').on(t.sigla_composta, t.vigencia_inicio)],
);

/** RN-23 - toda leitura de exposicao/parecer nominal/anexo restrito. */
export const acesso_dado_sensivel = pgTable('acesso_dado_sensivel', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  usuario_id: integer('usuario_id')
    .notNull()
    .references(() => usuario.id),
  servidor_id: integer('servidor_id').references((): AnyPgColumn => servidor.id),
  processo_id: integer('processo_id').references((): AnyPgColumn => processo.id),
  campo: varchar('campo', { length: 60 }).notNull(),
  finalidade: text('finalidade'),
  ocorrido_em: MomentoUTC('ocorrido_em').notNull().$defaultFn(agora_utc),
});
