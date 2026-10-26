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
  time,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import {
  ALFABETO_IDENTIFICADOR,
  type ArquivoEnviado,
  ORIENTACOES,
  ORIGENS_EMAIL,
  ORIGENS_INSCRICAO,
  PADRAO_CHAVE_VALIDACAO,
  PADRAO_CODIGO_CURTO,
  PADRAO_CODIGO_TREINAMENTO,
  PADRAO_NUMERO_IMPRESSO,
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
  PADRAO_CODIGO_CURTO,
  PADRAO_CODIGO_TREINAMENTO,
  PADRAO_NUMERO_IMPRESSO,
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
    // NUVEM (22/10/2026): o codigo curto que entra no numero do certificado
    // (`CSSO-NR35-2026-0001`). Obrigatorio; o '' do padrao nunca fica gravado:
    // a trava `csso_treinamento_codigo_curto` (travas.sql) poe a sugestao no
    // lugar, pela mesma regra de `sugerir_codigo_curto`.
    codigo_curto: varchar('codigo_curto', { length: 10 }).notNull().default(''),
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
    // NUVEM (23/10/2026): o DONO do treinamento — a conta que o cadastrou
    // (`servicos/dono_turma.ts`). Nulo = "sem dono" (cadastrado antes da regra,
    // sem evento de criação na trilha): só a hierarquia superior altera. O
    // mesmo nome da coluna de `turma`, que já existia.
    criado_por: integer('criado_por'),
  },
  (t) => [
    // nomes da migracao `certificados_catalogo_de_treinamentos` (no modelo as
    // duas UNIQUE estavam como `unique=True` sem nome)
    primaryKey({ name: 'pk_treinamento', columns: [t.id] }),
    unique('uq_treinamento_codigo').on(t.codigo),
    unique('uq_treinamento_nome').on(t.nome),
    unique('uq_treinamento_codigo_curto').on(t.codigo_curto),
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
    foreignKey({ name: 'fk_treinamento_criado_por', columns: [t.criado_por], foreignColumns: [usuario.id] }),
    check('ck_treinamento_validade', sql.raw(`validade_meses >= 0`)),
    check('ck_treinamento_carga', sql.raw(`carga_horaria_horas > 0`)),
    check_regex('ck_treinamento_codigo', 'codigo', PADRAO_CODIGO_TREINAMENTO),
    check_regex('ck_treinamento_codigo_curto', 'codigo_curto', PADRAO_CODIGO_CURTO),
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
    // NUVEM: .docx enviado pela tela (convertido, marcadores e trecho de cada
    // um); NULL = arquivo embutido em modelos-docx/certificados/
    arquivo_enviado: JSONTexto<ArquivoEnviado>('arquivo_enviado'),
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
 *
 * NUVEM: `tipo` diz de onde vem o valor. SISTEMA usa `campo`; TEXTO_FIXO usa
 * `texto_fixo` (vale para todo certificado do modelo); TURMA e PARTICIPANTE
 * sao campos que o modelo declara com `rotulo` e cada turma (ou cada
 * inscricao) preenche — os valores moram em `certificado_valor_turma` e
 * `certificado_valor_inscricao`. Fora de SISTEMA, `campo` fica vazio.
 */
export const certificado_modelo_tag = pgTable(
  'certificado_modelo_tag',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    modelo_id: integer('modelo_id').notNull(),
    marcador: varchar('marcador', { length: 60 }).notNull(),
    campo: varchar('campo', { length: 60 }).notNull().default(''),
    ordem: smallint('ordem').notNull().default(1),
    // vazio neste campo bloqueia a emissao, como DadosIncompletos no parecer
    obrigatorio: boolean('obrigatorio').notNull().default(true),
    tipo: varchar('tipo', { length: 12 }).notNull().default('SISTEMA'),
    texto_fixo: text('texto_fixo'),
    rotulo: varchar('rotulo', { length: 120 }),
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
    check('ck_modelo_tag_tipo', sql.raw(`tipo IN ('SISTEMA','TEXTO_FIXO','TURMA','PARTICIPANTE')`)),
    check('ck_modelo_tag_campo', sql.raw(`tipo <> 'SISTEMA' OR campo <> ''`)),
    check('ck_modelo_tag_rotulo', sql.raw(`tipo NOT IN ('TURMA','PARTICIPANTE') OR rotulo IS NOT NULL`)),
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
    // CPF do responsavel pela formacao, so para o certificado que o exige; so
    // digitos, nunca exibido (ver `servicos/cpf_certificado.ts`)
    cpf: varchar('cpf', { length: 11 }),
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
    check_regex('ck_assinatura_cpf', 'cpf', '[0-9]{11}'),
    // `externo = 1` no SQLite; booleano usado como booleano aqui
    check('ck_assinatura_vinculo', sql.raw(`externo OR servidor_id IS NOT NULL`)),
    check(
      'ck_assinatura_periodo',
      sql.raw(`vigencia_fim IS NULL OR vigencia_fim >= vigencia_inicio`),
    ),
    index('ix_assinatura_ativo').on(t.ativo),
  ],
);

/**
 * NUVEM (24/10/2026): a qualificacao do instrutor — a formacao que o habilita a
 * ministrar um treinamento (NR-10, NR-33 e NR-35 cobram que o instrutor seja
 * comprovadamente qualificado). Habilita um treinamento do catalogo
 * (`treinamento_id`), uma norma (`norma`, comparada com
 * `treinamento.norma_referencia` por `servicos/qualificacao_instrutor.ts`), ou
 * os dois. `valida_ate` nulo = sem validade.
 *
 * O comprovante (PDF ou imagem) e anexo `QUALIFICACAO_INSTRUTOR`, RESTRITO, que
 * so quem gerencia instrutores baixa (`anexo_acesso.ts`). A coluna e nula so no
 * instante entre o INSERT e o anexo, que pede o id da linha; a rota grava os
 * dois na mesma transacao e recusa o cadastro sem arquivo.
 *
 * Nao se apaga: inativa (quem e quando), e a trilha guarda o cadastro.
 */
export const instrutor_qualificacao = pgTable(
  'instrutor_qualificacao',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    instrutor_id: integer('instrutor_id').notNull(),
    // "Formacao de instrutor NR-35", como esta no comprovante
    descricao: varchar('descricao', { length: 200 }).notNull(),
    treinamento_id: integer('treinamento_id'),
    norma: varchar('norma', { length: 120 }),
    instituicao: varchar('instituicao', { length: 160 }).notNull(),
    data_emissao: DataPura('data_emissao').notNull(),
    valida_ate: DataPura('valida_ate'),
    comprovante_anexo_id: integer('comprovante_anexo_id'),
    ativo: boolean('ativo').notNull().default(true),
    criado_por: integer('criado_por').notNull(),
    criado_em: MomentoUTC('criado_em').notNull().$defaultFn(agora_utc),
    inativado_por: integer('inativado_por'),
    inativado_em: MomentoUTC('inativado_em'),
  },
  (t) => [
    primaryKey({ name: 'pk_instrutor_qualificacao', columns: [t.id] }),
    foreignKey({
      name: 'fk_qualificacao_instrutor',
      columns: [t.instrutor_id],
      foreignColumns: [assinatura_instrutor.id],
    }),
    foreignKey({
      name: 'fk_qualificacao_treinamento',
      columns: [t.treinamento_id],
      foreignColumns: [treinamento.id],
    }),
    foreignKey({
      name: 'fk_qualificacao_comprovante',
      columns: [t.comprovante_anexo_id],
      foreignColumns: [anexo.id],
    }),
    foreignKey({ name: 'fk_qualificacao_criado_por', columns: [t.criado_por], foreignColumns: [usuario.id] }),
    foreignKey({ name: 'fk_qualificacao_inativado_por', columns: [t.inativado_por], foreignColumns: [usuario.id] }),
    // habilita alguma coisa: um treinamento, uma norma, ou os dois
    check('ck_qualificacao_fim', sql.raw(`treinamento_id IS NOT NULL OR norma IS NOT NULL`)),
    check('ck_qualificacao_validade', sql.raw(`valida_ate IS NULL OR valida_ate >= data_emissao`)),
    check('ck_qualificacao_inativacao', sql.raw(`ativo OR inativado_em IS NOT NULL`)),
    index('ix_qualificacao_instrutor').on(t.instrutor_id),
    index('ix_qualificacao_treinamento').on(t.treinamento_id),
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
 * CPF NAO e chave de identificacao (decisao 1 do coordenador, reafirmada em
 * 23/10/2026). Desde 19/10/2026 existe a coluna `cpf`, opcional, SO para o
 * certificado cuja norma exige o numero (brigadista, CBMMG): nada busca,
 * casa ou compara pessoas por ela, exceto a mesclagem, que RECUSA juntar dois
 * cadastros com CPFs diferentes. O identificador do externo e o e-mail
 * confirmado, que e mutavel — por isso a chave e o `id` e a identidade
 * publica e o `identificador_publico`.
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
    // CPF SO para o certificado que a norma exige (ex.: brigadista, CBMMG),
    // so digitos. Mora aqui, e nao em `servidor`, para servir ao externo e ao
    // servidor sem copia: o participante e uma linha por pessoa. Nunca sai em
    // tela, lista, busca, API ou trilha (ver `servicos/cpf_certificado.ts`).
    cpf: varchar('cpf', { length: 11 }),
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
    // NUVEM (23/10/2026): o externo criado por quem nao le nomes (RN-19)
    // quando ja havia cadastro parecido — a pergunta "e a mesma pessoa?" nao
    // pode ser feita a ele, e o cadastro nasce marcado para quem le nomes
    // conferir (`servicos/duplicados.ts`). Some quando a duvida se resolve.
    suspeita_duplicado_em: MomentoUTC('suspeita_duplicado_em'),
    // NUVEM (23/10/2026): a conta do terceirizado ou do discente (perfis
    // `terceirizado`/`discente`), que não é servidor. É por aqui que a conta se
    // inscreve e lê os próprios certificados; o servidor continua pelo
    // `servidor_id`. Uma conta, um participante.
    usuario_id: integer('usuario_id'),
  },
  (t) => [
    foreignKey({ name: 'fk_participante_usuario', columns: [t.usuario_id], foreignColumns: [usuario.id] }),
    unique('uq_participante_usuario').on(t.usuario_id),
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
    check_regex('ck_participante_cpf', 'cpf', '[0-9]{11}'),
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

/**
 * NUVEM (23/10/2026): dois cadastros que alguém conferiu e disse "não são a
 * mesma pessoa" (o homônimo, o e-mail do setor dividido por duas pessoas). O
 * par não volta como "parece com" em porta nenhuma nem no contador de
 * possíveis duplicados (`servicos/duplicados.ts`). Sempre `a < b`: o par é
 * um só, seja qual for a ordem em que foi marcado.
 */
export const participante_par_distinto = pgTable(
  'participante_par_distinto',
  {
    participante_a_id: integer('participante_a_id').notNull(),
    participante_b_id: integer('participante_b_id').notNull(),
    // onde a decisão foi tomada (conferência do link, ficha da turma, lote, junção)
    origem: varchar('origem', { length: 20 }).notNull(),
    decidido_por: integer('decidido_por'),
    decidido_em: MomentoUTC('decidido_em').notNull().$defaultFn(agora_utc),
  },
  (t) => [
    primaryKey({ name: 'pk_participante_par_distinto', columns: [t.participante_a_id, t.participante_b_id] }),
    foreignKey({ name: 'fk_par_distinto_a', columns: [t.participante_a_id], foreignColumns: [participante.id] }).onDelete(
      'cascade',
    ),
    foreignKey({ name: 'fk_par_distinto_b', columns: [t.participante_b_id], foreignColumns: [participante.id] }).onDelete(
      'cascade',
    ),
    foreignKey({ name: 'fk_par_distinto_usuario', columns: [t.decidido_por], foreignColumns: [usuario.id] }),
    check('ck_par_distinto_ordem', sql.raw(`participante_a_id < participante_b_id`)),
    check(
      'ck_par_distinto_origem',
      sql.raw(`origem IN ('CONFERENCIA','FICHA_TURMA','LOTE','JUNCAO')`),
    ),
    index('ix_par_distinto_b').on(t.participante_b_id),
  ],
);

/**
 * NUVEM (23/10/2026): o que cada junção de cadastros moveu
 * (`mesclagem.mesclar`) — os ids das inscrições, dos certificados e dos
 * e-mails que passaram ao mantido, os e-mails repetidos que saíram e os
 * campos que o mantido herdou. É o que torna possível desfazer a junção
 * depois; o botão de desfazer ainda não existe. Sem dado pessoal: só ids e
 * nomes de campo (o CPF herdado aparece como `"cpf"`, nunca o número).
 */
export const participante_mesclagem = pgTable(
  'participante_mesclagem',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    mantido_id: integer('mantido_id').notNull(),
    absorvido_id: integer('absorvido_id').notNull(),
    movido: JSONTexto<{
      inscricoes: number[];
      certificados: { id: number; servidor_id_antes: number | null }[];
      emails_movidos: number[];
      emails_repetidos: { id: number; origem: string; confirmado_em: string | null; igual_a: number | null }[];
      principal_herdado: number | null;
      campos_herdados: string[];
      absorvido_tinha_cpf: boolean;
      // a conta de terceirizado/discente que passou do absorvido para o mantido
      conta_movida?: number | null;
    }>('movido').notNull(),
    feito_por: integer('feito_por'),
    feito_em: MomentoUTC('feito_em').notNull().$defaultFn(agora_utc),
  },
  (t) => [
    foreignKey({ name: 'fk_mesclagem_mantido', columns: [t.mantido_id], foreignColumns: [participante.id] }),
    foreignKey({ name: 'fk_mesclagem_absorvido', columns: [t.absorvido_id], foreignColumns: [participante.id] }),
    foreignKey({ name: 'fk_mesclagem_usuario', columns: [t.feito_por], foreignColumns: [usuario.id] }),
    index('ix_mesclagem_absorvido').on(t.absorvido_id),
    index('ix_mesclagem_mantido').on(t.mantido_id),
  ],
);

/**
 * NUVEM (24/10/2026): onde a turma acontece, cadastrado uma vez
 * (`servicos/local_treinamento.ts`). A turma aponta para cá por `local_id`;
 * o texto livre `turma.local` continua, e leva o nome do local escolhido (o
 * que o certificado, a agenda e o e-mail já liam). Não se apaga: inativo sai
 * da escolha, e a turma que já o tem fica com ele.
 */
export const local_treinamento = pgTable(
  'local_treinamento',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    nome: varchar('nome', { length: 160 }).notNull(),
    // vazio = serve a qualquer campus (o auditório da reitoria, o local de
    // fora da UFVJM)
    campus_id: integer('campus_id'),
    // o bloco, o andar, a sala: o que leva a pessoa até a porta
    endereco: text('endereco'),
    // quantas pessoas cabem; vazio = não informado. Só gera aviso na turma.
    capacidade: integer('capacidade'),
    observacoes: text('observacoes'),
    ativo: boolean('ativo').notNull().default(true),
    criado_por: integer('criado_por'),
    criado_em: MomentoUTC('criado_em').notNull().$defaultFn(agora_utc),
  },
  (t) => [
    primaryKey({ name: 'pk_local_treinamento', columns: [t.id] }),
    foreignKey({ name: 'fk_local_treinamento_campus', columns: [t.campus_id], foreignColumns: [campus.id] }),
    foreignKey({ name: 'fk_local_treinamento_criado_por', columns: [t.criado_por], foreignColumns: [usuario.id] }),
    check('ck_local_treinamento_capacidade', sql.raw(`capacidade IS NULL OR capacidade > 0`)),
    index('ix_local_treinamento_campus').on(t.campus_id),
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
    // NUVEM (22/10/2026): o horario em campos proprios, para o .ics e os
    // filtros. Opcionais: a turma antiga continua sem hora (dia inteiro).
    hora_inicio: time('hora_inicio'),
    hora_fim: time('hora_fim'),
    // nem sempre e o fim do curso (pode ser a avaliacao pratica). Vazio = data_fim.
    data_base_vencimento: DataPura('data_base_vencimento'),
    // sobrepoe a carga do treinamento quando a turma teve carga diferente
    carga_horaria_horas: numeric('carga_horaria_horas', { precision: 5, scale: 1, mode: 'string' }),

    local: varchar('local', { length: 160 }),
    // NUVEM (24/10/2026): o local cadastrado (`local_treinamento`). Com ele,
    // `local` guarda o nome do local; sem ele (turma antiga, "outro local"),
    // `local` é o texto livre de sempre.
    local_id: integer('local_id'),
    // o que o evento é, em texto livre (o "sobre o curso" do cartaz e do
    // certificado); a turma seguinte do mesmo treinamento costuma reaproveitar
    descricao: text('descricao'),
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
    // NUVEM (22/10/2026): o publico "Comunidade externa" (visitante/outro) so
    // entra quando a equipe marca na turma
    aceita_comunidade_externa: boolean('aceita_comunidade_externa').notNull().default(false),
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
    foreignKey({ name: 'fk_turma_local', columns: [t.local_id], foreignColumns: [local_treinamento.id] }),
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
    // hora de fim pede a de inicio, e vem depois dela
    check('ck_turma_horas', sql.raw(`hora_fim IS NULL OR (hora_inicio IS NOT NULL AND hora_fim > hora_inicio)`)),
    primaryKey({ name: 'pk_turma', columns: [t.id] }),
    unique('uq_turma_codigo').on(t.codigo),
    unique('uq_turma_token').on(t.inscricao_token_hash),
    index('ix_turma_treinamento').on(t.treinamento_id),
    index('ix_turma_situacao').on(t.situacao),
    index('ix_turma_data_fim').on(t.data_fim),
    // o choque de sala procura as turmas do mesmo local
    index('ix_turma_local').on(t.local_id),
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
 * NUVEM (23/10/2026): os AJUDANTES da turma — a conta que o dono (ou quem
 * está acima dele) designou para operar a turma em alguns papéis
 * (`servicos/dono_turma.ts`). Sem linha aqui, quem não é dono nem superior só
 * consulta. Ajudante não designa outros. Retirar é apagar a linha (a trilha
 * guarda `TURMA_AJUDANTE_DESIGNADO`/`TURMA_AJUDANTE_RETIRADO`).
 */
export const turma_ajudante = pgTable(
  'turma_ajudante',
  {
    turma_id: integer('turma_id').notNull(),
    usuario_id: integer('usuario_id').notNull(),
    // os papeis, um a um (lista fechada de `dono_turma.PAPEIS_DE_AJUDANTE`)
    inscricoes: boolean('inscricoes').notNull().default(false),
    presenca: boolean('presenca').notNull().default(false),
    emissao: boolean('emissao').notNull().default(false),
    designado_por: integer('designado_por').notNull(),
    designado_em: MomentoUTC('designado_em').notNull().$defaultFn(agora_utc),
  },
  (t) => [
    primaryKey({ name: 'pk_turma_ajudante', columns: [t.turma_id, t.usuario_id] }),
    // a turma excluída leva os ajudantes junto (a trilha fica)
    foreignKey({ name: 'fk_turma_ajudante_turma', columns: [t.turma_id], foreignColumns: [turma.id] }).onDelete('cascade'),
    foreignKey({ name: 'fk_turma_ajudante_usuario', columns: [t.usuario_id], foreignColumns: [usuario.id] }),
    foreignKey({ name: 'fk_turma_ajudante_designado_por', columns: [t.designado_por], foreignColumns: [usuario.id] }),
    // designar sem papel nenhum é retirar
    check('ck_turma_ajudante_papel', sql.raw(`inscricoes OR presenca OR emissao`)),
    index('ix_turma_ajudante_usuario').on(t.usuario_id),
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
    // NUVEM: sem envio de e-mail, quem tira o pedido do link da espera é a
    // CSSO, que o confere — e fica dito quem e quando
    conferida_por: integer('conferida_por'),
    conferida_em: MomentoUTC('conferida_em'),

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
    // NUVEM (24/10/2026): a pessoa já respondeu a avaliação de reação desta
    // turma (`servicos/avaliacao_reacao.ts`). Só o fato, SEM hora: a resposta
    // mora em `avaliacao_reacao_resposta`, sem ligação com a inscrição, e uma
    // hora aqui seria o elo para casar as duas.
    avaliacao_respondida: boolean('avaliacao_respondida').notNull().default(false),
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
    foreignKey({
      name: 'fk_inscricao_conferida_por',
      columns: [t.conferida_por],
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
    // trava que impede inscrever alguem no e-mail alheio. NUVEM: sem envio de
    // e-mail, a confirmacao e a conferencia da CSSO (`conferida_por`); recusar
    // o pedido (CANCELADA) nao precisa de nenhuma das duas
    check(
      'ck_inscricao_email_confirmado',
      sql.raw(
        `origem = 'INTERNA' OR situacao IN ('AGUARDANDO_EMAIL','CANCELADA') ` +
          `OR email_confirmado_em IS NOT NULL OR conferida_por IS NOT NULL`,
      ),
    ),
    primaryKey({ name: 'pk_inscricao', columns: [t.id] }),
    unique('uq_inscricao_token').on(t.confirmacao_token_hash),
    index('ix_inscricao_participante').on(t.participante_id),
    index('ix_inscricao_turma_situacao').on(t.turma_id, t.situacao),
  ],
);

/**
 * NUVEM (26/10/2026): o aviso "você já tem cadastro" do link público
 * (`servicos/aviso_cadastro_existente.ts`) leva dois botões — "sou eu" e "não
 * fui eu" —, e cada aviso tem o seu token. Guarda só o hash do token e a
 * resposta; o endereço de e-mail NÃO mora aqui (está na fila e no cadastro).
 * A resposta só serve de selo na conferência da equipe: não aceita vaga nem
 * acrescenta e-mail ao cadastro.
 */
export const aviso_cadastro = pgTable(
  'aviso_cadastro',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    participante_id: integer('participante_id').notNull(),
    // o pedido que gerou o aviso; some com a inscrição
    inscricao_id: integer('inscricao_id').notNull(),
    // o e-mail do cadastro que recebeu o aviso: é ele que o "sou eu" confirma
    email_id: integer('email_id'),
    token_hash: varchar('token_hash', { length: 64 }).notNull(),
    criado_em: MomentoUTC('criado_em').notNull().$defaultFn(agora_utc),
    expira_em: MomentoUTC('expira_em').notNull(),
    resposta: varchar('resposta', { length: 12 }),
    respondida_em: MomentoUTC('respondida_em'),
  },
  (t) => [
    primaryKey({ name: 'pk_aviso_cadastro', columns: [t.id] }),
    foreignKey({ name: 'fk_aviso_cadastro_participante', columns: [t.participante_id], foreignColumns: [participante.id] }),
    foreignKey({ name: 'fk_aviso_cadastro_inscricao', columns: [t.inscricao_id], foreignColumns: [inscricao.id] }).onDelete(
      'cascade',
    ),
    foreignKey({ name: 'fk_aviso_cadastro_email', columns: [t.email_id], foreignColumns: [participante_email.id] }).onDelete(
      'set null',
    ),
    unique('uq_aviso_cadastro_token').on(t.token_hash),
    check('ck_aviso_cadastro_resposta', sql.raw(`resposta IS NULL OR resposta IN ('SOU_EU','NAO_FUI_EU')`)),
    check('ck_aviso_cadastro_respondida', sql.raw(`(resposta IS NULL) = (respondida_em IS NULL)`)),
    index('ix_aviso_cadastro_inscricao').on(t.inscricao_id),
    index('ix_aviso_cadastro_participante').on(t.participante_id),
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
 * NUVEM (22/10/2026): a sequencia anual do numero impresso, por PREFIXO
 * (sigla do setor promotor + codigo curto do treinamento). Mesma disciplina
 * da RN-03: nunca MAX(numero)+1 (`numeracao.proximo_numero_impresso`).
 */
export const certificado_sequencia_prefixo = pgTable(
  'certificado_sequencia_prefixo',
  {
    prefixo: varchar('prefixo', { length: 24 }).notNull(),
    ano: integer('ano').notNull(),
    ultimo_numero: integer('ultimo_numero').notNull().default(0),
  },
  (t) => [primaryKey({ name: 'pk_certificado_sequencia_prefixo', columns: [t.prefixo, t.ano] })],
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
    // NUVEM (22/10/2026): o numero impresso do certificado novo
    // (`CSSO-NR35-2026-0001`). NULL = emitido antes: o rotulo continua `27/2026`.
    numero_impresso: varchar('numero_impresso', { length: 40 }),
    // em claro, com indice unico: a segunda via sai com a MESMA chave.
    // Nova: numero impresso + 5 sorteados (`CSSO-NR35-2026-0001-K7QMX`).
    chave_validacao: varchar('chave_validacao', { length: 48 }).notNull(),

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
    unique('uq_certificado_numero_impresso').on(t.numero_impresso),
    check_regex('ck_certificado_numero_impresso', 'numero_impresso', PADRAO_NUMERO_IMPRESSO),
    // a chave nova comeca pelo numero impresso do proprio certificado
    check(
      'ck_certificado_chave_do_numero',
      sql.raw(`numero_impresso IS NULL OR chave_validacao LIKE numero_impresso || '-%'`),
    ),
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

// =====================================================================
// NUVEM — valores dos campos que o modelo declara (tipo TURMA/PARTICIPANTE)
// =====================================================================

/**
 * O valor de um campo de turma do modelo (ex.: "Local de atuação do
 * brigadista"). A chave e o MARCADOR, e nao a linha do dicionario: a versao
 * nova do modelo clona o dicionario, e o valor ja digitado continua valendo.
 * Certificado emitido nao le daqui — le do contexto congelado.
 */
export const certificado_valor_turma = pgTable(
  'certificado_valor_turma',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    turma_id: integer('turma_id').notNull(),
    marcador: varchar('marcador', { length: 60 }).notNull(),
    valor: text('valor').notNull(),
    atualizado_por: integer('atualizado_por'),
    atualizado_em: MomentoUTC('atualizado_em').notNull().$defaultFn(agora_utc),
  },
  (t) => [
    primaryKey({ name: 'pk_certificado_valor_turma', columns: [t.id] }),
    foreignKey({ name: 'fk_valor_turma_turma', columns: [t.turma_id], foreignColumns: [turma.id] }).onDelete('cascade'),
    foreignKey({ name: 'fk_valor_turma_usuario', columns: [t.atualizado_por], foreignColumns: [usuario.id] }),
    unique('uq_valor_turma').on(t.turma_id, t.marcador),
  ],
);

/**
 * O valor de um campo de participante do modelo (ex.: a nota de cada
 * disciplina), por inscricao. Dado pessoal: le-se e grava-se com as mesmas
 * permissoes da nota final.
 */
export const certificado_valor_inscricao = pgTable(
  'certificado_valor_inscricao',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    inscricao_id: integer('inscricao_id').notNull(),
    marcador: varchar('marcador', { length: 60 }).notNull(),
    valor: text('valor').notNull(),
    atualizado_por: integer('atualizado_por'),
    atualizado_em: MomentoUTC('atualizado_em').notNull().$defaultFn(agora_utc),
  },
  (t) => [
    primaryKey({ name: 'pk_certificado_valor_inscricao', columns: [t.id] }),
    foreignKey({
      name: 'fk_valor_inscricao_inscricao',
      columns: [t.inscricao_id],
      foreignColumns: [inscricao.id],
    }).onDelete('cascade'),
    foreignKey({ name: 'fk_valor_inscricao_usuario', columns: [t.atualizado_por], foreignColumns: [usuario.id] }),
    unique('uq_valor_inscricao').on(t.inscricao_id, t.marcador),
  ],
);

// =====================================================================
// NUVEM (24/10/2026) — avaliação de reação (`servicos/avaliacao_reacao.ts`)
// =====================================================================

/**
 * O convite por link de uso único, um por inscrição, para quem avalia sem
 * entrar no sistema. Só o SHA-256 do token (o token vai no e-mail). Abrir o
 * link não gasta nada; responder APAGA a linha — é isso o "uso único". O
 * convite que venceu (`expira_em`, o fim do prazo da avaliação) sai pela rotina
 * de privacidade.
 */
export const avaliacao_reacao_convite = pgTable(
  'avaliacao_reacao_convite',
  {
    inscricao_id: integer('inscricao_id').notNull(),
    token_hash: varchar('token_hash', { length: 64 }).notNull(),
    // o último dia em que o link vale (o mesmo prazo da avaliação pela conta)
    expira_em: DataPura('expira_em').notNull(),
  },
  (t) => [
    primaryKey({ name: 'pk_avaliacao_reacao_convite', columns: [t.inscricao_id] }),
    foreignKey({
      name: 'fk_avaliacao_convite_inscricao',
      columns: [t.inscricao_id],
      foreignColumns: [inscricao.id],
    }).onDelete('cascade'),
    unique('uq_avaliacao_convite_token').on(t.token_hash),
    index('ix_avaliacao_convite_expira').on(t.expira_em),
  ],
);

/**
 * A resposta, ANÔNIMA por construção: nenhuma coluna aponta para inscrição,
 * participante ou conta, a data vai sem hora e a chave é sorteada (um número
 * sequencial diria a ordem em que as respostas chegaram, e a ordem casaria com
 * a trilha). Quem respondeu fica marcado só na inscrição
 * (`inscricao.avaliacao_respondida`).
 */
export const avaliacao_reacao_resposta = pgTable(
  'avaliacao_reacao_resposta',
  {
    id: uuid('id').notNull().defaultRandom(),
    turma_id: integer('turma_id').notNull(),
    // a versão do questionário fixo (`avaliacao_reacao.VERSAO`)
    versao: varchar('versao', { length: 10 }).notNull(),
    nota_conteudo: smallint('nota_conteudo').notNull(),
    nota_instrutor: smallint('nota_instrutor').notNull(),
    nota_material: smallint('nota_material').notNull(),
    nota_local: smallint('nota_local').notNull(),
    nota_carga: smallint('nota_carga').notNull(),
    nota_recomendaria: smallint('nota_recomendaria').notNull(),
    comentario: text('comentario'),
    respondida_em: DataPura('respondida_em').notNull(),
  },
  (t) => [
    primaryKey({ name: 'pk_avaliacao_reacao_resposta', columns: [t.id] }),
    foreignKey({
      name: 'fk_avaliacao_resposta_turma',
      columns: [t.turma_id],
      foreignColumns: [turma.id],
    }).onDelete('cascade'),
    check(
      'ck_avaliacao_resposta_notas',
      sql.raw(
        ['nota_conteudo', 'nota_instrutor', 'nota_material', 'nota_local', 'nota_carga', 'nota_recomendaria']
          .map((c) => `${c} BETWEEN 1 AND 5`)
          .join(' AND '),
      ),
    ),
    check('ck_avaliacao_resposta_comentario', sql.raw(`comentario IS NULL OR char_length(comentario) <= 1000`)),
    index('ix_avaliacao_resposta_turma').on(t.turma_id),
  ],
);
