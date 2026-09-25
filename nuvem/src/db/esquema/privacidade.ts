/**
 * Registro de acesso HTTP — o `dados/logs/acesso.log` do Python
 * (`app/registro_acesso.py`), em tabela.
 *
 * Na máquina do setor era um arquivo com rotação diária e 90 arquivos. Na
 * nuvem não há disco que dure (a função do Netlify é efêmera) e o log da
 * plataforma não é lugar de dado pessoal nem tem prazo que o setor controle.
 * Por isso vira tabela no mesmo banco — sob o mesmo RLS, a mesma cifra de
 * backup e o mesmo controlador —, com expurgo automático no prazo da política
 * (`servicos/registro_acesso.ts`).
 *
 * O que entra é EXATAMENTE o que o Python gravava, e o que ele deliberadamente
 * não gravava continua fora (ROPA §0.3): nunca nome, SIAPE, login, e-mail,
 * query string, corpo, nem o caminho concreto — a rota vai na FORMA
 * (`/servidores/{id}`), e o que não casou rota nenhuma sai como `-`.
 *
 * Sem chave estrangeira para `usuario`: o registro sobrevive à conta e não
 * trava nada; `conta_id` é só o número.
 */

import { index, integer, pgTable, smallint, varchar } from 'drizzle-orm/pg-core';

import { MomentoUTC, agora_utc } from './base';

export const registro_acesso = pgTable(
  'registro_acesso',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    momento: MomentoUTC('momento').notNull().$defaultFn(agora_utc),
    // oito dígitos hexadecimais, para correlacionar com a tela de erro
    req: varchar('req', { length: 16 }).notNull(),
    // o endereço de origem como o Netlify o entrega (`x-nf-client-connection-ip`);
    // texto, porque vem de cabeçalho
    ip: varchar('ip', { length: 64 }).notNull(),
    conta_id: integer('conta_id'),
    metodo: varchar('metodo', { length: 8 }).notNull(),
    rota: varchar('rota', { length: 200 }).notNull(),
    status: smallint('status').notNull(),
    duracao_ms: integer('duracao_ms').notNull(),
  },
  (t) => [index('ix_registro_acesso_momento').on(t.momento), index('ix_registro_acesso_conta').on(t.conta_id, t.momento)],
);
