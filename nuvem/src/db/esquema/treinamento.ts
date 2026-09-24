/**
 * Modulo Certificados e Treinamentos. Porte de `app/modelos/treinamento.py`.
 *
 * - fatia 1 — o que se ensina (`treinamento`), o modelo do papel
 *   (`certificado_modelo`, `certificado_modelo_tag`) e quem assina
 *   (`assinatura_instrutor`);
 * - fatia 2 — quem participa (`participante`, `participante_email`), quando
 *   (`turma`, `turma_sequencia`, `turma_instrutor`) e quem esta na turma
 *   (`inscricao`);
 * - fatia 3 — quem esteve em cada dia (`turma_presenca`);
 * - fatia 4 — o papel em si (`certificado`, `certificado_sequencia`), com o
 *   contexto congelado que faz a segunda via sair identica a primeira (RN-15).
 *
 * Dois ciclos de FK moram aqui (`treinamento` <-> `certificado_modelo` e
 * `participante` <-> `participante_email`). No SQLAlchemy eles pediam `use_alter`
 * e `post_update`; no PostgreSQL o drizzle-kit ja emite toda FK como ALTER TABLE
 * depois dos CREATE TABLE, entao o ciclo nao atrapalha a criacao. Do lado da
 * escrita, quem grava as duas pontas no mesmo gesto (publicar modelo e aponta-lo
 * como vigente; criar participante com e-mail principal) faz em dois passos:
 * INSERT das linhas, UPDATE do ponteiro — o que o `post_update` fazia sozinho.
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

import {
  ALFABETO_IDENTIFICADOR,
  ORIENTACOES,
  ORIGENS_EMAIL,
  ORIGENS_INSCRICAO,
  PADRAO_CHAVE_VALIDACAO,
  PADRAO_CODIGO_TREINAMENTO,
  PADRAO_IDENTIFICADOR_PARTICIPANTE,
  PADRAO_MARCADOR,
  PREFIXO_CHAVE,
  PREFIXO_IDENTIFICADOR,
  ROTULO_CERTIFICADO,
  ROTULO_VINCULO,
  SITUACOES_CERTIFICADO,
  TAMANHO_IDENTIFICADOR,
  TAMANHO_SORTEIO_CHAVE,
  VINCULOS_PARTICIPANTE,
  gerar_identificador_publico,
  normalizar_email,
} from '../../dominio/treinamento';
import { anexo } from './auditoria';
import { DataPura, Inet, JSONTexto, MomentoUTC, agora_utc, check_regex, fk_ciclo } from './base';
import { campus, servidor, unidade_uorg } from './organizacao';
import { usuario } from './seguranca';

export {
  ALFABETO_IDENTIFICADOR,
  ORIENTACOES,
  ORIGENS_EMAIL,
  ORIGENS_INSCRICAO,
  PADRAO_CHAVE_VALIDACAO,
  PADRAO_CODIGO_TREINAMENTO,
  PADRAO_IDENTIFICADOR_PARTICIPANTE,
  PADRAO_MARCADOR,
  PREFIXO_CHAVE,
  PREFIXO_IDENTIFICADOR,
  ROTULO_CERTIFICADO,
  ROTULO_VINCULO,
  SITUACOES_CERTIFICADO,
  TAMANHO_IDENTIFICADOR,
  TAMANHO_SORTEIO_CHAVE,
  VINCULOS_PARTICIPANTE,
  gerar_identificador_publico,
  normalizar_email,
};

/** O que se ensina. Dura anos; o layout do certificado, nao. */
export const treinamento = pgTable(
  'treinamento',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    codigo: varchar('codigo', { length: 30 }).notNull(),
    // sai no certificado byte a byte, como o nome do posto sai no parecer
    nome: varchar('nome', { length: 160 }).notNull(),
    carga_horaria_horas: numeric('carga_horaria_horas', {
      precision: 5,
      scale: 1,
      mode: 'string',
    }).notNull(),
    // um topico por linha, como checklist_modelo.itens
    conteudo_programatico: text('conteudo_programatico'),
    // 0 = NAO EXPIRA. Data magica de vencimento (31/12/9999) mente para todo
    // relatorio depois.
    validade_meses: integer('validade_meses').notNull().default(0),
    norma_referencia: varchar('norma_referencia', { length: 120 }),
    // entra no monitor de "nunca fez" quando houver exigencia cadastrada (fatia 7)
    obrigatorio: boolean('obrigatorio').notNull().default(false),
    modelo_vigente_id: integer('modelo_vigente_id'),
    instrutor_padrao_id: integer('instrutor_padrao_id'),
    ativo: boolean('ativo').notNull().default(true),
  },
  (t) => [
    // nomes da migracao `certificados_catalogo_de_treinamentos` (no modelo as
    // duas UNIQUE estavam como `unique=True` sem nome)
    primaryKey({ name: 'pk_treinamento', columns: [t.id] }),
    unique('uq_treinamento_codigo').on(t.codigo),
    unique('uq_treinamento_nome').on(t.nome),
    fk_ciclo(
      'fk_treinamento_modelo_vigente',
      t.modelo_vigente_id,
      (): AnyPgColumn => certificado_modelo.id,
    ),
    foreignKey({
      name: 'fk_treinamento_instrutor_padrao',
      columns: [t.instrutor_padrao_id],
      foreignColumns: [assinatura_instrutor.id],
    }),
    check('ck_treinamento_validade', sql.raw(`validade_meses >= 0`)),
    check('ck_treinamento_carga', sql.raw(`carga_horaria_horas > 0`)),
    check_regex('ck_treinamento_codigo', 'codigo', PADRAO_CODIGO_TREINAMENTO),
    index('ix_treinamento_ativo').on(t.ativo),
  ],
);

/**
 * O .docx com marcadores, versionado como `texto_padrao`.
 *
 * Publicar uma versao nova desativa a anterior em vez de sobrescrever: um
 * certificado ja emitido precisa continuar apontando para o layout que valia no
 * dia.
 */
export const certificado_modelo = pgTable(
  'certificado_modelo',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    // NULL = modelo generico, serve a qualquer treinamento
    treinamento_id: integer('treinamento_id'),
    nome: varchar('nome', { length: 120 }).notNull(),
    // nome do arquivo do modelo, mesmo padrao de parecer_tecnico.modelo_arquivo
    arquivo: varchar('arquivo', { length: 120 }).notNull(),
    arquivo_sha256: varchar('arquivo_sha256', { length: 64 }),
    orientacao: varchar('orientacao', { length: 10 }).notNull().default('PAISAGEM'),
    versao: integer('versao').notNull().default(1),
    vigente: boolean('vigente').notNull().default(true),
    observacao: text('observacao'),
    criado_por: integer('criado_por'),
    criado_em: MomentoUTC('criado_em').notNull().$defaultFn(agora_utc),
  },
  (t) => [
    primaryKey({ name: 'pk_certificado_modelo', columns: [t.id] }),
    foreignKey({
      name: 'fk_certificado_modelo_treinamento',
      columns: [t.treinamento_id],
      foreignColumns: [treinamento.id],
    }),
    foreignKey({
      name: 'fk_certificado_modelo_criado_por',
      columns: [t.criado_por],
      foreignColumns: [usuario.id],
    }),
    unique('uq_certificado_modelo').on(t.treinamento_id, t.nome, t.versao),
    check('ck_modelo_orientacao', sql.raw(`orientacao IN ('PAISAGEM','RETRATO')`)),
    check('ck_modelo_versao', sql.raw(`versao >= 1`)),
  ],
);

/**
 * O MAPEAMENTO_TAGS do legado, virado tabela. `marcador` e o que esta escrito no
 * .docx; `campo` e o codigo do dado do sistema que o alimenta.
 */
export const certificado_modelo_tag = pgTable(
  'certificado_modelo_tag',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    modelo_id: integer('modelo_id').notNull(),
    marcador: varchar('marcador', { length: 60 }).notNull(),
    campo: varchar('campo', { length: 60 }).notNull(),
    ordem: smallint('ordem').notNull().default(1),
    // vazio neste campo bloqueia a emissao, como DadosIncompletos no parecer
    obrigatorio: boolean('obrigatorio').notNull().default(true),
  },
  (t) => [
    primaryKey({ name: 'pk_certificado_modelo_tag', columns: [t.id] }),
    foreignKey({
      name: 'fk_modelo_tag_modelo',
      columns: [t.modelo_id],
      foreignColumns: [certificado_modelo.id],
    }).onDelete('cascade'),
    unique('uq_modelo_tag').on(t.modelo_id, t.marcador),
    check_regex('ck_modelo_tag_marcador', 'marcador', PADRAO_MARCADOR),
    index('ix_modelo_tag_campo').on(t.campo),
  ],
);

/**
 * Quem assina o certificado, interno ou externo. A imagem da rubrica e anexo
 * local, com dedup por SHA-256 — o certificado nao pode depender de um arquivo
 * que alguem move na nuvem.
 */
export const assinatura_instrutor = pgTable(
  'assinatura_instrutor',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    // instrutor interno reaproveita o cadastro de servidor; externo fica so com nome
    servidor_id: integer('servidor_id'),
    nome: varchar('nome', { length: 160 }).notNull(),
    titulo: varchar('titulo', { length: 120 }),
    conselho: varchar('conselho', { length: 8 }),
    registro_conselho: varchar('registro_conselho', { length: 30 }),
    organizacao: varchar('organizacao', { length: 160 }),
    externo: boolean('externo').notNull().default(false),
    imagem_anexo_id: integer('imagem_anexo_id'),
    vigencia_inicio: DataPura('vigencia_inicio').notNull(),
    vigencia_fim: DataPura('vigencia_fim'),
    ativo: boolean('ativo').notNull().default(true),
  },
  (t) => [
    primaryKey({ name: 'pk_assinatura_instrutor', columns: [t.id] }),
    foreignKey({
      name: 'fk_assinatura_servidor',
      columns: [t.servidor_id],
      foreignColumns: [servidor.id],
    }),
    foreignKey({
      name: 'fk_assinatura_imagem',
      columns: [t.imagem_anexo_id],
      foreignColumns: [anexo.id],
    }),
    // `externo = 1` no SQLite; booleano usado como booleano aqui
    check('ck_assinatura_vinculo', sql.raw(`externo OR servidor_id IS NOT NULL`)),
    check(
      'ck_assinatura_periodo',
      sql.raw(`vigencia_fim IS NULL OR vigencia_fim >= vigencia_inicio`),
    ),
    index('ix_assinatura_ativo').on(t.ativo),
  ],
);

// =====================================================================
// Fatia 2 — participante, turma e inscricao
// =====================================================================

/**
 * Ponteiro, nao cadastro.
 *
 * Para servidor e so um vinculo com `servidor`: nome, cargo e lotacao continuam
 * morando la, e por isso nao divergem. Para externo, e o unico lugar onde o nome
 * existe.
 *
 * NAO HA COLUNA DE CPF, e nao deve haver (decisao 1 do coordenador). O
 * identificador do externo e o e-mail confirmado, que e mutavel — por isso a
 * chave e o `id` e a identidade publica e o `identificador_publico`.
 *
 * Esta tabela nao e so de Certificados: `acidentado.participante_id` vai apontar
 * para ela quando o modulo de Acidentes chegar. Mexer aqui mexe em dois modulos.
 */
export const participante = pgTable(
  'participante',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    servidor_id: integer('servidor_id'),
    // SO para externo. Servidor tem NULL aqui e le `servidor.nome`.
    nome: varchar('nome', { length: 160 }),
    identificador_publico: varchar('identificador_publico', { length: 14 }).notNull(),
    vinculo: varchar('vinculo', { length: 16 }).notNull(),
    organizacao: varchar('organizacao', { length: 160 }),
    // matricula de discente ou numero do contrato do terceirizado, quando houver.
    // NAO e CPF, NAO e RG, e e opcional.
    matricula_externa: varchar('matricula_externa', { length: 30 }),
    email_principal_id: integer('email_principal_id'),
    // mesclagem (fatia 6): o absorvido aponta para o mantido e sai das listas,
    // sem ser apagado — chave de validacao e relatorio ja emitidos continuam
    // resolvendo
    mesclado_em_id: integer('mesclado_em_id'),
    // expurgo do externo que nunca compareceu (fatia 6, LGPD art. 6o III)
    expurgar_apos: DataPura('expurgar_apos'),
    expurgado_em: MomentoUTC('expurgado_em'),
    ativo: boolean('ativo').notNull().default(true),
    criado_em: MomentoUTC('criado_em').notNull().$defaultFn(agora_utc),
  },
  (t) => [
    foreignKey({
      name: 'fk_participante_servidor',
      columns: [t.servidor_id],
      foreignColumns: [servidor.id],
    }),
    fk_ciclo(
      'fk_participante_email_principal',
      t.email_principal_id,
      (): AnyPgColumn => participante_email.id,
    ),
    foreignKey({
      name: 'fk_participante_mesclado',
      columns: [t.mesclado_em_id],
      foreignColumns: [t.id],
    }),
    // exatamente uma fonte de nome: o cadastro de servidor OU o campo local
    check(
      'ck_participante_nome',
      sql.raw(
        `(servidor_id IS NOT NULL AND nome IS NULL) OR ` +
          `(servidor_id IS NULL AND nome IS NOT NULL) OR expurgado_em IS NOT NULL`,
      ),
    ),
    check(
      'ck_participante_vinculo',
      sql.raw(`vinculo IN ('SERVIDOR','TERCEIRIZADO','DISCENTE','VISITANTE','OUTRO')`),
    ),
    check('ck_participante_servidor', sql.raw(`vinculo <> 'SERVIDOR' OR servidor_id IS NOT NULL`)),
    check_regex(
      'ck_participante_identificador',
      'identificador_publico',
      PADRAO_IDENTIFICADOR_PARTICIPANTE,
    ),
    primaryKey({ name: 'pk_participante', columns: [t.id] }),
    unique('uq_participante_servidor').on(t.servidor_id),
    unique('uq_participante_identificador').on(t.identificador_publico),
    index('ix_participante_mesclado').on(t.mesclado_em_id),
  ],
);

/**
 * Os e-mails conhecidos de um participante. Um participante, N enderecos.
 *
 * `email_normalizado` nasce de `email` por `normalizar_email`, SEMPRE — no
 * Python um `@validates` fazia isso sozinho; aqui nao ha ORM com gancho de
 * atributo, e quem grava tem de passar pelas duas colunas juntas (ou a busca por
 * e-mail para de achar a pessoa, em silencio).
 */
export const participante_email = pgTable(
  'participante_email',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    participante_id: integer('participante_id').notNull(),
    email: varchar('email', { length: 160 }).notNull(),
    email_normalizado: varchar('email_normalizado', { length: 160 }).notNull(),
    confirmado_em: MomentoUTC('confirmado_em'),
    origem: varchar('origem', { length: 20 }).notNull().default('CADASTRO'),
    criado_em: MomentoUTC('criado_em').notNull().$defaultFn(agora_utc),
  },
  (t) => [
    foreignKey({
      name: 'fk_participante_email_dono',
      columns: [t.participante_id],
      foreignColumns: [participante.id],
    }).onDelete('cascade'),
    unique('uq_participante_email').on(t.participante_id, t.email_normalizado),
    check(
      'ck_participante_email_origem',
      sql.raw(`origem IN ('CADASTRO','INSCRICAO_PUBLICA','SERVIDOR','MESCLAGEM')`),
    ),
    primaryKey({ name: 'pk_participante_email', columns: [t.id] }),
    index('ix_participante_email_norm').on(t.email_normalizado),
    // Um e-mail CONFIRMADO pertence a um participante so. E-mail ainda nao
    // confirmado pode aparecer em mais de um registro — e justamente o sinal de
    // que ha duplicata a mesclar.
    uniqueIndex('uq_email_confirmado')
      .on(t.email_normalizado)
      .where(sql.raw(`confirmado_em IS NOT NULL`)),
  ],
);

/** Mesma disciplina da RN-03: nunca MAX(numero)+1. */
export const turma_sequencia = pgTable(
  'turma_sequencia',
  {
    ano: integer('ano').notNull(),
    ultimo_numero: integer('ultimo_numero').notNull().default(0),
  },
  (t) => [primaryKey({ name: 'pk_turma_sequencia', columns: [t.ano] })],
);

/** Uma oferta do treinamento: quando, onde, com quem e para quantos. */
export const turma = pgTable(
  'turma',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    treinamento_id: integer('treinamento_id').notNull(),
    numero: integer('numero').notNull(),
    ano: integer('ano').notNull(),
    // TUR-2026-0007, derivado de numero/ano. Fica gravado porque e ele que vai
    // no cartaz e no oficio.
    codigo: varchar('codigo', { length: 20 }).notNull(),

    // o legado tinha so DATA_CURSO; turma de 40h dura dias
    data_inicio: DataPura('data_inicio').notNull(),
    data_fim: DataPura('data_fim').notNull(),
    // nem sempre e o fim do curso (pode ser a avaliacao pratica). Vazio = data_fim.
    data_base_vencimento: DataPura('data_base_vencimento'),
    // sobrepoe a carga do treinamento quando a turma teve carga diferente
    carga_horaria_horas: numeric('carga_horaria_horas', { precision: 5, scale: 1, mode: 'string' }),

    local: varchar('local', { length: 160 }),
    // o campus e o que faz o escopo por unidade funcionar sobre a turma sem caso
    // especial
    campus_id: integer('campus_id'),
    unidade_promotora_id: integer('unidade_promotora_id'),

    vagas: integer('vagas'),
    inscricao_aberta_ate: DataPura('inscricao_aberta_ate'),
    // --- inscricao publica (fatia 6) ---
    // O token vive no cartaz e no e-mail; aqui fica so o SHA-256, pelo mesmo
    // motivo que `sessao` guarda `token_hash`.
    inscricao_publica: boolean('inscricao_publica').notNull().default(false),
    inscricao_token_hash: varchar('inscricao_token_hash', { length: 64 }),
    inscricao_token_expira_em: MomentoUTC('inscricao_token_expira_em'),

    nota_minima_aprovacao: numeric('nota_minima_aprovacao', { precision: 5, scale: 2, mode: 'string' }),
    // 75% e a praxe; a NR nao fixa numero geral
    frequencia_minima_percentual: numeric('frequencia_minima_percentual', {
      precision: 5,
      scale: 2,
      mode: 'string',
    })
      .notNull()
      .default('75'),

    situacao: varchar('situacao', { length: 20 }).notNull().default('PLANEJADA'),
    motivo_cancelamento: text('motivo_cancelamento'),
    observacoes: text('observacoes'),
    concluida_em: MomentoUTC('concluida_em'),
    criado_por: integer('criado_por'),
    criado_em: MomentoUTC('criado_em').notNull().$defaultFn(agora_utc),
  },
  (t) => [
    foreignKey({
      name: 'fk_turma_treinamento',
      columns: [t.treinamento_id],
      foreignColumns: [treinamento.id],
    }),
    foreignKey({ name: 'fk_turma_campus', columns: [t.campus_id], foreignColumns: [campus.id] }),
    foreignKey({
      name: 'fk_turma_unidade',
      columns: [t.unidade_promotora_id],
      foreignColumns: [unidade_uorg.id],
    }),
    foreignKey({ name: 'fk_turma_criado_por', columns: [t.criado_por], foreignColumns: [usuario.id] }),
    unique('uq_turma').on(t.numero, t.ano),
    check('ck_turma_periodo', sql.raw(`data_fim >= data_inicio`)),
    check(
      'ck_turma_situacao',
      sql.raw(
        `situacao IN ('PLANEJADA','INSCRICOES_ABERTAS','EM_ANDAMENTO','CONCLUIDA','CANCELADA')`,
      ),
    ),
    // cancelar sem motivo produz turma morta sem explicacao
    check('ck_turma_cancelada', sql.raw(`situacao <> 'CANCELADA' OR motivo_cancelamento IS NOT NULL`)),
    check('ck_turma_vagas', sql.raw(`vagas IS NULL OR vagas > 0`)),
    check('ck_turma_carga', sql.raw(`carga_horaria_horas IS NULL OR carga_horaria_horas > 0`)),
    // link publico sem data de fechamento fica aberto para sempre
    // (`inscricao_publica = 0` no SQLite; booleano usado como booleano aqui)
    check(
      'ck_turma_inscricao_publica',
      sql.raw(`NOT inscricao_publica OR inscricao_aberta_ate IS NOT NULL`),
    ),
    check(
      'ck_turma_nota_minima',
      sql.raw(
        `nota_minima_aprovacao IS NULL OR ` +
          `(nota_minima_aprovacao >= 0 AND nota_minima_aprovacao <= 10)`,
      ),
    ),
    check(
      'ck_turma_frequencia_minima',
      sql.raw(`frequencia_minima_percentual >= 0 AND frequencia_minima_percentual <= 100`),
    ),
    check('ck_turma_ano', sql.raw(`EXTRACT(YEAR FROM data_inicio) = ano`)),
    primaryKey({ name: 'pk_turma', columns: [t.id] }),
    unique('uq_turma_codigo').on(t.codigo),
    unique('uq_turma_token').on(t.inscricao_token_hash),
    index('ix_turma_treinamento').on(t.treinamento_id),
    index('ix_turma_situacao').on(t.situacao),
    index('ix_turma_data_fim').on(t.data_fim),
  ],
);

/**
 * N instrutores por turma. No legado era uma coluna de texto — e por isso nao
 * havia como saber quem assina o certificado de qual turma.
 */
export const turma_instrutor = pgTable(
  'turma_instrutor',
  {
    turma_id: integer('turma_id').notNull(),
    assinatura_instrutor_id: integer('assinatura_instrutor_id').notNull(),
    ordem: smallint('ordem').notNull().default(1),
    assina_certificado: boolean('assina_certificado').notNull().default(true),
  },
  (t) => [
    foreignKey({
      name: 'fk_turma_instrutor_turma',
      columns: [t.turma_id],
      foreignColumns: [turma.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fk_turma_instrutor_assinatura',
      columns: [t.assinatura_instrutor_id],
      foreignColumns: [assinatura_instrutor.id],
    }),
    primaryKey({ name: 'pk_turma_instrutor', columns: [t.turma_id, t.assinatura_instrutor_id] }),
  ],
);

/**
 * A pessoa dentro da turma. Guarda so a inscricao: presenca fica em
 * `turma_presenca` e o certificado em `certificado`.
 */
export const inscricao = pgTable(
  'inscricao',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    turma_id: integer('turma_id').notNull(),
    participante_id: integer('participante_id').notNull(),

    situacao: varchar('situacao', { length: 24 }).notNull().default('INSCRITA'),
    origem: varchar('origem', { length: 12 }).notNull().default('INTERNA'),

    // --- confirmacao de e-mail da inscricao publica (fatia 6) ---
    confirmacao_token_hash: varchar('confirmacao_token_hash', { length: 64 }),
    confirmacao_expira_em: MomentoUTC('confirmacao_expira_em'),
    email_confirmado_em: MomentoUTC('email_confirmado_em'),
    ip_inscricao: Inet('ip_inscricao'),

    inscrito_em: MomentoUTC('inscrito_em').notNull().$defaultFn(agora_utc),
    inscrito_por: integer('inscrito_por'),
    confirmada_em: MomentoUTC('confirmada_em'),
    confirmada_por: integer('confirmada_por'),

    // CALCULADA a partir de `turma_presenca` pelo servico de presenca, nunca
    // digitada — mesmo espirito da RN-07
    frequencia_percentual: numeric('frequencia_percentual', { precision: 5, scale: 2, mode: 'string' }),
    nota_final: numeric('nota_final', { precision: 5, scale: 2, mode: 'string' }),
    observacao: text('observacao'),
    motivo_cancelamento: text('motivo_cancelamento'),
  },
  (t) => [
    foreignKey({
      name: 'fk_inscricao_turma',
      columns: [t.turma_id],
      foreignColumns: [turma.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fk_inscricao_participante',
      columns: [t.participante_id],
      foreignColumns: [participante.id],
    }),
    foreignKey({
      name: 'fk_inscricao_inscrito_por',
      columns: [t.inscrito_por],
      foreignColumns: [usuario.id],
    }),
    foreignKey({
      name: 'fk_inscricao_confirmada_por',
      columns: [t.confirmada_por],
      foreignColumns: [usuario.id],
    }),
    unique('uq_inscricao').on(t.turma_id, t.participante_id),
    check(
      'ck_inscricao_situacao',
      sql.raw(
        `situacao IN ('AGUARDANDO_EMAIL','INSCRITA','CONFIRMADA','PRESENTE',` +
          `'AUSENTE','APROVADO','REPROVADO','CANCELADA')`,
      ),
    ),
    check('ck_inscricao_origem', sql.raw(`origem IN ('INTERNA','PUBLICA')`)),
    check('ck_inscricao_nota', sql.raw(`nota_final IS NULL OR (nota_final >= 0 AND nota_final <= 10)`)),
    check(
      'ck_inscricao_frequencia',
      sql.raw(
        `frequencia_percentual IS NULL OR ` +
          `(frequencia_percentual >= 0 AND frequencia_percentual <= 100)`,
      ),
    ),
    check(
      'ck_inscricao_cancelada',
      sql.raw(`situacao <> 'CANCELADA' OR motivo_cancelamento IS NOT NULL`),
    ),
    // inscricao publica so sai de AGUARDANDO_EMAIL depois de confirmada: e a
    // trava que impede inscrever alguem no e-mail alheio
    check(
      'ck_inscricao_email_confirmado',
      sql.raw(
        `origem = 'INTERNA' OR situacao = 'AGUARDANDO_EMAIL' OR email_confirmado_em IS NOT NULL`,
      ),
    ),
    primaryKey({ name: 'pk_inscricao', columns: [t.id] }),
    unique('uq_inscricao_token').on(t.confirmacao_token_hash),
    index('ix_inscricao_participante').on(t.participante_id),
    index('ix_inscricao_turma_situacao').on(t.turma_id, t.situacao),
  ],
);

/**
 * Presenca de um inscrito num dia da turma.
 *
 * Frequencia se conta por DIA, nao por "veio ou nao veio". Sem a linha por dia,
 * a unica alternativa seria alguem digitar o percentual — e percentual digitado
 * e percentual que ninguem consegue conferir depois.
 */
export const turma_presenca = pgTable(
  'turma_presenca',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    inscricao_id: integer('inscricao_id').notNull(),
    data: DataPura('data').notNull(),
    horas: numeric('horas', { precision: 4, scale: 1, mode: 'string' }).notNull().default('0'),
    presente: boolean('presente').notNull().default(true),
    // por que faltou. Nao abate a falta — so explica o que aconteceu.
    justificativa: text('justificativa'),
    registrado_por: integer('registrado_por'),
    registrado_em: MomentoUTC('registrado_em').notNull().$defaultFn(agora_utc),
  },
  (t) => [
    foreignKey({
      name: 'fk_turma_presenca_inscricao',
      columns: [t.inscricao_id],
      foreignColumns: [inscricao.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fk_turma_presenca_registrado_por',
      columns: [t.registrado_por],
      foreignColumns: [usuario.id],
    }),
    check('ck_turma_presenca_horas', sql.raw(`horas >= 0`)),
    // quem faltou nao acumula hora
    check('ck_turma_presenca_coerente', sql.raw(`presente OR horas = 0`)),
    primaryKey({ name: 'pk_turma_presenca', columns: [t.id] }),
    // um dia, um lancamento por inscrito
    unique('uq_turma_presenca_dia').on(t.inscricao_id, t.data),
  ],
);

// =====================================================================
// Fatia 4 — o certificado
// =====================================================================

/** Mesma disciplina da RN-03: nunca MAX(numero)+1. */
export const certificado_sequencia = pgTable(
  'certificado_sequencia',
  {
    ano: integer('ano').notNull(),
    ultimo_numero: integer('ultimo_numero').notNull().default(0),
  },
  (t) => [primaryKey({ name: 'pk_certificado_sequencia', columns: [t.ano] })],
);

/**
 * O documento que circula — e por isso o unico deste modulo que congela.
 *
 * RN-15: `contexto_congelado` guarda TUDO o que foi renderizado, **inclusive o
 * mapa de tags**. O que NAO entra no congelado, de proposito: `situacao` e "esta
 * vencido hoje?". Sao estado, calculados na hora.
 *
 * `servidor_id` e `campus_id` sao denormalizados da inscricao e da turma para
 * que o escopo por unidade/proprio funcione sem caso especial.
 */
export const certificado = pgTable(
  'certificado',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    // sem ondelete: documento emitido se anula, nao se apaga
    inscricao_id: integer('inscricao_id').notNull(),
    numero: integer('numero').notNull(),
    ano: integer('ano').notNull(),
    // em claro, com indice unico: a segunda via sai com a MESMA chave
    chave_validacao: varchar('chave_validacao', { length: 24 }).notNull(),

    situacao: varchar('situacao', { length: 12 }).notNull().default('EMITIDO'),
    data_emissao: DataPura('data_emissao').notNull(),
    data_base_vencimento: DataPura('data_base_vencimento').notNull(),
    // NULL = nao expira (validade_meses = 0). Sem data magica.
    data_vencimento: DataPura('data_vencimento'),
    validade_meses_congelada: integer('validade_meses_congelada').notNull(),

    // RN-15: TODO o conteudo renderizado, inclusive o mapa de tags
    contexto_congelado: JSONTexto<Record<string, unknown>>('contexto_congelado').notNull(),

    modelo_id: integer('modelo_id'),
    modelo_arquivo: varchar('modelo_arquivo', { length: 120 }).notNull(),
    modelo_sha256: varchar('modelo_sha256', { length: 64 }),
    // SHA-256 do TEXTO extraido do .docx gerado, nao dos bytes do arquivo
    hash_conteudo: varchar('hash_conteudo', { length: 64 }),
    arquivo_docx: text('arquivo_docx'),
    arquivo_pdf_anexo_id: integer('arquivo_pdf_anexo_id'),

    servidor_id: integer('servidor_id'),
    campus_id: integer('campus_id'),
    treinamento_id: integer('treinamento_id').notNull(),
    participante_id: integer('participante_id').notNull(),

    emitido_por: integer('emitido_por'),
    emitido_em: MomentoUTC('emitido_em').notNull().$defaultFn(agora_utc),
    anulado_em: MomentoUTC('anulado_em'),
    anulado_por: integer('anulado_por'),
    motivo_anulacao: text('motivo_anulacao'),
    substituido_por_id: integer('substituido_por_id'),
  },
  (t) => [
    foreignKey({
      name: 'fk_certificado_inscricao',
      columns: [t.inscricao_id],
      foreignColumns: [inscricao.id],
    }),
    foreignKey({
      name: 'fk_certificado_modelo',
      columns: [t.modelo_id],
      foreignColumns: [certificado_modelo.id],
    }),
    foreignKey({
      name: 'fk_certificado_pdf',
      columns: [t.arquivo_pdf_anexo_id],
      foreignColumns: [anexo.id],
    }),
    foreignKey({
      name: 'fk_certificado_servidor',
      columns: [t.servidor_id],
      foreignColumns: [servidor.id],
    }),
    foreignKey({ name: 'fk_certificado_campus', columns: [t.campus_id], foreignColumns: [campus.id] }),
    foreignKey({
      name: 'fk_certificado_treinamento',
      columns: [t.treinamento_id],
      foreignColumns: [treinamento.id],
    }),
    foreignKey({
      name: 'fk_certificado_participante',
      columns: [t.participante_id],
      foreignColumns: [participante.id],
    }),
    foreignKey({
      name: 'fk_certificado_emitido_por',
      columns: [t.emitido_por],
      foreignColumns: [usuario.id],
    }),
    foreignKey({
      name: 'fk_certificado_anulado_por',
      columns: [t.anulado_por],
      foreignColumns: [usuario.id],
    }),
    foreignKey({
      name: 'fk_certificado_substituto',
      columns: [t.substituido_por_id],
      foreignColumns: [t.id],
    }),
    unique('uq_certificado').on(t.numero, t.ano),
    unique('uq_certificado_chave').on(t.chave_validacao),
    check('ck_certificado_situacao', sql.raw(`situacao IN ('EMITIDO','ANULADO')`)),
    // anular sem motivo produz documento morto sem explicacao
    check('ck_certificado_anulado', sql.raw(`situacao <> 'ANULADO' OR motivo_anulacao IS NOT NULL`)),
    // 0 mes <=> sem vencimento. As duas colunas nao podem se contradizer.
    check(
      'ck_certificado_vencimento',
      sql.raw(
        `(validade_meses_congelada = 0 AND data_vencimento IS NULL) OR ` +
          `(validade_meses_congelada > 0 AND data_vencimento IS NOT NULL)`,
      ),
    ),
    check('ck_certificado_validade', sql.raw(`validade_meses_congelada >= 0`)),
    check('ck_certificado_ano', sql.raw(`EXTRACT(YEAR FROM data_emissao) = ano`)),
    // nao se substitui por si mesmo: o ciclo transformaria a cadeia de reemissao
    // num laco que nenhuma tela sabe percorrer
    check(
      'ck_certificado_substituto',
      sql.raw(`substituido_por_id IS NULL OR substituido_por_id <> id`),
    ),
    check_regex('ck_certificado_chave', 'chave_validacao', PADRAO_CHAVE_VALIDACAO),
    primaryKey({ name: 'pk_certificado', columns: [t.id] }),
    index('ix_certificado_vencimento').on(t.data_vencimento),
    index('ix_certificado_servidor').on(t.servidor_id),
    index('ix_certificado_participante').on(t.participante_id),
    index('ix_certificado_treinamento').on(t.treinamento_id),
    index('ix_certificado_inscricao').on(t.inscricao_id),
    // Uma inscricao tem no maximo um certificado NAO anulado. Anular libera a
    // reemissao sem apagar o historico — RN-14 aplicada ao certificado. PARCIAL
    // de proposito: um unique comum impediria a segunda emissao para sempre.
    uniqueIndex('uq_certificado_ativo')
      .on(t.inscricao_id)
      .where(sql.raw(`situacao <> 'ANULADO'`)),
  ],
);
