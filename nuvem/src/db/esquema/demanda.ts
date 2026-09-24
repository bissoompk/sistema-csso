/**
 * Demanda — o pedido que chegou por e-mail ou no balcao e ainda nao e processo.
 * Porte de `app/modelos/demanda.py`.
 *
 * **Por que uma tabela nova, e nao um campo em `processo` ou em `pendencia`.**
 * `processo.nup` e obrigatorio, unico e tem CHECK de formato: um `processo` E um
 * processo SEI. Demanda ali entraria sem NUP (impossivel) ou com NUP inventado
 * (pior). E `pendencia` nasce de regra, ancorada em algo que ja existe, e e
 * TAREFA; a demanda que chegou por e-mail nao tem ancora nenhuma e precisa
 * guardar quem pediu, por onde chegou, o que se respondeu e como terminou.
 *
 * **O campo mais perigoso do sistema inteiro esta aqui.** `descricao`, `pedido`
 * do encaminhamento e `desfecho_relato` sao texto livre escrito com pressa,
 * sobre uma pessoa. A protecao e tecnica e fica no servico (RN-21, texto limpo),
 * nao num aviso no rodape do formulario.
 *
 * **Nao ha CPF, CID, diagnostico, atestado nem gestacao em coluna nenhuma.**
 */

import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  varchar,
} from 'drizzle-orm/pg-core';

import { CANAIS_DEMANDA, DESFECHOS_DEMANDA, ESTADOS_DEMANDA } from '../../dominio/estados';
import { DataPura, MomentoUTC, agora_utc, lista_sql } from './base';
import { servidor, unidade_uorg } from './organizacao';
import { processo } from './processo';
import { usuario } from './seguranca';

/** O registro do que chegou. Um por pedido, com dono e com desfecho. */
export const demanda = pgTable(
  'demanda',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),

    // Padrao: hoje (o servico preenche). Editavel porque o e-mail de sexta as
    // vezes so e registrado na segunda, e mentir a data de chegada estragaria a
    // unica medida de atraso que esta tabela produz.
    data_chegada: DataPura('data_chegada').notNull(),
    canal: varchar('canal', { length: 12 }).notNull(),

    // --- quem pediu: o texto livre E o vinculo, e os dois de proposito ---
    // O texto e obrigatorio porque quem demanda muitas vezes NAO esta no
    // cadastro. O vinculo e opcional e vale ouro quando existe: e ele que liga
    // a demanda a ficha do servidor, e e por ele que a RN-19 sabe o que suprimir.
    solicitante_nome: varchar('solicitante_nome', { length: 160 }).notNull(),
    solicitante_servidor_id: integer('solicitante_servidor_id'),
    solicitante_unidade_uorg_id: integer('solicitante_unidade_uorg_id'),

    // Uma linha, e e o que a lista mostra; a descricao e o que se le quando a
    // fila parou naquela linha.
    assunto: varchar('assunto', { length: 160 }).notNull(),
    descricao: text('descricao'),

    // Padrao: quem cadastrou. Anulavel porque a demanda pode chegar sem dono
    // definido — e tarefa sem dono aparece assim na tela, e nao com dono falso.
    responsavel_id: integer('responsavel_id'),

    // Opcional, e COBRA: com prazo, a demanda abre pendencia e entra no sino.
    prazo: DataPura('prazo'),

    estado: varchar('estado', { length: 14 }).notNull().default('ABERTA'),

    // --- o desfecho: obrigatorio no fecho, e cada tipo cobra a sua prova ---
    desfecho: varchar('desfecho', { length: 16 }),
    // O que foi feito (RESOLVIDA) ou por que nao se fez nada (SEM_PROVIDENCIA).
    desfecho_relato: text('desfecho_relato'),
    // **FK de verdade para `processo.id`**, e nao um NUP em texto: e a
    // diferenca entre rastreabilidade e anotacao.
    desfecho_processo_id: integer('desfecho_processo_id'),
    // Para qual setor foi, quando ENCAMINHADA. Texto livre porque o destino
    // muitas vezes esta fora do cadastro de unidades.
    desfecho_setor: varchar('desfecho_setor', { length: 160 }),
    desfecho_data: DataPura('desfecho_data'),

    encerrada_em: MomentoUTC('encerrada_em'),
    encerrada_por: integer('encerrada_por'),

    criada_em: MomentoUTC('criada_em').notNull().$defaultFn(agora_utc),
    criada_por: integer('criada_por'),
  },
  (t) => [
    // nomes de constraint da migracao `demandas_o_que_chega_por_fora_do_sei`
    primaryKey({ name: 'pk_demanda', columns: [t.id] }),
    foreignKey({
      name: 'fk_demanda_servidor',
      columns: [t.solicitante_servidor_id],
      foreignColumns: [servidor.id],
    }),
    foreignKey({
      name: 'fk_demanda_unidade',
      columns: [t.solicitante_unidade_uorg_id],
      foreignColumns: [unidade_uorg.id],
    }),
    foreignKey({
      name: 'fk_demanda_responsavel',
      columns: [t.responsavel_id],
      foreignColumns: [usuario.id],
    }),
    foreignKey({
      name: 'fk_demanda_processo',
      columns: [t.desfecho_processo_id],
      foreignColumns: [processo.id],
    }),
    foreignKey({
      name: 'fk_demanda_encerrada_por',
      columns: [t.encerrada_por],
      foreignColumns: [usuario.id],
    }),
    foreignKey({ name: 'fk_demanda_criada_por', columns: [t.criada_por], foreignColumns: [usuario.id] }),
    // As tres CHECK de vocabulario saem das MESMAS tuplas que a maquina H usa
    // para decidir transicao e que o formulario usa para montar o seletor.
    check('ck_demanda_canal', sql.raw(`canal IN (${lista_sql(CANAIS_DEMANDA)})`)),
    check('ck_demanda_estado', sql.raw(`estado IN (${lista_sql(ESTADOS_DEMANDA)})`)),
    check(
      'ck_demanda_desfecho',
      sql.raw(`desfecho IS NULL OR desfecho IN (${lista_sql(DESFECHOS_DEMANDA)})`),
    ),
    // O par que carrega a decisao do dono: **encerrar exige dizer como**. Nos
    // dois sentidos — demanda aberta com desfecho gravado seria um fecho que
    // ninguem completou, e e tao errado quanto o contrario.
    check(
      'ck_demanda_encerrada_tem_desfecho',
      sql.raw(
        `(estado <> 'ENCERRADA' AND desfecho IS NULL) ` +
          `OR (estado = 'ENCERRADA' AND desfecho IS NOT NULL)`,
      ),
    ),
    // Cada desfecho cobra o seu campo, e proibe os dos outros. Sem a segunda
    // metade, uma demanda RESOLVIDA poderia carregar um `desfecho_setor`
    // sobrando de um encaminhamento que nao aconteceu.
    check(
      'ck_demanda_desfecho_campos',
      sql.raw(
        '(desfecho IS NULL' +
          ' AND desfecho_relato IS NULL AND desfecho_processo_id IS NULL' +
          ' AND desfecho_setor IS NULL AND desfecho_data IS NULL)' +
          ' OR (' +
          "     (desfecho <> 'VIROU_PROCESSO' OR desfecho_processo_id IS NOT NULL)" +
          " AND (desfecho =  'VIROU_PROCESSO' OR desfecho_processo_id IS NULL)" +
          " AND (desfecho <> 'ENCAMINHADA'" +
          '      OR (desfecho_setor IS NOT NULL AND desfecho_data IS NOT NULL))' +
          " AND (desfecho =  'ENCAMINHADA' OR desfecho_setor IS NULL)" +
          " AND (desfecho NOT IN ('RESOLVIDA','SEM_PROVIDENCIA')" +
          '      OR desfecho_relato IS NOT NULL))',
      ),
    ),
    // A consulta da tela: as abertas, por prazo.
    index('ix_demanda_estado').on(t.estado, t.prazo),
    index('ix_demanda_responsavel').on(t.responsavel_id),
    // "o que ha em aberto sobre esta pessoa?" — a pergunta da ficha do servidor
    index('ix_demanda_servidor').on(t.solicitante_servidor_id),
  ],
);

/**
 * O que foi pedido, a quem, e quando — append-only (RN-31).
 *
 * Nada se apaga e nada se edita, e a trava e de banco (`src/db/travas.sql`),
 * como a de `historico_evento` e a da ficha de EPI. Corrigir e escrever a linha
 * seguinte dizendo o que mudou — o que se perderia editando e justamente a
 * informacao de que houve duas cobrancas.
 */
export const demanda_encaminhamento = pgTable(
  'demanda_encaminhamento',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    demanda_id: integer('demanda_id').notNull(),
    data_encaminhamento: DataPura('data_encaminhamento').notNull(),
    // Texto livre pelo mesmo motivo de `desfecho_setor`.
    para_quem: varchar('para_quem', { length: 160 }).notNull(),
    // Obrigatorio. Encaminhamento sem o que foi pedido e um carimbo de data.
    pedido: text('pedido').notNull(),
    registrado_por: integer('registrado_por'),
    registrado_em: MomentoUTC('registrado_em').notNull().$defaultFn(agora_utc),
  },
  (t) => [
    primaryKey({ name: 'pk_demanda_encaminhamento', columns: [t.id] }),
    foreignKey({
      name: 'fk_encaminhamento_demanda',
      columns: [t.demanda_id],
      foreignColumns: [demanda.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fk_encaminhamento_autor',
      columns: [t.registrado_por],
      foreignColumns: [usuario.id],
    }),
    index('ix_demanda_encaminhamento').on(t.demanda_id),
  ],
);
