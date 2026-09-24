/**
 * Modulo Gestao de EPI — catalogo, estoque e ficha. Porte de `app/modelos/epi.py`.
 *
 * O prefixo `epi_` esta em todas as tabelas: o modulo tem catalogo proprio, e
 * `categoria` sem prefixo colidiria com a taxonomia de qualquer outro.
 *
 * No SQLite, `requisicao_item_id` nasceu `Integer` sem FK e so ganhou a chave
 * estrangeira na fatia 4 (revisao `c1d9e47a2b30`), porque `epi_requisicao_item`
 * ainda nao existia. Aqui o esquema nasce inteiro, com a FK desde o primeiro dia
 * — e o estado final daquela historia, sem a historia.
 *
 * Os nomes de constraint (`pk_*`, `fk_*`, `uq_*`) sao os do Python: o modelo
 * os nomeia explicitamente, e nome de constraint e o que aparece na mensagem de
 * erro que alguem vai ler as tres da manha.
 *
 * **Nao ha coluna de CPF em lugar nenhum** (decisao 1): quem pede EPI e
 * servidor, e servidor se identifica por SIAPE.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
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
  varchar,
} from 'drizzle-orm/pg-core';

import {
  FINALIDADES_REQUISICAO,
  TIPOS_FICHA,
  TIPOS_MOVIMENTO,
  UNIDADES_MEDIDA,
  URGENCIAS_REQUISICAO,
} from '../../dominio/epi';
import { ESTADOS_EPI_ITEM, ESTADOS_EPI_REQUISICAO } from '../../dominio/estados';
import { anexo, historico_evento } from './auditoria';
import { DataPura, JSONTexto, MomentoUTC, agora_utc, lista_sql } from './base';
import { campus, posto_trabalho, servidor, unidade_uorg } from './organizacao';
import { usuario } from './seguranca';

export { FINALIDADES_REQUISICAO, TIPOS_FICHA, TIPOS_MOVIMENTO, UNIDADES_MEDIDA, URGENCIAS_REQUISICAO };

/**
 * A taxonomia do Anexo I da NR-6, semeada. No legado `Categoria` era texto livre
 * — quatro grafias de uma lista que a norma fecha em nove.
 */
export const epi_categoria = pgTable(
  'epi_categoria',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    codigo: varchar('codigo', { length: 24 }).notNull(),
    nome: varchar('nome', { length: 80 }).notNull(),
    // item do Anexo I da NR-6: 'A.1', 'B.2', 'G.1'...
    referencia_nr6: varchar('referencia_nr6', { length: 12 }),
    ordem: smallint('ordem').notNull().default(1),
    ativo: boolean('ativo').notNull().default(true),
  },
  (t) => [
    primaryKey({ name: 'pk_epi_categoria', columns: [t.id] }),
    unique('uq_epi_categoria').on(t.codigo),
  ],
);

/**
 * Catalogo das negativas, com a fundamentacao junto.
 *
 * **Nao ha versionamento por linha, e e deliberado.** O que protege a negativa
 * ja emitida e `epi_requisicao_item.texto_recusa_snapshot` (RN-27), que congela
 * o texto no ato da decisao. Dois mecanismos para uma garantia e como ela deixa
 * de valer.
 */
export const epi_motivo_recusa = pgTable(
  'epi_motivo_recusa',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    codigo: varchar('codigo', { length: 32 }).notNull(),
    rotulo: varchar('rotulo', { length: 80 }).notNull(),
    // sai literal na guia impressa e na notificacao ao requerente
    texto: text('texto').notNull(),
    base_normativa: varchar('base_normativa', { length: 120 }),
    exige_complemento: boolean('exige_complemento').notNull().default(false),
    ativo: boolean('ativo').notNull().default(true),
    dispositivo_conferido_em: DataPura('dispositivo_conferido_em'),
  },
  (t) => [
    primaryKey({ name: 'pk_epi_motivo_recusa', columns: [t.id] }),
    unique('uq_epi_motivo_recusa').on(t.codigo),
  ],
);

/**
 * O catalogo de EPI. Substitui `EPI_Cadastro`.
 *
 * Nove das 22 colunas do legado nunca apareceram no formulario — e as quatro
 * que governam a requisicao estavam entre elas. Regra que ninguem consegue ver
 * nao e regra, e armadilha.
 */
export const epi_item = pgTable(
  'epi_item',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    nome: varchar('nome', { length: 180 }).notNull(),
    descricao: text('descricao'),
    categoria_id: integer('categoria_id').notNull(),

    codigo_ecampus: varchar('codigo_ecampus', { length: 20 }),
    codigo_catmat: varchar('codigo_catmat', { length: 20 }),
    fabricante: varchar('fabricante', { length: 120 }),
    marca: varchar('marca', { length: 80 }),
    modelo: varchar('modelo', { length: 80 }),
    // ABNT NBR de referencia, uma por linha
    normas: text('normas'),

    // CA de referencia do catalogo (o que o pregao especificou). O CA que vale
    // para bloquear a entrega e o do LOTE — ver `epi_entrada_estoque`.
    exige_ca: boolean('exige_ca').notNull().default(true),
    numero_ca: varchar('numero_ca', { length: 10 }),
    validade_ca: DataPura('validade_ca'),

    // sugestao em `UNIDADES_MEDIDA`, sem CHECK: a lista nao e fechada
    unidade_medida: varchar('unidade_medida', { length: 20 }).notNull().default('UNIDADE'),
    // um tamanho por linha, na ordem — mesmo padrao de `checklist_modelo.itens`
    tamanhos: text('tamanhos'),
    vida_util_meses: smallint('vida_util_meses'),

    quantidade_padrao: smallint('quantidade_padrao').notNull().default(1),
    // "maxima" sem janela nao quer dizer nada: maxima por ano? por vida?
    quantidade_maxima: smallint('quantidade_maxima'),
    periodo_maximo_meses: smallint('periodo_maximo_meses'),

    exige_justificativa: boolean('exige_justificativa').notNull().default(false),
    exige_treinamento: boolean('exige_treinamento').notNull().default(false),
    ativo: boolean('ativo').notNull().default(true),

    criado_em: MomentoUTC('criado_em').notNull().$defaultFn(agora_utc),
    atualizado_em: MomentoUTC('atualizado_em')
      .notNull()
      .$defaultFn(agora_utc)
      .$onUpdateFn(agora_utc),
  },
  (t) => [
    foreignKey({
      name: 'fk_epi_item_categoria',
      columns: [t.categoria_id],
      foreignColumns: [epi_categoria.id],
    }),
    check('ck_epi_qtd_padrao', sql.raw(`quantidade_padrao > 0`)),
    check(
      'ck_epi_qtd_maxima',
      sql.raw(`quantidade_maxima IS NULL OR quantidade_maxima >= quantidade_padrao`),
    ),
    // maxima sem janela e regra que ninguem sabe aplicar: "2 por ano" e regra,
    // "2" nao e nada (RN-26)
    check('ck_epi_janela', sql.raw(`(quantidade_maxima IS NULL) = (periodo_maximo_meses IS NULL)`)),
    check('ck_epi_ca_obrigatorio', sql.raw(`NOT exige_ca OR numero_ca IS NOT NULL`)),
    check('ck_epi_vida_util', sql.raw(`vida_util_meses IS NULL OR vida_util_meses > 0`)),
    primaryKey({ name: 'pk_epi_item', columns: [t.id] }),
    unique('uq_epi_item').on(t.nome, t.modelo),
    index('ix_epi_item_categoria').on(t.categoria_id),
    index('ix_epi_item_ativo').on(t.ativo),
  ],
);

/**
 * O lote. Substitui `Estoque_Entradas`.
 *
 * Pregao, item do pregao, empenho, fornecedor e valor vem inteiros: e
 * rastreabilidade de compra publica. O que muda: a entrada e imutavel no que
 * diz respeito a quantidade, e o saldo e a soma de `epi_movimento_estoque`.
 */
export const epi_entrada_estoque = pgTable(
  'epi_entrada_estoque',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    epi_item_id: integer('epi_item_id').notNull(),
    tamanho: varchar('tamanho', { length: 20 }),

    pregao: varchar('pregao', { length: 30 }),
    item_pregao: varchar('item_pregao', { length: 10 }),
    empenho: varchar('empenho', { length: 30 }),
    nota_fiscal: varchar('nota_fiscal', { length: 30 }),
    fornecedor_nome: varchar('fornecedor_nome', { length: 160 }),
    // CNPJ e dado de pessoa JURIDICA: nao e dado pessoal, e nao colide com a
    // decisao 1 — o que nao entra em campo nenhum e CPF.
    fornecedor_cnpj: varchar('fornecedor_cnpj', { length: 14 }),
    // Canal INSTITUCIONAL do fornecedor, e nao o nome de um vendedor.
    fornecedor_contato: varchar('fornecedor_contato', { length: 120 }),

    data_entrada: DataPura('data_entrada').notNull(),
    quantidade_empenhada: integer('quantidade_empenhada'),
    quantidade_recebida: integer('quantidade_recebida').notNull(),
    valor_unitario: numeric('valor_unitario', { precision: 12, scale: 4, mode: 'string' }),

    lote: varchar('lote', { length: 40 }),
    // O CA que governa a entrega e ESTE, nao o do catalogo (RN-25).
    numero_ca: varchar('numero_ca', { length: 10 }),
    validade_ca: DataPura('validade_ca'),
    data_fabricacao: DataPura('data_fabricacao'),

    observacao: text('observacao'),
    ativo: boolean('ativo').notNull().default(true),
    motivo_inativacao: text('motivo_inativacao'),
    registrado_por: integer('registrado_por'),
    registrado_em: MomentoUTC('registrado_em').notNull().$defaultFn(agora_utc),
  },
  (t) => [
    foreignKey({
      name: 'fk_epi_entrada_item',
      columns: [t.epi_item_id],
      foreignColumns: [epi_item.id],
    }),
    foreignKey({
      name: 'fk_epi_entrada_registrado_por',
      columns: [t.registrado_por],
      foreignColumns: [usuario.id],
    }),
    check('ck_entrada_qtd', sql.raw(`quantidade_recebida > 0`)),
    check(
      'ck_entrada_empenho',
      sql.raw(`quantidade_empenhada IS NULL OR quantidade_empenhada >= quantidade_recebida`),
    ),
    // lote nao se exclui: inativa com motivo (RN-31)
    check('ck_entrada_inativa', sql.raw(`ativo OR motivo_inativacao IS NOT NULL`)),
    primaryKey({ name: 'pk_epi_entrada_estoque', columns: [t.id] }),
    index('ix_entrada_item').on(t.epi_item_id, t.tamanho),
    index('ix_entrada_validade_ca').on(t.validade_ca),
    index('ix_entrada_empenho').on(t.empenho),
  ],
);

/**
 * A ficha de EPI: o coracao juridico do modulo.
 *
 * Append-only — o banco recusa `DELETE` e `TRUNCATE`, e o `UPDATE` so passa se
 * nao tocar nenhuma das 26 colunas congeladas e se as tres completaveis forem de
 * nulo para valor, uma unica vez (`src/db/travas.sql`, `src/db/travas.ts`).
 * Correcao NUNCA e rasura: e linha nova de tipo `ESTORNO` apontando para a
 * errada, com motivo.
 *
 * Os `*_snapshot` sao a RN-15 aplicada ao EPI: se o catalogo mudar de "Luva
 * nitrilica" para "Luva de procedimento" em 2027, uma entrega de 2024 nao pode
 * passar a dizer outra coisa.
 *
 * `siape_snapshot` e `NOT NULL` de proposito: todo requisitante de EPI tem SIAPE
 * (decisao 3). Se estudante e bolsista entrarem um dia, esta e uma das colunas
 * que precisa afrouxar.
 */
export const epi_ficha_registro = pgTable(
  'epi_ficha_registro',
  {
    id: bigint('id', { mode: 'number' }).notNull().generatedByDefaultAsIdentity(),
    servidor_id: integer('servidor_id').notNull(),
    epi_item_id: integer('epi_item_id').notNull(),
    // Anulavel — entrega de balcao nao tem requisicao formal.
    requisicao_item_id: integer('requisicao_item_id'),
    entrada_id: integer('entrada_id'),

    tipo: varchar('tipo', { length: 14 }).notNull(),
    quantidade: smallint('quantidade').notNull(),
    data_evento: DataPura('data_evento').notNull(),

    // --- congelado no evento: o catalogo de amanha nao reescreve isto ---
    nome_epi_snapshot: varchar('nome_epi_snapshot', { length: 180 }).notNull(),
    categoria_snapshot: varchar('categoria_snapshot', { length: 80 }).notNull(),
    numero_ca_snapshot: varchar('numero_ca_snapshot', { length: 10 }),
    validade_ca_snapshot: DataPura('validade_ca_snapshot'),
    fabricante_snapshot: varchar('fabricante_snapshot', { length: 120 }),
    lote_snapshot: varchar('lote_snapshot', { length: 40 }),
    tamanho_snapshot: varchar('tamanho_snapshot', { length: 20 }),
    nome_servidor_snapshot: varchar('nome_servidor_snapshot', { length: 160 }).notNull(),
    siape_snapshot: varchar('siape_snapshot', { length: 7 }).notNull(),
    cargo_snapshot: varchar('cargo_snapshot', { length: 120 }),
    unidade_snapshot: varchar('unidade_snapshot', { length: 160 }),
    posto_snapshot: varchar('posto_snapshot', { length: 200 }),
    // o resto do contexto (empenho, pregao, valor, chefia, protocolo)
    contexto_congelado: JSONTexto<Record<string, unknown>>('contexto_congelado'),

    previsao_troca: DataPura('previsao_troca'),
    entregue_por: integer('entregue_por').notNull(),
    // FK de verdade: coluna de anexo sem FK e ponteiro que o banco nao conserva.
    comprovante_anexo_id: integer('comprovante_anexo_id'),
    recebimento_confirmado_em: MomentoUTC('recebimento_confirmado_em'),
    motivo: text('motivo'),

    registro_estornado_id: integer('registro_estornado_id'),
    // o evento da cadeia de hash que registrou esta linha: a prova fica a um
    // JOIN de distancia, e nao a uma busca por texto
    evento_id: integer('evento_id'),
    registrado_em: MomentoUTC('registrado_em').notNull().$defaultFn(agora_utc),
  },
  (t) => [
    foreignKey({ name: 'fk_epi_ficha_servidor', columns: [t.servidor_id], foreignColumns: [servidor.id] }),
    foreignKey({ name: 'fk_epi_ficha_item', columns: [t.epi_item_id], foreignColumns: [epi_item.id] }),
    foreignKey({
      name: 'fk_epi_ficha_requisicao_item',
      columns: [t.requisicao_item_id],
      foreignColumns: [epi_requisicao_item.id],
    }),
    foreignKey({
      name: 'fk_epi_ficha_entrada',
      columns: [t.entrada_id],
      foreignColumns: [epi_entrada_estoque.id],
    }),
    foreignKey({
      name: 'fk_epi_ficha_entregue_por',
      columns: [t.entregue_por],
      foreignColumns: [usuario.id],
    }),
    foreignKey({
      name: 'fk_epi_ficha_comprovante',
      columns: [t.comprovante_anexo_id],
      foreignColumns: [anexo.id],
    }),
    foreignKey({
      name: 'fk_epi_ficha_estornado',
      columns: [t.registro_estornado_id],
      foreignColumns: [t.id],
    }),
    foreignKey({
      name: 'fk_epi_ficha_evento',
      columns: [t.evento_id],
      foreignColumns: [historico_evento.id],
    }),
    check('ck_ficha_tipo', sql.raw(`tipo IN (${lista_sql(TIPOS_FICHA)})`)),
    check('ck_ficha_quantidade', sql.raw(`quantidade > 0`)),
    check(
      'ck_ficha_estorno',
      sql.raw(`tipo <> 'ESTORNO' OR (registro_estornado_id IS NOT NULL AND motivo IS NOT NULL)`),
    ),
    primaryKey({ name: 'pk_epi_ficha_registro', columns: [t.id] }),
    index('ix_ficha_servidor').on(t.servidor_id, t.data_evento),
    index('ix_ficha_item').on(t.epi_item_id),
    index('ix_ficha_troca').on(t.previsao_troca),
  ],
);

/**
 * O livro razao do estoque. Append-only, como `historico_evento`.
 *
 * Saldo e SOMA de movimentos, nunca celula que se sobrescreve. Correcao e linha
 * nova de tipo `AJUSTE` com motivo — nunca rasura.
 *
 * **Reserva nao e movimento.** Reservar nao tira nada da prateleira; tira da
 * disponibilidade:
 *
 * - `saldo_fisico(entrada)` = SUM(epi_movimento_estoque.quantidade)
 * - `reservado(entrada)`    = SUM(epi_requisicao_item.quantidade_reservada)
 * - `disponivel(entrada)`   = fisico - reservado
 */
export const epi_movimento_estoque = pgTable(
  'epi_movimento_estoque',
  {
    id: bigint('id', { mode: 'number' }).notNull().generatedByDefaultAsIdentity(),
    entrada_id: integer('entrada_id').notNull(),
    tipo: varchar('tipo', { length: 12 }).notNull(),
    // positiva para o que entra, negativa para o que sai. saldo = SUM(quantidade)
    quantidade: integer('quantidade').notNull(),
    requisicao_item_id: integer('requisicao_item_id'),
    ficha_registro_id: integer('ficha_registro_id'),
    motivo: text('motivo'),
    ocorrido_em: MomentoUTC('ocorrido_em').notNull().$defaultFn(agora_utc),
    registrado_por: integer('registrado_por'),
  },
  (t) => [
    foreignKey({
      name: 'fk_epi_movimento_entrada',
      columns: [t.entrada_id],
      foreignColumns: [epi_entrada_estoque.id],
    }),
    foreignKey({
      name: 'fk_epi_movimento_requisicao_item',
      columns: [t.requisicao_item_id],
      foreignColumns: [epi_requisicao_item.id],
    }),
    foreignKey({
      name: 'fk_epi_movimento_ficha',
      columns: [t.ficha_registro_id],
      foreignColumns: [epi_ficha_registro.id],
    }),
    foreignKey({
      name: 'fk_epi_movimento_registrado_por',
      columns: [t.registrado_por],
      foreignColumns: [usuario.id],
    }),
    check('ck_mov_tipo', sql.raw(`tipo IN (${lista_sql(TIPOS_MOVIMENTO)})`)),
    check('ck_mov_quantidade', sql.raw(`quantidade <> 0`)),
    check(
      'ck_mov_sinal',
      sql.raw(
        `(tipo IN ('ENTRADA','DEVOLUCAO') AND quantidade > 0) OR ` +
          `(tipo IN ('SAIDA','DESCARTE') AND quantidade < 0) OR tipo = 'AJUSTE'`,
      ),
    ),
    // ajuste e descarte sem motivo sao saldo que sumiu sem explicacao
    check('ck_mov_motivo', sql.raw(`tipo NOT IN ('AJUSTE','DESCARTE') OR motivo IS NOT NULL`)),
    primaryKey({ name: 'pk_epi_movimento_estoque', columns: [t.id] }),
    index('ix_mov_entrada').on(t.entrada_id),
    index('ix_mov_requisicao_item').on(t.requisicao_item_id),
  ],
);

/**
 * A sequencia do protocolo `EPI-AAAA-NNNN`. Mesma disciplina da RN-03: nunca
 * `MAX(numero)+1`, e cancelar NAO devolve o numero.
 */
export const epi_requisicao_sequencia = pgTable(
  'epi_requisicao_sequencia',
  {
    ano: integer('ano').notNull(),
    ultimo_numero: integer('ultimo_numero').notNull().default(0),
  },
  (t) => [primaryKey({ name: 'pk_epi_requisicao_sequencia', columns: [t.ano] })],
);

/**
 * O envelope do pedido de EPI. Substitui `EPI_REQUISICOES`.
 *
 * **O protocolo nasce no ENVIO, nao na criacao** — consumir numero na abertura
 * da tela produziria buraco na sequencia a cada formulario abandonado.
 *
 * **O snapshot de lotacao e congelado no envio**, pelo mesmo principio da RN-15:
 * a pessoa muda de setor, e o pedido nao.
 *
 * **Nao ha coluna de CPF, CID, diagnostico nem atestado** (decisao 1, RN-21).
 */
export const epi_requisicao = pgTable(
  'epi_requisicao',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    // `EPI-2026-0001`, para ler e citar. `numero` e `ano` sao o que a sequencia
    // controla: pular numero ocupado compara INTEIRO com inteiro.
    protocolo: varchar('protocolo', { length: 16 }),
    numero: integer('numero'),
    ano: integer('ano'),

    servidor_id: integer('servidor_id').notNull(),
    // quem digitou. Pode ser a chefia pedindo pelo servidor — e por isso a RN-28
    // olha `servidor_id`, e nao esta coluna.
    solicitado_por_id: integer('solicitado_por_id').notNull(),
    chefia_servidor_id: integer('chefia_servidor_id'),

    // --- congelado no ENVIO: a pessoa muda de setor, o pedido nao ---
    unidade_uorg_id: integer('unidade_uorg_id'),
    campus_id: integer('campus_id'),
    posto_trabalho_id: integer('posto_trabalho_id'),
    cargo_snapshot: varchar('cargo_snapshot', { length: 120 }),
    funcao_snapshot: varchar('funcao_snapshot', { length: 120 }),

    finalidade: varchar('finalidade', { length: 20 }).notNull().default('ROTINA'),
    descricao_atividade: text('descricao_atividade'),
    riscos_declarados: text('riscos_declarados'),
    urgencia: varchar('urgencia', { length: 10 }).notNull().default('NORMAL'),
    justificativa_urgencia: text('justificativa_urgencia'),

    estado: varchar('estado', { length: 16 }).notNull().default('RASCUNHO'),
    estado_anterior: varchar('estado_anterior', { length: 16 }),
    entrou_no_estado_em: MomentoUTC('entrou_no_estado_em').notNull().$defaultFn(agora_utc),
    analisado_por: integer('analisado_por'),
    analisado_em: MomentoUTC('analisado_em'),
    parecer_analise: text('parecer_analise'),
    motivo_recusa_id: integer('motivo_recusa_id'),
    complemento_recusa: text('complemento_recusa'),
    motivo_cancelamento: text('motivo_cancelamento'),

    enviada_em: MomentoUTC('enviada_em'),
    criado_em: MomentoUTC('criado_em').notNull().$defaultFn(agora_utc),
    versao: integer('versao').notNull().default(1),
  },
  (t) => [
    foreignKey({ name: 'fk_epi_req_servidor', columns: [t.servidor_id], foreignColumns: [servidor.id] }),
    foreignKey({
      name: 'fk_epi_req_solicitado_por',
      columns: [t.solicitado_por_id],
      foreignColumns: [usuario.id],
    }),
    foreignKey({
      name: 'fk_epi_req_chefia',
      columns: [t.chefia_servidor_id],
      foreignColumns: [servidor.id],
    }),
    foreignKey({
      name: 'fk_epi_req_unidade',
      columns: [t.unidade_uorg_id],
      foreignColumns: [unidade_uorg.id],
    }),
    foreignKey({ name: 'fk_epi_req_campus', columns: [t.campus_id], foreignColumns: [campus.id] }),
    foreignKey({
      name: 'fk_epi_req_posto',
      columns: [t.posto_trabalho_id],
      foreignColumns: [posto_trabalho.id],
    }),
    foreignKey({
      name: 'fk_epi_req_analisado_por',
      columns: [t.analisado_por],
      foreignColumns: [usuario.id],
    }),
    foreignKey({
      name: 'fk_epi_req_motivo',
      columns: [t.motivo_recusa_id],
      foreignColumns: [epi_motivo_recusa.id],
    }),
    check('ck_req_estado', sql.raw(`estado IN (${lista_sql(ESTADOS_EPI_REQUISICAO)})`)),
    check('ck_req_urgencia', sql.raw(`urgencia IN (${lista_sql(URGENCIAS_REQUISICAO)})`)),
    check(
      'ck_req_urgencia_justificada',
      sql.raw(`urgencia <> 'URGENTE' OR justificativa_urgencia IS NOT NULL`),
    ),
    check('ck_req_finalidade', sql.raw(`finalidade IN (${lista_sql(FINALIDADES_REQUISICAO)})`)),
    // rascunho e a unica coisa sem protocolo; tudo o mais ja foi protocolado
    check('ck_req_protocolo', sql.raw(`(estado = 'RASCUNHO') = (protocolo IS NULL)`)),
    // as tres colunas do protocolo andam juntas ou nao andam
    check(
      'ck_req_numero',
      sql.raw(`(protocolo IS NULL) = (numero IS NULL) AND (protocolo IS NULL) = (ano IS NULL)`),
    ),
    check('ck_req_indeferida', sql.raw(`estado <> 'INDEFERIDA' OR motivo_recusa_id IS NOT NULL`)),
    check('ck_req_cancelada', sql.raw(`estado <> 'CANCELADA' OR motivo_cancelamento IS NOT NULL`)),
    primaryKey({ name: 'pk_epi_requisicao', columns: [t.id] }),
    unique('uq_req_protocolo').on(t.protocolo),
    unique('uq_req_numero').on(t.ano, t.numero),
    index('ix_req_estado').on(t.estado),
    index('ix_req_servidor').on(t.servidor_id),
    index('ix_req_unidade').on(t.unidade_uorg_id),
  ],
);

/**
 * A linha do pedido — e onde a decisao acontece.
 *
 * **Quatro quantidades e um estado, no lugar de doze colunas.** Quem, quando e
 * por que saem da trilha de auditoria, que e append-only e encadeada.
 */
export const epi_requisicao_item = pgTable(
  'epi_requisicao_item',
  {
    id: integer('id').notNull().generatedByDefaultAsIdentity(),
    requisicao_id: integer('requisicao_id').notNull(),
    epi_item_id: integer('epi_item_id').notNull(),
    tamanho: varchar('tamanho', { length: 20 }),

    quantidade_solicitada: smallint('quantidade_solicitada').notNull(),
    quantidade_aprovada: smallint('quantidade_aprovada'),
    quantidade_reservada: smallint('quantidade_reservada').notNull().default(0),
    quantidade_entregue: smallint('quantidade_entregue').notNull().default(0),
    entrada_id: integer('entrada_id'),

    justificativa: text('justificativa'),
    // excedeu quantidade_maxima e alguem autorizou assumindo o nome (RN-26).
    excedeu_maximo: boolean('excedeu_maximo').notNull().default(false),
    autorizado_por: integer('autorizado_por'),

    estado: varchar('estado', { length: 14 }).notNull().default('SOLICITADO'),
    motivo_recusa_id: integer('motivo_recusa_id'),
    complemento_recusa: text('complemento_recusa'),
    // texto do motivo congelado na decisao: editar o catalogo depois nao
    // reescreve a negativa que o requerente ja recebeu (RN-27, RN-15)
    texto_recusa_snapshot: text('texto_recusa_snapshot'),
    decidido_por: integer('decidido_por'),
    decidido_em: MomentoUTC('decidido_em'),
  },
  (t) => [
    foreignKey({
      name: 'fk_epi_req_item_req',
      columns: [t.requisicao_id],
      foreignColumns: [epi_requisicao.id],
    }).onDelete('cascade'),
    foreignKey({ name: 'fk_epi_req_item_epi', columns: [t.epi_item_id], foreignColumns: [epi_item.id] }),
    foreignKey({
      name: 'fk_epi_req_item_entrada',
      columns: [t.entrada_id],
      foreignColumns: [epi_entrada_estoque.id],
    }),
    foreignKey({
      name: 'fk_epi_req_item_autorizado_por',
      columns: [t.autorizado_por],
      foreignColumns: [usuario.id],
    }),
    foreignKey({
      name: 'fk_epi_req_item_motivo',
      columns: [t.motivo_recusa_id],
      foreignColumns: [epi_motivo_recusa.id],
    }),
    foreignKey({
      name: 'fk_epi_req_item_decidido_por',
      columns: [t.decidido_por],
      foreignColumns: [usuario.id],
    }),
    // NULL em `tamanho` nao colide com NULL — no PostgreSQL exatamente como no
    // SQLite, entao a semantica desta UNIQUE nao mudou no porte.
    unique('uq_req_item').on(t.requisicao_id, t.epi_item_id, t.tamanho),
    check('ck_req_item_estado', sql.raw(`estado IN (${lista_sql(ESTADOS_EPI_ITEM)})`)),
    check('ck_item_solicitada', sql.raw(`quantidade_solicitada > 0`)),
    // aprovar so reduz: aprovar MAIS do que se pediu seria o setor decidindo
    // sozinho o que a pessoa vai receber
    check(
      'ck_item_aprovada',
      sql.raw(
        `quantidade_aprovada IS NULL OR ` +
          `(quantidade_aprovada >= 0 AND quantidade_aprovada <= quantidade_solicitada)`,
      ),
    ),
    check(
      'ck_item_entregue',
      sql.raw(`quantidade_entregue <= COALESCE(quantidade_aprovada, quantidade_solicitada)`),
    ),
    check(
      'ck_item_reservada',
      sql.raw(`quantidade_reservada <= COALESCE(quantidade_aprovada, quantidade_solicitada)`),
    ),
    check(
      'ck_item_recusado',
      sql.raw(
        `estado <> 'RECUSADO' OR ` +
          `(motivo_recusa_id IS NOT NULL AND texto_recusa_snapshot IS NOT NULL)`,
      ),
    ),
    check(
      'ck_item_excecao',
      sql.raw(`NOT excedeu_maximo OR (autorizado_por IS NOT NULL AND justificativa IS NOT NULL)`),
    ),
    check('ck_item_lote', sql.raw(`estado <> 'RESERVADO' OR entrada_id IS NOT NULL`)),
    primaryKey({ name: 'pk_epi_requisicao_item', columns: [t.id] }),
    index('ix_req_item_estado').on(t.estado),
    index('ix_req_item_reserva').on(t.entrada_id, t.estado),
    index('ix_req_item_motivo').on(t.motivo_recusa_id),
  ],
);
