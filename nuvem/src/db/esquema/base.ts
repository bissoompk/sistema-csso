/**
 * Tipos portateis, `agora_utc` e o CHECK de regex — porte de `app/modelos/base.py`.
 *
 * No Python o DDL de referencia ja era PostgreSQL, mas rodava em SQLite, e os
 * `TypeDecorator` faziam a traducao (data como TEXT, JSON como TEXT...). Aqui o
 * banco E o PostgreSQL, entao cada tipo vira o tipo nativo correspondente. Os
 * nomes das fabricas continuam os do Python (`MomentoUTC('criado_em')`) para
 * que o porte dos modelos se leia linha a linha contra o original.
 */

import { sql } from 'drizzle-orm';
import { type AnyPgColumn, check, date, foreignKey, jsonb, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Agora, em UTC, sem fracao de segundo.
 *
 * O Python cortava o microssegundo (`replace(microsecond=0)`), e o valor em
 * memoria entra no digest de `historico_evento`. Cortar tambem aqui mantem o
 * que se grava igual ao que se digere — o `timestamptz` do PostgreSQL guardaria
 * a fracao, e a conferencia da cadeia leria de volta um instante diferente do
 * que foi assinado.
 */
export function agora_utc(): Date {
  const agora = new Date();
  agora.setUTCMilliseconds(0);
  return agora;
}

/** timestamptz. No SQLite era TEXT ISO-8601; aqui e o tipo nativo. */
export const MomentoUTC = (nome: string) => timestamp(nome, { withTimezone: true, mode: 'date' });

/**
 * DATE de negocio: sem hora, sem fuso (RN-18).
 *
 * `mode: 'string'` e o ponto inteiro: a planilha guarda 11/02/2026 00:00, e
 * converter para `Date` do JavaScript (que e um instante, e portanto tem fuso)
 * viraria 10/fev na primeira conta feita em UTC-3. A data circula como
 * 'AAAA-MM-DD' literal do banco a tela, e comparar duas delas e comparar texto.
 */
export const DataPura = (nome: string) => date(nome, { mode: 'string' });

/**
 * jsonb. No Python era TEXT com `json.dumps(sort_keys=True, default=str)`.
 *
 * Duas diferencas que quem porta servico PRECISA saber, porque as duas mexem no
 * digest de `historico_evento.valor_anterior/valor_novo`:
 *
 * 1. `default=str` virava `Decimal` e `date` em texto na ida. O jsonb nao faz
 *    isso por ninguem: converta antes de gravar (numeric ja chega como string
 *    do driver; `Date` NAO pode entrar cru, ou vira ISO com hora).
 * 2. O jsonb reordena as chaves (por tamanho, depois por byte) e descarta
 *    espacos. O que se le NAO e o texto que se gravou — o digest tem de ser
 *    calculado sobre uma serializacao canonica feita em codigo (chaves
 *    ordenadas), nunca sobre o texto devolvido pelo banco.
 */
export const JSONTexto = <T = unknown>(nome: string) => jsonb(nome).$type<T>();

/** O Python declarava `Inet` sobre TEXT; continua texto (o valor vem do proxy). */
export const Inet = (nome: string) => text(nome);

/**
 * Prende o padrao a string inteira, para o `~` casar o que `fullmatch` casa.
 *
 * O operador `~` do PostgreSQL casa **substring**, nao string inteira: sem
 * ancora, `siape ~ '\d{7}'` aceita 'abc1234567xyz'. Constraint que nao
 * constrange e pior que constraint nenhuma, porque da confianca falsa a quem le
 * o esquema.
 *
 * O grupo `(?:…)` nao e enfeite: e ele que faz a ancora valer para a
 * alternancia inteira. Em `^a|b$` o `^` prende so o `a` e o `$` so o `b`.
 */
export function ancorar(padrao: string): string {
  return `^(?:${padrao})$`;
}

/**
 * CHECK com o operador `~`. No SQLite ela nao existia (a validacao real vivia no
 * validador Python); aqui ela vale de verdade — e a primeira vez que o banco
 * cobra o formato do SIAPE, do NUP, do laudo e da chave do certificado.
 *
 * O padrao chega SEM ancora e sai ancorado so no texto que vai ao banco, como
 * no Python: quem valida em codigo usa `confere_regex`, que ancora sozinho.
 * Os padroes sao escritos com `String.raw` e vao literais para o DDL; com
 * `standard_conforming_strings` (o padrao do PostgreSQL) a barra invertida
 * chega intacta ao motor de regex.
 */
export function check_regex(nome: string, coluna: string, padrao: string) {
  return check(nome, sql.raw(`${coluna} ~ '${ancorar(padrao)}'`));
}

/** `re.fullmatch` do Python: o padrao tem de cobrir a string inteira. */
export function confere_regex(valor: string | null | undefined, padrao: string): boolean {
  return valor != null && new RegExp(ancorar(padrao)).test(valor);
}

/**
 * A lista SQL `'A','B','C'` montada a partir da tupla de dominio.
 *
 * O `CHECK` sai da MESMA tupla que a maquina de estados e o formulario usam, e
 * nao de uma segunda lista escrita a mao: duas listas do mesmo conjunto divergem
 * no dia em que alguem acrescenta valor a uma so, e a tela passaria a oferecer o
 * que o banco recusa — na cara de quem opera.
 */
export function lista_sql(valores: readonly string[]): string {
  return valores.map((valor) => `'${valor.replaceAll("'", "''")}'`).join(',');
}

/**
 * FK nomeada que FECHA um ciclo de tabelas (`treinamento` <-> `certificado_modelo`,
 * `participante` <-> `participante_email`).
 *
 * E o `foreignKey()` do Drizzle com o alvo atras de uma funcao de retorno
 * anotado: sem a anotacao, o TypeScript tenta inferir o tipo de cada tabela a
 * partir da outra e desiste (TS7022). O alvo so e lido quando o drizzle-kit
 * monta o esquema, depois de os dois `pgTable` existirem.
 */
export function fk_ciclo(nome: string, coluna: AnyPgColumn, alvo: () => AnyPgColumn) {
  return foreignKey({ name: nome, columns: [coluna], foreignColumns: [alvo()] });
}
