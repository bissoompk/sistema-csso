/**
 * Módulo de acidentes (CAT/SP) — tabelas.
 *
 * O prefixo `acidente_` está em todas, menos `acidentado`, nome que a ROPA
 * (§1.3, §4.3) e a POLITICA_RETENCAO (§2.4) já fixaram.
 *
 * **O que NÃO está aqui, de propósito (ROPA §4.3/§4.5):** CPF, RG, data de
 * nascimento, sexo, endereço residencial, telefone pessoal, CID, diagnóstico,
 * texto clínico e foto de lesão. O acidentado que não é servidor tem cadastro
 * próprio com nome e vínculo, SEM CPF (decisão D14c, 23/10/2026), e a coluna de
 * identificação externa recusa, por CHECK, o que tem cara de CPF.
 *
 * **Imutabilidade.** A CAT/SP é versionada e append-only; a ocorrência só muda
 * as colunas de trâmite, e os fatos do evento só mudam junto com uma versão
 * nova da CAT/SP (retificação). Quem faz isso valer é `travas.sql`; as listas de
 * colunas estão espelhadas em `travas.ts`, e um teste confere as duas contra
 * este arquivo.
 *
 * **Saúde** mora em tabela e serviço próprios (`acidente_saude`), em dois
 * níveis (ROPA §4.4). O nível 2 só vai a NULL junto do carimbo de expurgo.
 *
 * Constraints nomeadas (`fk_`, `ck_`, `uq_`, `ix_`), como no resto do esquema.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  unique,
  varchar,
} from 'drizzle-orm/pg-core';

import {
  CARACTERIZACAO,
  CONDICOES_ENVOLVIDO,
  ESPECIES,
  LATERALIDADES,
  LOCAIS_TIPO,
  MEIOS_ENCAMINHAMENTO,
  MOTIVOS_CANCELAMENTO,
  ORIGENS,
  ORIGENS_CAT_SP,
  ORIGENS_CHECKLIST,
  ORIGENS_SAUDE,
  PADRAO_PROTOCOLO_CAT,
  PRIORIDADES,
  RESULTADOS_PERICIA,
  SIM_NAO_NAO_SEI,
  SITUACOES_BARREIRA,
  TIPOS_ACAO,
  TIPOS_BARREIRA,
  TIPOS_CAT,
  VARIANTES_RELATORIO,
  VINCULOS_ACIDENTADO,
  ESTADOS_ACAO,
  ESTADOS_ACIDENTE,
} from '../../dominio/acidente';
import { PADRAO_NUP } from '../../dominio/processo';
import { PADRAO_SIAPE } from '../../dominio/organizacao';
import { anexo } from './auditoria';
import { DataPura, JSONTexto, MomentoUTC, agora_utc, ancorar, check_regex, lista_sql } from './base';
import { campus, cargo, servidor, unidade_uorg, posto_trabalho } from './organizacao';
import { usuario } from './seguranca';
import { participante } from './treinamento';

/** `coluna IN (...)`; o nulo passa (um CHECK com NULL não reprova). */
const em = (coluna: string, valores: readonly string[]) => sql.raw(`${coluna} IN (${lista_sql(valores)})`);

// ---------------------------------------------------------------------
// Catálogos semeados (`semear_acidentes`; idempotente, com `ativo`, sem delete)
// ---------------------------------------------------------------------
// `ordem` é o número que o legado escrevia DENTRO do texto ("17. DEDO"): era
// índice sequencial, não código oficial. O código oficial (NBR 14280, Tabelas I
// a IV da CAT/SP, Tabelas 13 a 15 e 17 do eSocial) tem coluna própria, anulável.
// `rotulo` é a grafia corrigida e `rotulo_legado` o texto original, que é por
// onde a migração da planilha casa.

export const acidente_parte_corpo = pgTable(
  'acidente_parte_corpo',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    ordem: integer('ordem').notNull(),
    rotulo: varchar('rotulo', { length: 240 }).notNull(),
    rotulo_legado: varchar('rotulo_legado', { length: 400 }),
    codigo_oficial: varchar('codigo_oficial', { length: 20 }),
    ativo: boolean('ativo').notNull().default(true),
  },
  (t) => [
    primaryKey({ name: 'pk_acidente_parte_corpo', columns: [t.id] }),
    unique('uq_acidente_parte_corpo_ordem').on(t.ordem),
    unique('uq_acidente_parte_corpo_legado').on(t.rotulo_legado),
  ],
);

/** O agente causador do ACIDENTE; `grupo` é a classe que o legado grudava no fim do texto. */
export const acidente_agente_causador = pgTable(
  'acidente_agente_causador',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    ordem: integer('ordem').notNull(),
    rotulo: varchar('rotulo', { length: 240 }).notNull(),
    grupo: varchar('grupo', { length: 120 }),
    rotulo_legado: varchar('rotulo_legado', { length: 400 }),
    codigo_oficial: varchar('codigo_oficial', { length: 20 }),
    ativo: boolean('ativo').notNull().default(true),
  },
  (t) => [
    primaryKey({ name: 'pk_acidente_agente_causador', columns: [t.id] }),
    unique('uq_acidente_agente_causador_ordem').on(t.ordem),
    unique('uq_acidente_agente_causador_legado').on(t.rotulo_legado),
  ],
);

/** O agente causador da DOENÇA (Tabela 14 do eSocial); só se usa na espécie DOENCA_TRABALHO. */
export const acidente_agente_doenca = pgTable(
  'acidente_agente_doenca',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    ordem: integer('ordem').notNull(),
    rotulo: varchar('rotulo', { length: 240 }).notNull(),
    rotulo_legado: varchar('rotulo_legado', { length: 400 }),
    codigo_oficial: varchar('codigo_oficial', { length: 20 }),
    ativo: boolean('ativo').notNull().default(true),
  },
  (t) => [
    primaryKey({ name: 'pk_acidente_agente_doenca', columns: [t.id] }),
    unique('uq_acidente_agente_doenca_ordem').on(t.ordem),
    unique('uq_acidente_agente_doenca_legado').on(t.rotulo_legado),
  ],
);

export const acidente_situacao_geradora = pgTable(
  'acidente_situacao_geradora',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    ordem: integer('ordem').notNull(),
    rotulo: varchar('rotulo', { length: 240 }).notNull(),
    rotulo_legado: varchar('rotulo_legado', { length: 400 }),
    codigo_oficial: varchar('codigo_oficial', { length: 20 }),
    ativo: boolean('ativo').notNull().default(true),
  },
  (t) => [
    primaryKey({ name: 'pk_acidente_situacao_geradora', columns: [t.id] }),
    unique('uq_acidente_situacao_geradora_ordem').on(t.ordem),
    unique('uq_acidente_situacao_geradora_legado').on(t.rotulo_legado),
  ],
);

/** Natureza da lesão (D11): a tabela oficial, com o código oficial; sem texto legado. */
export const acidente_natureza_lesao = pgTable(
  'acidente_natureza_lesao',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    ordem: integer('ordem').notNull(),
    rotulo: varchar('rotulo', { length: 240 }).notNull(),
    rotulo_legado: varchar('rotulo_legado', { length: 400 }),
    codigo_oficial: varchar('codigo_oficial', { length: 20 }),
    ativo: boolean('ativo').notNull().default(true),
  },
  (t) => [
    primaryKey({ name: 'pk_acidente_natureza_lesao', columns: [t.id] }),
    unique('uq_acidente_natureza_lesao_ordem').on(t.ordem),
    unique('uq_acidente_natureza_lesao_oficial').on(t.codigo_oficial),
  ],
);

// ---------------------------------------------------------------------
// A sequência do protocolo `CAT-AAAA-NNNN`
// ---------------------------------------------------------------------
/**
 * Mesma disciplina da RN-03: nunca `MAX(numero)+1` (o legado contava linhas e
 * repetia protocolo quando se apagava uma), e cancelar NÃO devolve o número. Os
 * números já ocupados (os migrados da planilha, D7) são pulados.
 */
export const acidente_cat_sp_sequencia = pgTable(
  'acidente_cat_sp_sequencia',
  {
    ano: integer('ano').notNull(),
    ultimo_numero: integer('ultimo_numero').notNull().default(0),
  },
  (t) => [primaryKey({ name: 'pk_acidente_cat_sp_sequencia', columns: [t.ano] })],
);

// ---------------------------------------------------------------------
// A ocorrência
// ---------------------------------------------------------------------
/**
 * O acidente comunicado. Linha permanente (POLITICA_RETENCAO §2.4), sem DELETE.
 *
 * Três famílias de coluna, que a trava de `travas.sql` distingue:
 *
 * - **identidade** — protocolo, ano, número, tipo, reabertura, origem, autor e
 *   data de criação: nunca mudam;
 * - **fatos do evento** — espécie, data, hora, local, trânsito, catálogos,
 *   acidentado principal, prazo e a restrição por menor: só mudam por
 *   RETIFICAÇÃO, junto com uma versão nova da CAT/SP (`cat_sp_versao`);
 * - **trâmite** — estado, responsável, cancelamento, conclusão, prorrogação do
 *   prazo, `cat_sp_versao` e `versao` (controle otimista): mudam no dia a dia.
 */
export const acidente_ocorrencia = pgTable(
  'acidente_ocorrencia',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    // `CAT-2026-0001`; `numero` e `ano` são o que a sequência controla (D7)
    protocolo: varchar('protocolo', { length: 16 }).notNull(),
    ano: integer('ano').notNull(),
    numero: integer('numero').notNull(),
    estado: varchar('estado', { length: 30 }).notNull().default('RECEBIDA'),

    especie: varchar('especie', { length: 16 }).notNull(),
    tipo_cat: varchar('tipo_cat', { length: 12 }).notNull().default('INICIAL'),
    // a reabertura é uma ocorrência NOVA que aponta para a anterior
    reabre_id: integer('reabre_id'),
    origem: varchar('origem', { length: 12 }).notNull(),

    data_evento: DataPura('data_evento').notNull(),
    hora_evento: time('hora_evento'),
    minutos_apos_inicio_jornada: integer('minutos_apos_inicio_jornada'),
    ultimo_dia_trabalho: DataPura('ultimo_dia_trabalho'),

    local_tipo: varchar('local_tipo', { length: 24 }).notNull(),
    local_especificacao: text('local_especificacao').notNull(),
    // o campus recorta o escopo E; vem do local, e não do acidentado
    campus_id: integer('campus_id'),
    local_unidade_uorg_id: integer('local_unidade_uorg_id'),
    local_municipio: varchar('local_municipio', { length: 80 }),
    local_uf: varchar('local_uf', { length: 2 }),
    // CNPJ da EMPRESA contratada (pessoa jurídica), quando o local é dela
    local_cnpj_contratada: varchar('local_cnpj_contratada', { length: 18 }),

    transito_registro_policial: varchar('transito_registro_policial', { length: 8 }),
    transito_numero_bo: varchar('transito_numero_bo', { length: 40 }),
    transito_vitima_terceiros: varchar('transito_vitima_terceiros', { length: 8 }),

    agente_causador_id: integer('agente_causador_id'),
    agente_doenca_id: integer('agente_doenca_id'),
    situacao_geradora_id: integer('situacao_geradora_id'),

    // o acidentado principal, para `aplicar_escopo` no escopo P; nulo quando ele
    // não é servidor (o cadastro dele está em `acidentado`)
    servidor_id: integer('servidor_id'),
    // quem conduz o caso na CSSO
    responsavel_id: integer('responsavel_id'),

    // data do ACIDENTE + 10 dias (art. 214; D13). A prorrogação NÃO mexe nela:
    // é registrada ao lado, com motivo
    prazo_comunicacao: DataPura('prazo_comunicacao').notNull(),
    prazo_prorrogado_ate: DataPura('prazo_prorrogado_ate'),
    prorrogacao_motivo: text('prorrogacao_motivo'),
    prorrogado_por: integer('prorrogado_por'),
    prorrogado_em: MomentoUTC('prorrogado_em'),

    cancelamento_motivo: varchar('cancelamento_motivo', { length: 30 }),
    cancelamento_texto: text('cancelamento_texto'),
    // concluir sem decisão pericial (ou sem CAT/SP no SIASS) exige este motivo
    conclusao_motivo: text('conclusao_motivo'),
    concluida_em: MomentoUTC('concluida_em'),

    // D14a: acidentado menor de idade deixa a ocorrência restrita à equipe de SST
    restrita_sst: boolean('restrita_sst').notNull().default(false),

    // a versão da CAT/SP que as colunas de fato espelham; sobe junto com elas
    cat_sp_versao: integer('cat_sp_versao').notNull().default(0),
    // anulável: o formulário por link (D1, F2) não tem usuário
    criado_por: integer('criado_por'),
    criado_em: MomentoUTC('criado_em').notNull().$defaultFn(agora_utc),
    // controle otimista de quem muda o trâmite
    versao: integer('versao').notNull().default(1),
  },
  (t) => [
    primaryKey({ name: 'pk_acidente_ocorrencia', columns: [t.id] }),
    foreignKey({ name: 'fk_acid_oc_reabre', columns: [t.reabre_id], foreignColumns: [t.id] }),
    foreignKey({ name: 'fk_acid_oc_campus', columns: [t.campus_id], foreignColumns: [campus.id] }),
    foreignKey({ name: 'fk_acid_oc_unidade', columns: [t.local_unidade_uorg_id], foreignColumns: [unidade_uorg.id] }),
    foreignKey({ name: 'fk_acid_oc_agente', columns: [t.agente_causador_id], foreignColumns: [acidente_agente_causador.id] }),
    foreignKey({ name: 'fk_acid_oc_doenca', columns: [t.agente_doenca_id], foreignColumns: [acidente_agente_doenca.id] }),
    foreignKey({
      name: 'fk_acid_oc_situacao',
      columns: [t.situacao_geradora_id],
      foreignColumns: [acidente_situacao_geradora.id],
    }),
    foreignKey({ name: 'fk_acid_oc_servidor', columns: [t.servidor_id], foreignColumns: [servidor.id] }),
    foreignKey({ name: 'fk_acid_oc_responsavel', columns: [t.responsavel_id], foreignColumns: [usuario.id] }),
    foreignKey({ name: 'fk_acid_oc_prorrogado_por', columns: [t.prorrogado_por], foreignColumns: [usuario.id] }),
    foreignKey({ name: 'fk_acid_oc_criado_por', columns: [t.criado_por], foreignColumns: [usuario.id] }),
    check('ck_acid_oc_estado', em('estado', ESTADOS_ACIDENTE)),
    check('ck_acid_oc_especie', em('especie', ESPECIES)),
    check('ck_acid_oc_tipo_cat', em('tipo_cat', TIPOS_CAT)),
    check('ck_acid_oc_origem', em('origem', ORIGENS)),
    check('ck_acid_oc_local_tipo', em('local_tipo', LOCAIS_TIPO)),
    check('ck_acid_oc_transito_bo', em('transito_registro_policial', SIM_NAO_NAO_SEI)),
    check('ck_acid_oc_transito_terceiros', em('transito_vitima_terceiros', SIM_NAO_NAO_SEI)),
    check_regex('ck_acid_oc_protocolo', 'protocolo', PADRAO_PROTOCOLO_CAT),
    // as três colunas do protocolo andam juntas (como em `epi_requisicao`)
    check(
      'ck_acid_oc_numero',
      sql.raw(
        `numero > 0 AND protocolo = 'CAT-' || ano::text || '-' || ` +
          `CASE WHEN numero < 10000 THEN lpad(numero::text, 4, '0') ELSE numero::text END`,
      ),
    ),
    check('ck_acid_oc_reabertura', sql.raw(`(tipo_cat = 'REABERTURA') = (reabre_id IS NOT NULL)`)),
    // a sequência é do ANO do protocolo, e o protocolo é do ano do envio
    check('ck_acid_oc_prazo', sql.raw(`prazo_comunicacao = data_evento + 10`)),
    check(
      'ck_acid_oc_prorrogacao',
      sql.raw(
        `prazo_prorrogado_ate IS NULL OR (prorrogacao_motivo IS NOT NULL AND prorrogado_por IS NOT NULL ` +
          `AND prorrogado_em IS NOT NULL AND prazo_prorrogado_ate > prazo_comunicacao)`,
      ),
    ),
    check('ck_acid_oc_cancelamento_motivo', em('cancelamento_motivo', MOTIVOS_CANCELAMENTO)),
    check(
      'ck_acid_oc_cancelada',
      sql.raw(`(estado = 'CANCELADA') = (cancelamento_motivo IS NOT NULL)`),
    ),
    check('ck_acid_oc_concluida', sql.raw(`estado <> 'CONCLUIDA' OR concluida_em IS NOT NULL`)),
    check('ck_acid_oc_uf', sql.raw(`local_uf IS NULL OR local_uf ~ '^[A-Z]{2}$'`)),
    check('ck_acid_oc_minutos', sql.raw(`minutos_apos_inicio_jornada IS NULL OR minutos_apos_inicio_jornada >= 0`)),
    check('ck_acid_oc_versao_cat', sql.raw(`cat_sp_versao >= 0 AND versao >= 1`)),
    unique('uq_acid_oc_protocolo').on(t.protocolo),
    unique('uq_acid_oc_numero').on(t.ano, t.numero),
    index('ix_acid_oc_estado').on(t.estado),
    index('ix_acid_oc_data').on(t.data_evento),
    index('ix_acid_oc_servidor').on(t.servidor_id),
    index('ix_acid_oc_campus').on(t.campus_id),
    index('ix_acid_oc_responsavel').on(t.responsavel_id),
  ],
);

/**
 * A CAT/SP: o documento da comunicação, versionado e APPEND-ONLY (3 triggers).
 * Guarda permanente. A versão 1 nasce com a ocorrência; a resposta a um pedido
 * de complementação e a retificação da equipe geram a N+1, com motivo e
 * `substitui_id`. O `contexto_congelado` tem os fatos do evento, os
 * acidentados, as testemunhas, o comunicante e — em chave SEPARADA — as
 * declarações de saúde, para a variante sem saúde do relatório poder cortá-la.
 */
export const acidente_cat_sp = pgTable(
  'acidente_cat_sp',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    ocorrencia_id: integer('ocorrencia_id').notNull(),
    versao: integer('versao').notNull(),
    contexto_congelado: JSONTexto('contexto_congelado').notNull(),
    // SHA-256 da serialização canônica do contexto (64 hexadecimais)
    hash_conteudo: varchar('hash_conteudo', { length: 64 }).notNull(),
    motivo_retificacao: text('motivo_retificacao'),
    substitui_id: integer('substitui_id'),
    origem: varchar('origem', { length: 16 }).notNull(),
    // anulável: o formulário por link não tem usuário
    registrada_por: integer('registrada_por'),
    registrada_em: MomentoUTC('registrada_em').notNull().$defaultFn(agora_utc),
  },
  (t) => [
    primaryKey({ name: 'pk_acidente_cat_sp', columns: [t.id] }),
    foreignKey({ name: 'fk_acid_cat_ocorrencia', columns: [t.ocorrencia_id], foreignColumns: [acidente_ocorrencia.id] }),
    foreignKey({ name: 'fk_acid_cat_substitui', columns: [t.substitui_id], foreignColumns: [t.id] }),
    foreignKey({ name: 'fk_acid_cat_registrada_por', columns: [t.registrada_por], foreignColumns: [usuario.id] }),
    check('ck_acid_cat_origem', em('origem', ORIGENS_CAT_SP)),
    check_regex('ck_acid_cat_hash', 'hash_conteudo', '[0-9a-f]{64}'),
    check('ck_acid_cat_versao', sql.raw(`versao >= 1`)),
    // a versão 1 não substitui ninguém; da 2 em diante há o motivo e quem foi substituída
    check(
      'ck_acid_cat_retificacao',
      sql.raw(
        `(versao = 1 AND substitui_id IS NULL) OR ` +
          `(versao > 1 AND substitui_id IS NOT NULL AND motivo_retificacao IS NOT NULL)`,
      ),
    ),
    unique('uq_acid_cat_versao').on(t.ocorrencia_id, t.versao),
    index('ix_acid_cat_ocorrencia').on(t.ocorrencia_id),
  ],
);

// ---------------------------------------------------------------------
// Quem se acidentou, quem viu, quem comunicou
// ---------------------------------------------------------------------
/**
 * Um envolvido na ocorrência (a ocorrência pode ter vários). Linha permanente,
 * sem DELETE. Do servidor cadastrado vêm, congelados no ato, o cargo, a função,
 * a lotação, o campus e o SIAPE; para quem não é servidor, só o nome, a
 * identificação externa (matrícula ou crachá, NUNCA CPF) e o vínculo (D14c).
 */
export const acidentado = pgTable(
  'acidentado',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    ocorrencia_id: integer('ocorrencia_id').notNull(),
    ordem: integer('ordem').notNull(),
    vinculo: varchar('vinculo', { length: 14 }).notNull(),
    // exatamente UMA das três identificações
    servidor_id: integer('servidor_id'),
    participante_id: integer('participante_id'),
    nome_externo: varchar('nome_externo', { length: 160 }),
    // matrícula ou crachá; o CHECK recusa o que tem formato de CPF
    identificacao_externa: varchar('identificacao_externa', { length: 40 }),
    empresa_contratada: varchar('empresa_contratada', { length: 160 }),
    fiscal_contrato_servidor_id: integer('fiscal_contrato_servidor_id'),
    condicao: varchar('condicao', { length: 24 }).notNull(),
    houve_lesao: varchar('houve_lesao', { length: 8 }),
    // snapshot do servidor no ato
    cargo_id: integer('cargo_id'),
    funcao: varchar('funcao', { length: 120 }),
    unidade_uorg_id: integer('unidade_uorg_id'),
    campus_id: integer('campus_id'),
    siape: varchar('siape', { length: 7 }),
    // e-mail institucional ou ramal, só para a investigação chegar até a pessoa
    contato_investigacao: varchar('contato_investigacao', { length: 160 }),
    // D14a: menor de idade registrado, sinalizado e restrito à SST; o
    // responsável legal é pedido (a data do pedido fica aqui)
    menor_de_idade: boolean('menor_de_idade').notNull().default(false),
    responsavel_legal_solicitado_em: MomentoUTC('responsavel_legal_solicitado_em'),
    criado_em: MomentoUTC('criado_em').notNull().$defaultFn(agora_utc),
  },
  (t) => [
    primaryKey({ name: 'pk_acidentado', columns: [t.id] }),
    foreignKey({ name: 'fk_acidentado_ocorrencia', columns: [t.ocorrencia_id], foreignColumns: [acidente_ocorrencia.id] }),
    foreignKey({ name: 'fk_acidentado_servidor', columns: [t.servidor_id], foreignColumns: [servidor.id] }),
    foreignKey({ name: 'fk_acidentado_participante', columns: [t.participante_id], foreignColumns: [participante.id] }),
    foreignKey({
      name: 'fk_acidentado_fiscal',
      columns: [t.fiscal_contrato_servidor_id],
      foreignColumns: [servidor.id],
    }),
    foreignKey({ name: 'fk_acidentado_cargo', columns: [t.cargo_id], foreignColumns: [cargo.id] }),
    foreignKey({ name: 'fk_acidentado_unidade', columns: [t.unidade_uorg_id], foreignColumns: [unidade_uorg.id] }),
    foreignKey({ name: 'fk_acidentado_campus', columns: [t.campus_id], foreignColumns: [campus.id] }),
    check('ck_acidentado_vinculo', em('vinculo', VINCULOS_ACIDENTADO)),
    check('ck_acidentado_condicao', em('condicao', CONDICOES_ENVOLVIDO)),
    check('ck_acidentado_lesao', em('houve_lesao', SIM_NAO_NAO_SEI)),
    check_regex('ck_acidentado_siape', 'siape', PADRAO_SIAPE),
    // exatamente uma identificação: servidor, participante ou nome externo
    check(
      'ck_acidentado_identificacao',
      sql.raw(
        `(servidor_id IS NOT NULL)::int + (participante_id IS NOT NULL)::int + (nome_externo IS NOT NULL)::int = 1`,
      ),
    ),
    // CPF não entra (ROPA §4.3): nem com pontuação, nem só com os 11 dígitos
    check(
      'ck_acidentado_sem_cpf',
      sql.raw(
        `identificacao_externa !~ '${ancorar(String.raw`[0-9]{3}\.?[0-9]{3}\.?[0-9]{3}-?[0-9]{2}`)}'`,
      ),
    ),
    check('ck_acidentado_ordem', sql.raw(`ordem >= 1`)),
    unique('uq_acidentado_ordem').on(t.ocorrencia_id, t.ordem),
    index('ix_acidentado_ocorrencia').on(t.ocorrencia_id),
    index('ix_acidentado_servidor').on(t.servidor_id),
  ],
);

/** Testemunha: nome, vínculo e contato; SEM endereço (o legado pedia). Sem DELETE. */
export const acidente_testemunha = pgTable(
  'acidente_testemunha',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    ocorrencia_id: integer('ocorrencia_id').notNull(),
    nome: varchar('nome', { length: 160 }).notNull(),
    vinculo: varchar('vinculo', { length: 14 }),
    servidor_id: integer('servidor_id'),
    contato: varchar('contato', { length: 160 }),
  },
  (t) => [
    primaryKey({ name: 'pk_acidente_testemunha', columns: [t.id] }),
    foreignKey({ name: 'fk_acid_test_ocorrencia', columns: [t.ocorrencia_id], foreignColumns: [acidente_ocorrencia.id] }),
    foreignKey({ name: 'fk_acid_test_servidor', columns: [t.servidor_id], foreignColumns: [servidor.id] }),
    check('ck_acid_test_vinculo', em('vinculo', VINCULOS_ACIDENTADO)),
    index('ix_acid_test_ocorrencia').on(t.ocorrencia_id),
  ],
);

/**
 * Quem comunicou: a conta logada, ou (formulário por link) nome, e-mail e
 * vínculo. A base legal é a obrigação legal / política pública (LGPD art. 7º,
 * II e III; D14b). O IP do público é expurgado em 90 dias pela rotina.
 */
export const acidente_comunicante = pgTable(
  'acidente_comunicante',
  {
    ocorrencia_id: integer('ocorrencia_id').notNull(),
    usuario_id: integer('usuario_id'),
    nome: varchar('nome', { length: 160 }),
    email: varchar('email', { length: 160 }),
    vinculo: varchar('vinculo', { length: 14 }),
    declarou_veracidade_em: MomentoUTC('declarou_veracidade_em').notNull(),
    ip: text('ip'),
  },
  (t) => [
    primaryKey({ name: 'pk_acidente_comunicante', columns: [t.ocorrencia_id] }),
    foreignKey({ name: 'fk_acid_com_ocorrencia', columns: [t.ocorrencia_id], foreignColumns: [acidente_ocorrencia.id] }),
    foreignKey({ name: 'fk_acid_com_usuario', columns: [t.usuario_id], foreignColumns: [usuario.id] }),
    check('ck_acid_com_vinculo', em('vinculo', VINCULOS_ACIDENTADO)),
    // sem conta, a pessoa se identifica pelo nome e pelo e-mail
    check('ck_acid_com_identificado', sql.raw(`usuario_id IS NOT NULL OR (nome IS NOT NULL AND email IS NOT NULL)`)),
  ],
);

/**
 * O pedido de complementação e a resposta. O texto do que falta é do pedido; a
 * resposta vira uma versão nova da CAT/SP (`resposta_cat_sp_id`). A linha é
 * preenchida uma vez (a resposta), e nunca apagada.
 */
export const acidente_complementacao = pgTable(
  'acidente_complementacao',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    ocorrencia_id: integer('ocorrencia_id').notNull(),
    pedido_texto: text('pedido_texto').notNull(),
    pedido_por: integer('pedido_por').notNull(),
    pedido_em: MomentoUTC('pedido_em').notNull().$defaultFn(agora_utc),
    resposta_cat_sp_id: integer('resposta_cat_sp_id'),
    respondida_por: integer('respondida_por'),
    respondida_em: MomentoUTC('respondida_em'),
  },
  (t) => [
    primaryKey({ name: 'pk_acidente_complementacao', columns: [t.id] }),
    foreignKey({ name: 'fk_acid_compl_ocorrencia', columns: [t.ocorrencia_id], foreignColumns: [acidente_ocorrencia.id] }),
    foreignKey({ name: 'fk_acid_compl_pedido_por', columns: [t.pedido_por], foreignColumns: [usuario.id] }),
    foreignKey({ name: 'fk_acid_compl_resposta', columns: [t.resposta_cat_sp_id], foreignColumns: [acidente_cat_sp.id] }),
    foreignKey({ name: 'fk_acid_compl_respondida_por', columns: [t.respondida_por], foreignColumns: [usuario.id] }),
    check(
      'ck_acid_compl_resposta',
      sql.raw(`(resposta_cat_sp_id IS NULL) = (respondida_em IS NULL)`),
    ),
    index('ix_acid_compl_ocorrencia').on(t.ocorrencia_id),
  ],
);

// ---------------------------------------------------------------------
// Saúde — dado sensível, dois níveis (ROPA §4.4)
// ---------------------------------------------------------------------
/**
 * O núcleo de saúde do acidentado. Lido SÓ por `acidente_saude.ler` (serviço
 * único), que exige a finalidade e grava `acesso_dado_sensivel` a cada abertura.
 *
 * - **Nível 1** (`acidente.saude_ver`): natureza da lesão (catálogo), partes do
 *   corpo (`acidente_saude_parte`), lateralidade e os fatos SIM/NÃO/NÃO SEI;
 * - **Nível 2** (`acidente.saude_detalhe_ver`): dias, datas e primeiro socorro.
 *
 * `origem` diz de quem veio: o comunicante declara parte do corpo e os fatos
 * (D4), e o médico do trabalho confirma e completa. Sem DELETE; o expurgo
 * parcial do nível 2 é ato manual com simulação, e a trigger só deixa o nível 2
 * ir a NULL junto do carimbo `detalhe_expurgado_em`.
 */
export const acidente_saude = pgTable(
  'acidente_saude',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    acidentado_id: integer('acidentado_id').notNull(),
    // --- nível 1 ---
    natureza_lesao_id: integer('natureza_lesao_id'),
    lateralidade: varchar('lateralidade', { length: 14 }),
    houve_atendimento: varchar('houve_atendimento', { length: 8 }),
    houve_afastamento: varchar('houve_afastamento', { length: 8 }),
    houve_internacao: varchar('houve_internacao', { length: 8 }),
    houve_obito: varchar('houve_obito', { length: 8 }),
    houve_sequela: varchar('houve_sequela', { length: 8 }),
    // --- nível 2 (os nomes estão em `COLUNAS_SAUDE_NIVEL_2`) ---
    dias_afastamento: integer('dias_afastamento'),
    afastamento_inicio: DataPura('afastamento_inicio'),
    afastamento_retorno: DataPura('afastamento_retorno'),
    dias_internacao: integer('dias_internacao'),
    data_obito: DataPura('data_obito'),
    dias_debitados: integer('dias_debitados'),
    primeiro_socorro_por: varchar('primeiro_socorro_por', { length: 120 }),
    primeiro_socorro_unidade: varchar('primeiro_socorro_unidade', { length: 160 }),
    atendimento_em: MomentoUTC('atendimento_em'),
    origem: varchar('origem', { length: 24 }).notNull(),
    registrado_por: integer('registrado_por'),
    registrado_em: MomentoUTC('registrado_em').notNull().$defaultFn(agora_utc),
    detalhe_expurgado_em: MomentoUTC('detalhe_expurgado_em'),
    versao: integer('versao').notNull().default(1),
  },
  (t) => [
    primaryKey({ name: 'pk_acidente_saude', columns: [t.id] }),
    foreignKey({ name: 'fk_acid_saude_acidentado', columns: [t.acidentado_id], foreignColumns: [acidentado.id] }),
    foreignKey({ name: 'fk_acid_saude_natureza', columns: [t.natureza_lesao_id], foreignColumns: [acidente_natureza_lesao.id] }),
    foreignKey({ name: 'fk_acid_saude_registrado_por', columns: [t.registrado_por], foreignColumns: [usuario.id] }),
    check('ck_acid_saude_origem', em('origem', ORIGENS_SAUDE)),
    check('ck_acid_saude_lateralidade', em('lateralidade', LATERALIDADES)),
    check('ck_acid_saude_atendimento', em('houve_atendimento', SIM_NAO_NAO_SEI)),
    check('ck_acid_saude_afastamento', em('houve_afastamento', SIM_NAO_NAO_SEI)),
    check('ck_acid_saude_internacao', em('houve_internacao', SIM_NAO_NAO_SEI)),
    check('ck_acid_saude_obito', em('houve_obito', SIM_NAO_NAO_SEI)),
    check('ck_acid_saude_sequela', em('houve_sequela', SIM_NAO_NAO_SEI)),
    check('ck_acid_saude_dias', sql.raw(
      `COALESCE(dias_afastamento, 0) >= 0 AND COALESCE(dias_internacao, 0) >= 0 AND COALESCE(dias_debitados, 0) >= 0`,
    )),
    check(
      'ck_acid_saude_retorno',
      sql.raw(`afastamento_retorno IS NULL OR afastamento_inicio IS NULL OR afastamento_retorno >= afastamento_inicio`),
    ),
    // a data do óbito só existe onde há óbito
    check('ck_acid_saude_data_obito', sql.raw(`data_obito IS NULL OR houve_obito = 'SIM'`)),
    unique('uq_acid_saude_acidentado').on(t.acidentado_id),
  ],
);

/** As partes do corpo atingidas (N:N com o catálogo); nível 1 de saúde. */
export const acidente_saude_parte = pgTable(
  'acidente_saude_parte',
  {
    saude_id: integer('saude_id').notNull(),
    parte_corpo_id: integer('parte_corpo_id').notNull(),
  },
  (t) => [
    primaryKey({ name: 'pk_acidente_saude_parte', columns: [t.saude_id, t.parte_corpo_id] }),
    foreignKey({ name: 'fk_acid_sparte_saude', columns: [t.saude_id], foreignColumns: [acidente_saude.id] }),
    foreignKey({ name: 'fk_acid_sparte_parte', columns: [t.parte_corpo_id], foreignColumns: [acidente_parte_corpo.id] }),
  ],
);

// ---------------------------------------------------------------------
// Investigação técnica (MAPA)
// ---------------------------------------------------------------------
/**
 * A análise MAPA da ocorrência (uma por ocorrência). Editável até haver
 * relatório; depois, só para uma versão nova do relatório (retificação). O
 * controle é otimista (`versao`; D8): rascunho local mais "Salvar", e o
 * conflito dá 409. O nexo causal NÃO está aqui — é da perícia
 * (`acidente_decisao_pericial`); `caracterizacao` é o parecer técnico da CSSO.
 */
export const acidente_investigacao = pgTable(
  'acidente_investigacao',
  {
    ocorrencia_id: integer('ocorrencia_id').notNull(),
    responsavel_id: integer('responsavel_id'),
    equipe: text('equipe'),
    objetivo: text('objetivo'),
    trabalho_habitual: text('trabalho_habitual'),
    prescrito_real: text('prescrito_real'),
    mudanca_individuo: text('mudanca_individuo'),
    mudanca_tarefa: text('mudanca_tarefa'),
    mudanca_material: text('mudanca_material'),
    mudanca_meio: text('mudanca_meio'),
    relatos_campo: text('relatos_campo'),
    evidencias_texto: text('evidencias_texto'),
    sintese: text('sintese'),
    ampliacao_conceitual: text('ampliacao_conceitual'),
    ambiente_fator: varchar('ambiente_fator', { length: 8 }),
    caracterizacao: varchar('caracterizacao', { length: 14 }),
    requer_cat_siass: varchar('requer_cat_siass', { length: 8 }),
    recomendacoes: text('recomendacoes'),
    versao: integer('versao').notNull().default(1),
    atualizado_por: integer('atualizado_por'),
    atualizado_em: MomentoUTC('atualizado_em').notNull().$defaultFn(agora_utc),
  },
  (t) => [
    primaryKey({ name: 'pk_acidente_investigacao', columns: [t.ocorrencia_id] }),
    foreignKey({ name: 'fk_acid_inv_ocorrencia', columns: [t.ocorrencia_id], foreignColumns: [acidente_ocorrencia.id] }),
    foreignKey({ name: 'fk_acid_inv_responsavel', columns: [t.responsavel_id], foreignColumns: [usuario.id] }),
    foreignKey({ name: 'fk_acid_inv_atualizado_por', columns: [t.atualizado_por], foreignColumns: [usuario.id] }),
    check('ck_acid_inv_ambiente', em('ambiente_fator', SIM_NAO_NAO_SEI)),
    check('ck_acid_inv_caracterizacao', em('caracterizacao', CARACTERIZACAO)),
    check('ck_acid_inv_requer', em('requer_cat_siass', SIM_NAO_NAO_SEI)),
  ],
);

/** A linha do tempo, estruturada (no legado era um texto livre). Desativa-se, não se apaga. */
export const acidente_evento_linha = pgTable(
  'acidente_evento_linha',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    ocorrencia_id: integer('ocorrencia_id').notNull(),
    // data e hora, ou um rótulo relativo ("T-10min")
    momento: varchar('momento', { length: 40 }).notNull(),
    descricao: text('descricao').notNull(),
    ordem: integer('ordem').notNull().default(1),
    ativo: boolean('ativo').notNull().default(true),
  },
  (t) => [
    primaryKey({ name: 'pk_acidente_evento_linha', columns: [t.id] }),
    foreignKey({ name: 'fk_acid_linha_ocorrencia', columns: [t.ocorrencia_id], foreignColumns: [acidente_ocorrencia.id] }),
    index('ix_acid_linha_ocorrencia').on(t.ocorrencia_id),
  ],
);

export const acidente_barreira = pgTable(
  'acidente_barreira',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    ocorrencia_id: integer('ocorrencia_id').notNull(),
    tipo: varchar('tipo', { length: 16 }).notNull(),
    situacao: varchar('situacao', { length: 20 }).notNull(),
    descricao: text('descricao').notNull(),
    ativo: boolean('ativo').notNull().default(true),
  },
  (t) => [
    primaryKey({ name: 'pk_acidente_barreira', columns: [t.id] }),
    foreignKey({ name: 'fk_acid_barr_ocorrencia', columns: [t.ocorrencia_id], foreignColumns: [acidente_ocorrencia.id] }),
    check('ck_acid_barr_tipo', em('tipo', TIPOS_BARREIRA)),
    check('ck_acid_barr_situacao', em('situacao', SITUACOES_BARREIRA)),
    index('ix_acid_barr_ocorrencia').on(t.ocorrencia_id),
  ],
);

/** O checklist de campo (seções 0 a 8), gerado da base no primeiro acesso. */
export const acidente_checklist_item = pgTable(
  'acidente_checklist_item',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    ocorrencia_id: integer('ocorrencia_id').notNull(),
    secao: smallint('secao').notNull(),
    ordem: integer('ordem').notNull(),
    texto: text('texto').notNull(),
    marcado: boolean('marcado').notNull().default(false),
    observacao: text('observacao'),
    origem: varchar('origem', { length: 12 }).notNull(),
    ativo: boolean('ativo').notNull().default(true),
  },
  (t) => [
    primaryKey({ name: 'pk_acidente_checklist_item', columns: [t.id] }),
    foreignKey({ name: 'fk_acid_check_ocorrencia', columns: [t.ocorrencia_id], foreignColumns: [acidente_ocorrencia.id] }),
    check('ck_acid_check_secao', sql.raw(`secao BETWEEN 0 AND 8`)),
    check('ck_acid_check_origem', em('origem', ORIGENS_CHECKLIST)),
    index('ix_acid_check_ocorrencia').on(t.ocorrencia_id),
  ],
);

/**
 * Entrevista de campo. O relato é DADO DE TERCEIRO, de guarda permanente e
 * acesso restrito e auditado. A gravação só existe com o consentimento
 * registrado (quem consentiu, quando, quem registrou).
 */
export const acidente_entrevista = pgTable(
  'acidente_entrevista',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    ocorrencia_id: integer('ocorrencia_id').notNull(),
    entrevistado_nome: varchar('entrevistado_nome', { length: 160 }).notNull(),
    entrevistado_vinculo: varchar('entrevistado_vinculo', { length: 14 }),
    realizada_em: MomentoUTC('realizada_em'),
    entrevistadores: text('entrevistadores'),
    relato: text('relato'),
    consentiu_gravacao: boolean('consentiu_gravacao').notNull().default(false),
    consentimento_registrado_por: integer('consentimento_registrado_por'),
    anexo_audio_id: integer('anexo_audio_id'),
    criada_em: MomentoUTC('criada_em').notNull().$defaultFn(agora_utc),
  },
  (t) => [
    primaryKey({ name: 'pk_acidente_entrevista', columns: [t.id] }),
    foreignKey({ name: 'fk_acid_entr_ocorrencia', columns: [t.ocorrencia_id], foreignColumns: [acidente_ocorrencia.id] }),
    foreignKey({ name: 'fk_acid_entr_consentimento', columns: [t.consentimento_registrado_por], foreignColumns: [usuario.id] }),
    foreignKey({ name: 'fk_acid_entr_audio', columns: [t.anexo_audio_id], foreignColumns: [anexo.id] }),
    check('ck_acid_entr_vinculo', em('entrevistado_vinculo', VINCULOS_ACIDENTADO)),
    // áudio só com consentimento, e com quem o registrou
    check(
      'ck_acid_entr_audio',
      sql.raw(`anexo_audio_id IS NULL OR (consentiu_gravacao AND consentimento_registrado_por IS NOT NULL)`),
    ),
    index('ix_acid_entr_ocorrencia').on(t.ocorrencia_id),
  ],
);

/** O arquivo de evidência da investigação (anexo `EVIDENCIA_ACIDENTE`, restrito). */
export const acidente_evidencia = pgTable(
  'acidente_evidencia',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    ocorrencia_id: integer('ocorrencia_id').notNull(),
    anexo_id: integer('anexo_id').notNull(),
    descricao: text('descricao'),
    // marcada na emissão do relatório; a não citada tem retenção de 5 anos
    citada_no_relatorio: boolean('citada_no_relatorio').notNull().default(false),
  },
  (t) => [
    primaryKey({ name: 'pk_acidente_evidencia', columns: [t.id] }),
    foreignKey({ name: 'fk_acid_evid_ocorrencia', columns: [t.ocorrencia_id], foreignColumns: [acidente_ocorrencia.id] }),
    foreignKey({ name: 'fk_acid_evid_anexo', columns: [t.anexo_id], foreignColumns: [anexo.id] }),
    unique('uq_acid_evid_anexo').on(t.ocorrencia_id, t.anexo_id),
    index('ix_acid_evid_ocorrencia').on(t.ocorrencia_id),
  ],
);

/** Onde o servidor se expôs, para a espécie DOENCA_TRABALHO. */
export const acidente_unidade_exposicao = pgTable(
  'acidente_unidade_exposicao',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    ocorrencia_id: integer('ocorrencia_id').notNull(),
    unidade_uorg_id: integer('unidade_uorg_id').notNull(),
    posto_trabalho_id: integer('posto_trabalho_id'),
    inicio: DataPura('inicio'),
    fim: DataPura('fim'),
  },
  (t) => [
    primaryKey({ name: 'pk_acidente_unidade_exposicao', columns: [t.id] }),
    foreignKey({ name: 'fk_acid_expo_ocorrencia', columns: [t.ocorrencia_id], foreignColumns: [acidente_ocorrencia.id] }),
    foreignKey({ name: 'fk_acid_expo_unidade', columns: [t.unidade_uorg_id], foreignColumns: [unidade_uorg.id] }),
    foreignKey({ name: 'fk_acid_expo_posto', columns: [t.posto_trabalho_id], foreignColumns: [posto_trabalho.id] }),
    check('ck_acid_expo_periodo', sql.raw(`fim IS NULL OR inicio IS NULL OR fim >= inicio`)),
    index('ix_acid_expo_ocorrencia').on(t.ocorrencia_id),
  ],
);

// ---------------------------------------------------------------------
// Plano de ação
// ---------------------------------------------------------------------
/**
 * Uma ação do plano. No legado `savePlano` apagava as linhas do caso e as
 * regravava, e o ID mudava a cada salvamento. Aqui o ID é estável, o número é
 * sequencial no caso, a mudança leva diff na trilha, a conclusão tem evidência
 * (anexo) e nunca há DELETE. Cancelar exige motivo.
 */
export const acidente_acao = pgTable(
  'acidente_acao',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    ocorrencia_id: integer('ocorrencia_id').notNull(),
    numero: integer('numero').notNull(),
    achado: text('achado'),
    acao: text('acao').notNull(),
    tipo_acao: varchar('tipo_acao', { length: 24 }).notNull(),
    responsavel_usuario_id: integer('responsavel_usuario_id'),
    responsavel_unidade_uorg_id: integer('responsavel_unidade_uorg_id'),
    responsavel_texto: varchar('responsavel_texto', { length: 160 }),
    prazo: DataPura('prazo'),
    prioridade: varchar('prioridade', { length: 8 }).notNull().default('MEDIA'),
    estado: varchar('estado', { length: 16 }).notNull().default('PENDENTE'),
    conclusao_texto: text('conclusao_texto'),
    conclusao_anexo_id: integer('conclusao_anexo_id'),
    concluida_em: MomentoUTC('concluida_em'),
    cancelamento_motivo: text('cancelamento_motivo'),
    criada_por: integer('criada_por').notNull(),
    criada_em: MomentoUTC('criada_em').notNull().$defaultFn(agora_utc),
    versao: integer('versao').notNull().default(1),
  },
  (t) => [
    primaryKey({ name: 'pk_acidente_acao', columns: [t.id] }),
    foreignKey({ name: 'fk_acid_acao_ocorrencia', columns: [t.ocorrencia_id], foreignColumns: [acidente_ocorrencia.id] }),
    foreignKey({ name: 'fk_acid_acao_resp_usuario', columns: [t.responsavel_usuario_id], foreignColumns: [usuario.id] }),
    foreignKey({
      name: 'fk_acid_acao_resp_unidade',
      columns: [t.responsavel_unidade_uorg_id],
      foreignColumns: [unidade_uorg.id],
    }),
    foreignKey({ name: 'fk_acid_acao_anexo', columns: [t.conclusao_anexo_id], foreignColumns: [anexo.id] }),
    foreignKey({ name: 'fk_acid_acao_criada_por', columns: [t.criada_por], foreignColumns: [usuario.id] }),
    check('ck_acid_acao_tipo', em('tipo_acao', TIPOS_ACAO)),
    check('ck_acid_acao_prioridade', em('prioridade', PRIORIDADES)),
    check('ck_acid_acao_estado', em('estado', ESTADOS_ACAO)),
    check('ck_acid_acao_concluida', sql.raw(`estado <> 'CONCLUIDA' OR concluida_em IS NOT NULL`)),
    check('ck_acid_acao_cancelada', sql.raw(`estado <> 'CANCELADA' OR cancelamento_motivo IS NOT NULL`)),
    unique('uq_acid_acao_numero').on(t.ocorrencia_id, t.numero),
    index('ix_acid_acao_ocorrencia').on(t.ocorrencia_id),
    index('ix_acid_acao_prazo').on(t.prazo),
  ],
);

// ---------------------------------------------------------------------
// Relatório, SIASS e decisão pericial (append-only)
// ---------------------------------------------------------------------
/**
 * O relatório técnico emitido, em PDF gerado no próprio sistema (D3), a partir
 * de `contexto_congelado` com hash. APPEND-ONLY. As duas variantes da mesma
 * versão (COMPLETA para o SIASS, SEM_SAUDE para a contratada e o fiscal) saem no
 * mesmo ato. A retificação gera versão nova com motivo e `substitui_id`; a
 * anterior continua legível, marcada como retificada.
 */
export const acidente_relatorio = pgTable(
  'acidente_relatorio',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    ocorrencia_id: integer('ocorrencia_id').notNull(),
    versao: integer('versao').notNull(),
    variante: varchar('variante', { length: 10 }).notNull(),
    contexto_congelado: JSONTexto('contexto_congelado').notNull(),
    hash_conteudo: varchar('hash_conteudo', { length: 64 }).notNull(),
    anexo_id: integer('anexo_id').notNull(),
    motivo_retificacao: text('motivo_retificacao'),
    substitui_id: integer('substitui_id'),
    emitido_por: integer('emitido_por').notNull(),
    emitido_em: MomentoUTC('emitido_em').notNull().$defaultFn(agora_utc),
  },
  (t) => [
    primaryKey({ name: 'pk_acidente_relatorio', columns: [t.id] }),
    foreignKey({ name: 'fk_acid_rel_ocorrencia', columns: [t.ocorrencia_id], foreignColumns: [acidente_ocorrencia.id] }),
    foreignKey({ name: 'fk_acid_rel_anexo', columns: [t.anexo_id], foreignColumns: [anexo.id] }),
    foreignKey({ name: 'fk_acid_rel_substitui', columns: [t.substitui_id], foreignColumns: [t.id] }),
    foreignKey({ name: 'fk_acid_rel_emitido_por', columns: [t.emitido_por], foreignColumns: [usuario.id] }),
    check('ck_acid_rel_variante', em('variante', VARIANTES_RELATORIO)),
    check_regex('ck_acid_rel_hash', 'hash_conteudo', '[0-9a-f]{64}'),
    check('ck_acid_rel_versao', sql.raw(`versao >= 1`)),
    check(
      'ck_acid_rel_retificacao',
      sql.raw(
        `(versao = 1 AND substitui_id IS NULL) OR ` +
          `(versao > 1 AND substitui_id IS NOT NULL AND motivo_retificacao IS NOT NULL)`,
      ),
    ),
    unique('uq_acid_rel_versao').on(t.ocorrencia_id, t.versao, t.variante),
    index('ix_acid_rel_ocorrencia').on(t.ocorrencia_id),
  ],
);

/** O encaminhamento ao SIASS: data, meio, NUP do SEI e a versão enviada. APPEND-ONLY. */
export const acidente_encaminhamento = pgTable(
  'acidente_encaminhamento',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    ocorrencia_id: integer('ocorrencia_id').notNull(),
    relatorio_id: integer('relatorio_id').notNull(),
    meio: varchar('meio', { length: 20 }).notNull(),
    nup_sei: varchar('nup_sei', { length: 20 }),
    encaminhado_em: DataPura('encaminhado_em').notNull(),
    encaminhado_por: integer('encaminhado_por').notNull(),
    observacao: text('observacao'),
    registrado_em: MomentoUTC('registrado_em').notNull().$defaultFn(agora_utc),
  },
  (t) => [
    primaryKey({ name: 'pk_acidente_encaminhamento', columns: [t.id] }),
    foreignKey({ name: 'fk_acid_enc_ocorrencia', columns: [t.ocorrencia_id], foreignColumns: [acidente_ocorrencia.id] }),
    foreignKey({ name: 'fk_acid_enc_relatorio', columns: [t.relatorio_id], foreignColumns: [acidente_relatorio.id] }),
    foreignKey({ name: 'fk_acid_enc_por', columns: [t.encaminhado_por], foreignColumns: [usuario.id] }),
    check('ck_acid_enc_meio', em('meio', MEIOS_ENCAMINHAMENTO)),
    check_regex('ck_acid_enc_nup', 'nup_sei', PADRAO_NUP),
    index('ix_acid_enc_ocorrencia').on(t.ocorrencia_id),
  ],
);

/**
 * A decisão da perícia oficial. APPEND-ONLY: a correção gera linha nova, que
 * aponta a anterior em `substitui_id`. O número da CAT no SIASS tem campo
 * próprio (D7). A observação NÃO tem a dispensa da palavra "doença" (RN-21).
 */
export const acidente_decisao_pericial = pgTable(
  'acidente_decisao_pericial',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    ocorrencia_id: integer('ocorrencia_id').notNull(),
    resultado: varchar('resultado', { length: 36 }).notNull(),
    decidida_em: DataPura('decidida_em').notNull(),
    numero_cat_siass: varchar('numero_cat_siass', { length: 40 }),
    observacao: text('observacao'),
    registrada_por: integer('registrada_por').notNull(),
    registrada_em: MomentoUTC('registrada_em').notNull().$defaultFn(agora_utc),
    substitui_id: integer('substitui_id'),
  },
  (t) => [
    primaryKey({ name: 'pk_acidente_decisao_pericial', columns: [t.id] }),
    foreignKey({ name: 'fk_acid_dec_ocorrencia', columns: [t.ocorrencia_id], foreignColumns: [acidente_ocorrencia.id] }),
    foreignKey({ name: 'fk_acid_dec_por', columns: [t.registrada_por], foreignColumns: [usuario.id] }),
    foreignKey({ name: 'fk_acid_dec_substitui', columns: [t.substitui_id], foreignColumns: [t.id] }),
    check('ck_acid_dec_resultado', em('resultado', RESULTADOS_PERICIA)),
    index('ix_acid_dec_ocorrencia').on(t.ocorrencia_id),
  ],
);

// ---------------------------------------------------------------------
// O formulário por link (D1: logo depois da primeira entrega, F2)
// ---------------------------------------------------------------------
/**
 * O link com token, no padrão de `/inscricao/:token`: só o SHA-256 do token vai
 * ao banco. Nunca URL aberta. A tabela já nasce na migração desta fundação para
 * a F2 não precisar de migração própria (migrações paralelas colidem).
 */
export const acidente_link_publico = pgTable(
  'acidente_link_publico',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    // nulo = link geral; com valor, o campus recorta a ocorrência
    campus_id: integer('campus_id'),
    token_sha256: varchar('token_sha256', { length: 64 }).notNull(),
    ativo: boolean('ativo').notNull().default(true),
    gerado_por: integer('gerado_por').notNull(),
    gerado_em: MomentoUTC('gerado_em').notNull().$defaultFn(agora_utc),
    desligado_em: MomentoUTC('desligado_em'),
  },
  (t) => [
    primaryKey({ name: 'pk_acidente_link_publico', columns: [t.id] }),
    foreignKey({ name: 'fk_acid_link_campus', columns: [t.campus_id], foreignColumns: [campus.id] }),
    foreignKey({ name: 'fk_acid_link_gerado_por', columns: [t.gerado_por], foreignColumns: [usuario.id] }),
    check_regex('ck_acid_link_token', 'token_sha256', '[0-9a-f]{64}'),
    check('ck_acid_link_desligado', sql.raw(`ativo = (desligado_em IS NULL)`)),
    unique('uq_acid_link_token').on(t.token_sha256),
  ],
);
