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
    // NUVEM (23/10/2026): o aviso que só faz sentido na hora (o de cadastro
    // existente do link público) vence — com o envio desligado ele ficaria
    // na fila e sairia dias depois. Vencido, sai como CANCELADO, sem envio.
    expira_em: MomentoUTC('expira_em'),
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

/**
 * "Ativar meu acesso / Esqueci minha senha" (23/10/2026,
 * `servicos/ativar_acesso.ts`). Cada pedido que passou pelo teto por endereço
 * de rede deixa UMA linha (o contador do teto mora no banco, não na memória da
 * instância); só a que gerou link guarda o SHA-256 do token e o servidor (sem chave estrangeira: é registro de pedido, apagado em 7 dias). O
 * token vale uma vez e pouco tempo. Sem e-mail digitado, sem SIAPE, sem nome:
 * a linha não diz de quem foi o pedido que não casou. A rotina de privacidade
 * apaga em 7 dias.
 */
export const ativacao_acesso = pgTable(
  'ativacao_acesso',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    token_hash: varchar('token_hash', { length: 64 }).unique('uq_ativacao_acesso_token'),
    servidor_id: integer('servidor_id'),
    // o link de uma CONTA (Esqueci minha senha por e-mail; a conta aprovada do
    // Cadastre-se): o alvo é a conta, não o cadastro de servidor
    usuario_id: integer('usuario_id'),
    // a troca de e-mail em Meus dados: o endereço novo só vale quando o link
    // enviado a ELE é aberto pela própria conta (resultado EMAIL)
    email_novo: varchar('email_novo', { length: 160 }),
    // o que o pedido virou: LINK (e-mail com link na fila), NEUTRO (e-mail "procure a
    // equipe"), SEM_EMAIL (SIAPE e e-mail batem, mas o cadastro não tem e-mail — a
    // equipe vê), NADA (não casou, ou passou do teto por destinatário)
    resultado: varchar('resultado', { length: 10 }).notNull().default('NADA'),
    expira_em: MomentoUTC('expira_em'),
    usado_em: MomentoUTC('usado_em'),
    ip: text('ip'),
    criado_em: MomentoUTC('criado_em').notNull().$defaultFn(agora_utc),
  },
  (t) => [
    index('ix_ativacao_acesso_ip').on(t.ip, t.criado_em),
    index('ix_ativacao_acesso_servidor').on(t.servidor_id, t.criado_em),
    index('ix_ativacao_acesso_usuario').on(t.usuario_id, t.criado_em),
  ],
);

/**
 * O pedido de conta do Cadastre-se (terceirizado e discente; 23/10/2026,
 * `servicos/pedido_conta.ts`). Nada nasce dele sozinho: a equipe confere e
 * aprova (cria a conta, `usuario_id`) ou recusa. DESCARTADO é o pedido de
 * e-mail que já estava no sistema: fica só para o teto por endereço de rede,
 * sem nada da pessoa. A rotina de privacidade apaga em 90 dias.
 */
export const pedido_conta = pgTable(
  'pedido_conta',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    vinculo: varchar('vinculo', { length: 12 }).notNull(),
    nome: varchar('nome', { length: 160 }).notNull(),
    email: varchar('email', { length: 160 }).notNull(),
    email_normalizado: varchar('email_normalizado', { length: 160 }).notNull(),
    // a empresa do terceirizado ou o curso do discente
    organizacao: varchar('organizacao', { length: 160 }).notNull(),
    // o setor do terceirizado ou a matrícula do discente (opcional)
    matricula: varchar('matricula', { length: 30 }),
    situacao: varchar('situacao', { length: 12 }).notNull().default('PENDENTE'),
    motivo: text('motivo'),
    decidido_por: integer('decidido_por'),
    decidido_em: MomentoUTC('decidido_em'),
    usuario_id: integer('usuario_id'),
    ip: text('ip'),
    criado_em: MomentoUTC('criado_em').notNull().$defaultFn(agora_utc),
  },
  (t) => [
    foreignKey({ name: 'fk_pedido_conta_decidido_por', columns: [t.decidido_por], foreignColumns: [usuario.id] }),
    foreignKey({ name: 'fk_pedido_conta_usuario', columns: [t.usuario_id], foreignColumns: [usuario.id] }).onDelete('set null'),
    check('ck_pedido_conta_vinculo', sql.raw(`vinculo IN ('TERCEIRIZADO','DISCENTE')`)),
    check('ck_pedido_conta_situacao', sql.raw(`situacao IN ('PENDENTE','APROVADO','RECUSADO','DESCARTADO')`)),
    index('ix_pedido_conta_situacao').on(t.situacao, t.criado_em),
    index('ix_pedido_conta_ip').on(t.ip, t.criado_em),
    index('ix_pedido_conta_email').on(t.email_normalizado),
  ],
);
