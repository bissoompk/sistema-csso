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
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

import { DataPura, Inet, MomentoUTC, agora_utc } from './base';
import { campus, servidor, unidade_uorg } from './organizacao';
import { processo } from './processo';

export const usuario = pgTable(
  'usuario',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    login: varchar('login', { length: 160 }).notNull().unique(),
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
    // Contato que a PRÓPRIA conta informa em /minha-conta (22/10/2026). Só para
    // a equipe do setor falar com a pessoa sobre treinamento, EPI e processo
    // (finalidade declarada na tela, LGPD art. 6º, I); opcionais, e a trilha
    // registra QUE mudaram, nunca o número.
    telefone: varchar('telefone', { length: 30 }),
    ramal: varchar('ramal', { length: 12 }),
  },
  (t) => [
    check('ck_usuario_provedor', sql.raw(`provedor IN ('LOCAL','LDAP','SSO_UFVJM')`)),
    // A entrada compara login e e-mail sem caixa (`autenticacao.autenticar`):
    // "Fulano" e "fulano" eram duas contas no UNIQUE da coluna e uma credencial
    // só no login — as falhas de uma bloqueavam a outra (D12). O UNIQUE da
    // coluna fica; este é o que vale.
    uniqueIndex('uq_usuario_login_sem_caixa').on(sql`lower(${t.login})`),
    uniqueIndex('uq_usuario_email_sem_caixa').on(sql`lower(${t.email})`),
  ],
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
  // Último pedido atendido com esta sessão: a expiração por inatividade
  // (`CSSO_SESSAO_INATIVIDADE_MINUTOS`). Nula = nunca usada depois do login.
  ultimo_uso_em: MomentoUTC('ultimo_uso_em'),
});

/**
 * Falhas de login por endereço de origem. Nao existe no Python: la o sistema
 * so atendia a rede do setor, e o bloqueio por CONTA bastava. Na internet o
 * mesmo endereco tenta uma senha em cada conta (sem nunca bloquear nenhuma) e
 * cada tentativa custa um Argon2id de 64 MiB; o teto por endereco corta os
 * dois. `ip` e texto (o valor vem de cabecalho); a linha dura um dia
 * (`autenticacao.expurgar_limites_ip`).
 */
export const limite_login_ip = pgTable('limite_login_ip', {
  ip: varchar('ip', { length: 64 }).primaryKey(),
  falhas: integer('falhas').notNull(),
  janela_inicio: MomentoUTC('janela_inicio').notNull(),
  bloqueado_ate: MomentoUTC('bloqueado_ate'),
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

/**
 * Liberação por módulo (22/10/2026): o nível que a coordenação escolheu para um
 * módulo inteiro num PERFIL — "sem acesso", "consulta" ou "operação". A linha
 * ausente é o padrão do perfil (as permissões de `perfil_permissao`, como
 * sempre foram): por isso a implantação não muda o acesso de ninguém, e o
 * `semear_rbac` de cada deploy não toca esta tabela. O mapa nível → permissões
 * mora num lugar só, `servicos/niveis_modulo.ts`.
 */
export const perfil_nivel_modulo = pgTable(
  'perfil_nivel_modulo',
  {
    perfil_id: integer('perfil_id')
      .notNull()
      .references(() => perfil.id),
    modulo: varchar('modulo', { length: 32 }).notNull(),
    nivel: varchar('nivel', { length: 12 }).notNull(),
    alterado_por: integer('alterado_por').references((): AnyPgColumn => usuario.id),
    alterado_em: MomentoUTC('alterado_em').notNull().$defaultFn(agora_utc),
  },
  (t) => [
    primaryKey({ columns: [t.perfil_id, t.modulo] }),
    check('ck_perfil_nivel_modulo', sql.raw(`nivel IN ('SEM_ACESSO','CONSULTA','OPERACAO')`)),
  ],
);

/**
 * A exceção de UMA conta num módulo: dá ou retira, por cima do nível dos perfis
 * dela. Linha ausente = "seguir o perfil". O escopo (campus, equipe, próprio),
 * a assinatura e a habilitação continuam vindo só do perfil.
 */
export const usuario_nivel_modulo = pgTable(
  'usuario_nivel_modulo',
  {
    usuario_id: integer('usuario_id')
      .notNull()
      .references((): AnyPgColumn => usuario.id),
    modulo: varchar('modulo', { length: 32 }).notNull(),
    nivel: varchar('nivel', { length: 12 }).notNull(),
    alterado_por: integer('alterado_por').references((): AnyPgColumn => usuario.id),
    alterado_em: MomentoUTC('alterado_em').notNull().$defaultFn(agora_utc),
  },
  (t) => [
    primaryKey({ columns: [t.usuario_id, t.modulo] }),
    check('ck_usuario_nivel_modulo', sql.raw(`nivel IN ('SEM_ACESSO','CONSULTA','OPERACAO')`)),
  ],
);

/**
 * Turmas por setor promotor (22/10/2026): a conta da equipe e os setores
 * promotores (`unidade_uorg.promove_treinamento`) cujas turmas ela vê e gere.
 * Uma conta pode estar em mais de um setor.
 */
export const equipe_setor_promotor = pgTable(
  'equipe_setor_promotor',
  {
    usuario_id: integer('usuario_id')
      .notNull()
      .references((): AnyPgColumn => usuario.id),
    unidade_uorg_id: integer('unidade_uorg_id')
      .notNull()
      .references((): AnyPgColumn => unidade_uorg.id),
    vinculado_por: integer('vinculado_por').references((): AnyPgColumn => usuario.id),
    vinculado_em: MomentoUTC('vinculado_em').notNull().$defaultFn(agora_utc),
  },
  (t) => [primaryKey({ columns: [t.usuario_id, t.unidade_uorg_id] })],
);
