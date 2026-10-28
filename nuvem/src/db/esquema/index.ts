/**
 * O esquema inteiro, num ponto so — e o que o drizzle-kit le e o que se passa ao
 * `drizzle(cliente, { schema })` para o `db.query` enxergar as relacoes.
 *
 * Mesma funcao do `app/modelos/__init__.py`: importar daqui registra tudo.
 */

export * from './base';
export * from './dominios';
export * from './organizacao';
export * from './seguranca';
export * from './processo';
export * from './auditoria';
export * from './demanda';
export * from './epi';
export * from './acidente';
export * from './treinamento';
export * from './operacao';
export * from './privacidade';
export * from './vitrine_aviso';
export * from './relacoes';
