/**
 * Campus, UORG, postos de trabalho, cargos, servidores e portarias.
 * Porte de `app/modelos/organizacao.py`.
 */

import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  varchar,
} from 'drizzle-orm/pg-core';

import { PADRAO_SIAPE } from '../../dominio/organizacao';
import { DataPura, check_regex } from './base';
import { usuario } from './seguranca';

export { PADRAO_SIAPE };

export const campus = pgTable('campus', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  sigla: varchar('sigla', { length: 12 }).notNull().unique(),
  nome: varchar('nome', { length: 120 }).notNull(),
  cidade: varchar('cidade', { length: 80 }).notNull(),
  uf: varchar('uf', { length: 2 }).notNull().default('MG'),
  avancado: boolean('avancado').notNull().default(false),
});

export const unidade_uorg = pgTable(
  'unidade_uorg',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    codigo_uorg: varchar('codigo_uorg', { length: 6 }).unique(),
    sigla: varchar('sigla', { length: 20 }),
    // nome_oficial: caixa alta do SIAPE (coluna I da planilha)
    nome_oficial: varchar('nome_oficial', { length: 160 }).notNull(),
    // nome_extenso: como sai no parecer (coluna G)
    nome_extenso: varchar('nome_extenso', { length: 160 }).notNull(),
    tipo: varchar('tipo', { length: 20 }).notNull(),
    unidade_pai_id: integer('unidade_pai_id').references((): AnyPgColumn => unidade_uorg.id),
    campus_id: integer('campus_id')
      .notNull()
      .references(() => campus.id),
    emite_portaria: boolean('emite_portaria').notNull().default(false),
    ativo: boolean('ativo').notNull().default(true),
  },
  () => [
    check(
      'ck_uorg_tipo',
      sql.raw(
        `tipo IN ('FACULDADE','INSTITUTO','DEPARTAMENTO','PRO_REITORIA','DIRETORIA',` +
          `'COORDENADORIA','SUPERINTENDENCIA','SECRETARIA','OUTRO')`,
      ),
    ),
  ],
);

export const posto_trabalho = pgTable(
  'posto_trabalho',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    unidade_uorg_id: integer('unidade_uorg_id')
      .notNull()
      .references(() => unidade_uorg.id),
    nome: varchar('nome', { length: 180 }).notNull(),
    sigla: varchar('sigla', { length: 20 }),
    descricao: text('descricao'),
    ativo: boolean('ativo').notNull().default(true),
  },
  // 'Laboratorio de Quimica' existe no IECT e no ICA - unico por unidade
  (t) => [unique('uq_posto').on(t.unidade_uorg_id, t.nome)],
);

export const cargo = pgTable('cargo', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  nome: varchar('nome', { length: 120 }).notNull().unique(),
  codigo_siape: varchar('codigo_siape', { length: 10 }),
});

export const servidor = pgTable(
  'servidor',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    siape: varchar('siape', { length: 7 }).notNull().unique(),
    nome: varchar('nome', { length: 160 }).notNull(),
    cargo_id: integer('cargo_id').references(() => cargo.id),
    funcao: varchar('funcao', { length: 120 }),
    unidade_uorg_id: integer('unidade_uorg_id').references(() => unidade_uorg.id),
    uorg_id: integer('uorg_id'),
    situacao: varchar('situacao', { length: 20 }).notNull().default('ATIVO'),
    email: varchar('email', { length: 160 }),
  },
  (t) => [
    // nome da migracao `a652091b8419`, que acrescentou a coluna
    foreignKey({ name: 'fk_servidor_uorg', columns: [t.uorg_id], foreignColumns: [unidade_uorg.id] }),
    check_regex('ck_siape', 'siape', PADRAO_SIAPE),
  ],
);

/**
 * Os postos de um periodo de lotacao.
 *
 * Sao varios de proposito: o mesmo servidor atende, por exemplo, o LEAC e o
 * Laboratorio de Doencas Infecciosas e Parasitarias — foi assim no parecer
 * 1/2025. O parecer ja tratava posto como lista; o cadastro tambem precisa.
 */
export const lotacao_posto = pgTable(
  'lotacao_posto',
  {
    lotacao_id: integer('lotacao_id').notNull(),
    posto_trabalho_id: integer('posto_trabalho_id').notNull(),
    ordem: integer('ordem').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.lotacao_id, t.posto_trabalho_id] }),
    foreignKey({
      name: 'fk_lotacao_posto_lotacao',
      columns: [t.lotacao_id],
      foreignColumns: [servidor_lotacao.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fk_lotacao_posto_posto',
      columns: [t.posto_trabalho_id],
      foreignColumns: [posto_trabalho.id],
    }),
  ],
);

/**
 * Historico datado de lotacao e cargo do servidor.
 *
 * Por que existe: o servidor muda de unidade, de posto e de cargo, e o
 * adicional depende de ONDE e EM QUE FUNCAO ele estava em cada periodo.
 * Sobrescrever o cadastro apagaria a prova da exposicao passada — que e
 * exatamente o que a aposentadoria especial vai precisar depois (Lei 8.112,
 * arts. 206-A e 211-214).
 *
 * O `servidor` guarda o estado ATUAL (e o que a tela mostra e o parecer usa);
 * esta tabela guarda a linha do tempo.
 */
export const servidor_lotacao = pgTable(
  'servidor_lotacao',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    servidor_id: integer('servidor_id')
      .notNull()
      .references(() => servidor.id),
    // Unidade e UORG sao campos DIFERENTES no parecer e nem sempre apontam para
    // o mesmo nivel: a Unidade e o lugar ('Faculdade de Medicina de Diamantina')
    // e a UORG e o codigo de lotacao no SIAPE ('250 - FACULDADE DE MEDICINA...').
    // Quando a UORG nao for informada, o parecer usa a propria Unidade.
    unidade_uorg_id: integer('unidade_uorg_id').references(() => unidade_uorg.id),
    uorg_id: integer('uorg_id'),
    cargo_id: integer('cargo_id').references(() => cargo.id),
    funcao: varchar('funcao', { length: 120 }),
    vigencia_inicio: DataPura('vigencia_inicio').notNull(),
    vigencia_fim: DataPura('vigencia_fim'),
    // portaria de localizacao, memorando, ato — o documento que sustenta a mudanca
    documento: varchar('documento', { length: 200 }),
    observacao: text('observacao'),
    registrado_por: integer('registrado_por').references((): AnyPgColumn => usuario.id),
  },
  (t) => [
    foreignKey({ name: 'fk_lotacao_uorg', columns: [t.uorg_id], foreignColumns: [unidade_uorg.id] }),
    unique('uq_lotacao_inicio').on(t.servidor_id, t.vigencia_inicio),
    check('ck_lotacao_periodo', sql.raw(`vigencia_fim IS NULL OR vigencia_fim >= vigencia_inicio`)),
  ],
);

export const portaria_localizacao = pgTable(
  'portaria_localizacao',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    unidade_emissora_id: integer('unidade_emissora_id')
      .notNull()
      .references(() => unidade_uorg.id),
    // numero normalizado sem zeros a esquerda (RN-10); o literal fica em texto_original
    numero: varchar('numero', { length: 10 }).notNull(),
    ano: integer('ano').notNull(),
    data_publicacao: DataPura('data_publicacao').notNull(),
    texto_original: text('texto_original').notNull(),
    arquivo_anexo_id: integer('arquivo_anexo_id'),
  },
  (t) => [
    unique('uq_portaria').on(t.unidade_emissora_id, t.numero, t.ano),
    // `CAST(strftime('%Y', data_publicacao) AS integer)` no SQLite; aqui a coluna
    // e `date` de verdade e o ano sai por EXTRACT.
    check('ck_portaria_ano', sql.raw(`EXTRACT(YEAR FROM data_publicacao) = ano`)),
  ],
);

export const portaria_servidor = pgTable(
  'portaria_servidor',
  {
    portaria_id: integer('portaria_id')
      .notNull()
      .references(() => portaria_localizacao.id),
    servidor_id: integer('servidor_id')
      .notNull()
      .references(() => servidor.id),
    posto_trabalho_id: integer('posto_trabalho_id').references(() => posto_trabalho.id),
  },
  (t) => [primaryKey({ columns: [t.portaria_id, t.servidor_id] })],
);
