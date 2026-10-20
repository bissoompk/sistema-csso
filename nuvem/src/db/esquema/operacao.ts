/**
 * Operação da instalação: a marca de produção e o registro das rotinas
 * agendadas. Não existe no Python — lá a instalação de produção era OUTRA
 * pasta (`dados/`) numa máquina do setor, e a de teste era `dados-teste/`; o
 * isolamento era de disco. Na nuvem o que separa uma da outra é o banco, e o
 * banco tem de dizer de si mesmo o que é.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, integer, pgTable, smallint, text, varchar } from 'drizzle-orm/pg-core';

import { MomentoUTC, agora_utc } from './base';
import { usuario } from './seguranca';
import { certificado, inscricao } from './treinamento';

/**
 * A marca de produção: UMA linha (id = 1), gravada por
 * `ferramentas/producao-iniciar.ts`. Enquanto ela existir, nenhuma ferramenta
 * que recria ou apaga o banco (`ambiente-teste`, `producao-iniciar`) roda
 * nele — nem com `--permitir-remoto`. É a trava que separa "banco de teste no
 * Supabase" de "banco com dado real de servidor" (LGPD).
 *
 * `travas.sql` recusa UPDATE, DELETE e TRUNCATE: a marca não se desfaz pela
 * aplicação. Desfazer é gesto manual e deliberado no editor SQL, descrito em
 * `PRODUCAO.md`.
 */
export const instalacao = pgTable(
  'instalacao',
  {
    id: smallint('id').primaryKey().default(1),
    ambiente: varchar('ambiente', { length: 16 }).notNull(),
    // o banco que foi marcado, como a ferramenta o identificou (ref do projeto
    // Supabase, ou host/banco) — para um backup restaurado noutro lugar se
    // denunciar como vindo de produção
    identidade: text('identidade').notNull(),
    marcada_em: MomentoUTC('marcada_em').notNull().$defaultFn(agora_utc),
    marcada_por: text('marcada_por').notNull(),
  },
  () => [
    check('ck_instalacao_unica', sql.raw(`id = 1`)),
    check('ck_instalacao_ambiente', sql.raw(`ambiente IN ('PRODUCAO')`)),
  ],
);

/**
 * Cada passada de rotina agendada (backup, retenção de backups, expurgo de
 * sessões, conferência da cadeia, varredura de pendências). É o que se olha
 * para saber se o backup de ontem rodou — a função agendada do Netlify não
 * avisa ninguém quando falha. Sem dado pessoal: `detalhe` é resumo numérico.
 */
export const rotina_execucao = pgTable(
  'rotina_execucao',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    rotina: varchar('rotina', { length: 40 }).notNull(),
    iniciada_em: MomentoUTC('iniciada_em').notNull().$defaultFn(agora_utc),
    concluida_em: MomentoUTC('concluida_em').notNull().$defaultFn(agora_utc),
    duracao_ms: integer('duracao_ms').notNull(),
    ok: boolean('ok').notNull(),
    detalhe: text('detalhe'),
  },
  (t) => [index('ix_rotina_execucao_rotina').on(t.rotina, t.id)],
);

/**
 * A caixa de saída de e-mail (NUVEM). Quem pede o envio grava a linha; quem
 * envia é a função de fundo `email-background` (e, de reserva, a agendada
 * `email-agendado`), fora da requisição — o PDF do certificado e o SMTP não
 * cabem no tempo de uma tela. Ver `servicos/email.ts`.
 *
 * `corpo` leva o nome da pessoa; a rotina de privacidade o apaga depois de
 * 90 dias e a linha fica como registro de que houve o envio.
 */
export const email_saida = pgTable(
  'email_saida',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    tipo: varchar('tipo', { length: 30 }).notNull(),
    destinatario: varchar('destinatario', { length: 160 }).notNull(),
    assunto: varchar('assunto', { length: 200 }).notNull(),
    corpo: text('corpo'),
    certificado_id: integer('certificado_id'),
    inscricao_id: integer('inscricao_id'),
    situacao: varchar('situacao', { length: 12 }).notNull().default('PENDENTE'),
    tentativas: smallint('tentativas').notNull().default(0),
    // também é a "posse": quem pega a linha a empurra para frente, e outro
    // envio em paralelo não a vê até lá
    proxima_tentativa_em: MomentoUTC('proxima_tentativa_em').notNull().$defaultFn(agora_utc),
    ultimo_erro: text('ultimo_erro'),
    criado_por: integer('criado_por'),
    criado_em: MomentoUTC('criado_em').notNull().$defaultFn(agora_utc),
    enviado_em: MomentoUTC('enviado_em'),
  },
  (t) => [
    foreignKey({ name: 'fk_email_saida_criado_por', columns: [t.criado_por], foreignColumns: [usuario.id] }),
    foreignKey({ name: 'fk_email_saida_certificado', columns: [t.certificado_id], foreignColumns: [certificado.id] }),
    foreignKey({ name: 'fk_email_saida_inscricao', columns: [t.inscricao_id], foreignColumns: [inscricao.id] }).onDelete(
      'set null',
    ),
    check('ck_email_saida_situacao', sql.raw(`situacao IN ('PENDENTE','ENVIADO','FALHOU','CANCELADO')`)),
    check('ck_email_saida_enviado', sql.raw(`situacao <> 'ENVIADO' OR enviado_em IS NOT NULL`)),
    index('ix_email_saida_fila').on(t.situacao, t.proxima_tentativa_em),
    index('ix_email_saida_certificado').on(t.certificado_id),
  ],
);

/**
 * O link de acesso do participante sem conta aos próprios certificados
 * (NUVEM; `servicos/acesso_participante.ts`). Quem prova ser o dono é a caixa
 * de e-mail: o link vai para o endereço cadastrado, e o banco guarda só o
 * SHA-256 do token. A rotina de privacidade apaga a linha em 7 dias.
 */
export const acesso_participante = pgTable(
  'acesso_participante',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    token_hash: varchar('token_hash', { length: 64 }).notNull().unique('uq_acesso_participante_token'),
    email_normalizado: varchar('email_normalizado', { length: 160 }).notNull(),
    expira_em: MomentoUTC('expira_em').notNull(),
    ip: text('ip'),
    usado_em: MomentoUTC('usado_em'),
    criado_em: MomentoUTC('criado_em').notNull().$defaultFn(agora_utc),
  },
  (t) => [index('ix_acesso_participante_email').on(t.email_normalizado, t.criado_em)],
);
