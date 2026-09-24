/**
 * Catalogos versionados: tipos, percentuais, fundamentacoes, agentes, textos.
 * Porte de `app/modelos/dominios.py`.
 *
 * Convencao de todo o esquema: nome da tabela, nome da coluna E nome da
 * propriedade TypeScript identicos ao Python, em snake_case. Servicos e
 * templates estao sendo portados mecanicamente, e `processo.numero_sei` tem de
 * continuar sendo `processo.numero_sei` do outro lado.
 *
 * `String(n)` vira `varchar(n)`: o DDL de referencia do projeto sempre foi
 * PostgreSQL, e no SQLite o limite era so decorativo. Aqui ele passa a valer.
 */

import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  integer,
  numeric,
  pgTable,
  smallint,
  text,
  unique,
  varchar,
} from 'drizzle-orm/pg-core';

import { DataPura } from './base';

export const tipo_adicional = pgTable('tipo_adicional', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  codigo: varchar('codigo', { length: 24 }).notNull().unique(),
  nome: varchar('nome', { length: 80 }).notNull(),
  // como entra na frase da recomendacao: 'adicional de insalubridade'
  nome_recomendacao: varchar('nome_recomendacao', { length: 80 }).notNull(),
  base_legal: text('base_legal'),
  ativo: boolean('ativo').notNull().default(true),
});

export const tipo_movimento = pgTable('tipo_movimento', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  codigo: varchar('codigo', { length: 20 }).notNull().unique(),
  nome: varchar('nome', { length: 40 }).notNull(),
  gera_direito: boolean('gera_direito').notNull().default(true),
  ativo: boolean('ativo').notNull().default(true),
});

export const tipo_risco = pgTable('tipo_risco', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  codigo: varchar('codigo', { length: 20 }).notNull().unique(),
  nome: varchar('nome', { length: 60 }).notNull(),
});

export const percentual_aplicavel = pgTable(
  'percentual_aplicavel',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    tipo_adicional_id: integer('tipo_adicional_id')
      .notNull()
      .references(() => tipo_adicional.id),
    grau: varchar('grau', { length: 10 }).notNull(),
    rotulo: varchar('rotulo', { length: 40 }).notNull(),
    valor: numeric('valor', { precision: 5, scale: 2, mode: 'string' }).notNull(),
    base_calculo: varchar('base_calculo', { length: 60 })
      .notNull()
      .default('vencimento do cargo efetivo'),
  },
  (t) => [
    unique('uq_percentual').on(t.tipo_adicional_id, t.grau),
    check('ck_grau', sql.raw(`grau IN ('MINIMO','MEDIO','MAXIMO','UNICO')`)),
  ],
);

export const fundamentacao_legal = pgTable('fundamentacao_legal', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  codigo: varchar('codigo', { length: 30 }).notNull().unique(),
  norma: varchar('norma', { length: 40 }).notNull(),
  anexo: varchar('anexo', { length: 20 }),
  tipo_risco_id: integer('tipo_risco_id').references(() => tipo_risco.id),
  texto: text('texto').notNull(),
  dispositivo_conferido_em: DataPura('dispositivo_conferido_em'),
  vigente: boolean('vigente').notNull().default(true),
});

export const agente_nocivo = pgTable('agente_nocivo', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  descricao: varchar('descricao', { length: 200 }).notNull().unique(),
  tipo_risco_id: integer('tipo_risco_id')
    .notNull()
    .references(() => tipo_risco.id),
  fundamentacao_id: integer('fundamentacao_id').references(() => fundamentacao_legal.id),
  percentual_sugerido_id: integer('percentual_sugerido_id').references(
    () => percentual_aplicavel.id,
  ),
  exige_reavaliacao_quantitativa: boolean('exige_reavaliacao_quantitativa')
    .notNull()
    .default(false),
  // sinonimo -> canonico (de-para que altera semantica: exige aprovacao)
  agente_canonico_id: integer('agente_canonico_id').references((): AnyPgColumn => agente_nocivo.id),
  ativo: boolean('ativo').notNull().default(true),
});

export const texto_padrao = pgTable(
  'texto_padrao',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    categoria: varchar('categoria', { length: 30 }).notNull(),
    codigo: varchar('codigo', { length: 40 }).notNull(),
    template: text('template').notNull(),
    versao: integer('versao').notNull().default(1),
    vigente: boolean('vigente').notNull().default(true),
    // false = paragrafo estatico do .docx; existe so como referencia de catalogo
    renderizado_pelo_modelo: boolean('renderizado_pelo_modelo').notNull().default(true),
    dispositivo_conferido_em: DataPura('dispositivo_conferido_em'),
  },
  (t) => [
    unique('uq_texto').on(t.categoria, t.codigo, t.versao),
    check(
      'ck_cat',
      sql.raw(
        `categoria IN ('ALTERACAO','RECOMENDACAO','REAVALIACAO',` +
          `'RODAPE_RESPONSABILIDADE','ASSUNTO','PREAMBULO','ENCERRAMENTO')`,
      ),
    ),
  ],
);

export const tipo_marco_inicial = pgTable('tipo_marco_inicial', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  codigo: varchar('codigo', { length: 30 }).notNull().unique(),
  rotulo: varchar('rotulo', { length: 80 }).notNull(),
  base_legal: text('base_legal'),
});

export const tipo_processo = pgTable('tipo_processo', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  codigo: varchar('codigo', { length: 30 }).notNull().unique(),
  nome: varchar('nome', { length: 80 }).notNull(),
  cor_hex: varchar('cor_hex', { length: 7 }),
  modulo: varchar('modulo', { length: 32 }).notNull().default('ADICIONAL'),
});

/**
 * Parametros operacionais editaveis em /config (SLA, por exemplo).
 *
 * Fica no banco, nao em variavel de ambiente: ambiente e infraestrutura (porta,
 * URL, chave); isto e regra de trabalho do setor, que o coordenador muda
 * sozinho.
 */
export const parametro = pgTable('parametro', {
  chave: varchar('chave', { length: 60 }).primaryKey(),
  valor: text('valor').notNull(),
  descricao: text('descricao'),
});

/** Modelo de checklist aplicavel a um processo (catalogo /checklists-modelo). */
export const checklist_modelo = pgTable('checklist_modelo', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  nome: varchar('nome', { length: 120 }).notNull().unique(),
  tipo_processo_id: integer('tipo_processo_id').references(() => tipo_processo.id),
  estado_alvo: varchar('estado_alvo', { length: 32 }),
  // um item por linha, na ordem (ver `lista_de_itens` em src/dominio/dominios.ts)
  itens: text('itens').notNull(),
  ativo: boolean('ativo').notNull().default(true),
});

export const fluxo_etapa = pgTable(
  'fluxo_etapa',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    codigo: varchar('codigo', { length: 30 }).notNull().unique(),
    nome: varchar('nome', { length: 60 }).notNull(),
    ordem: smallint('ordem').notNull().unique(),
    tipo: varchar('tipo', { length: 12 }).notNull().default('FLUXO'),
    terminal: boolean('terminal').notNull().default(false),
  },
  () => [check('ck_etapa_tipo', sql.raw(`tipo IN ('FLUXO','REPOSITORIO')`))],
);
