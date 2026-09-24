/**
 * O `dict` do Python para o template.
 *
 * Os templates portados leem dicionário como no Jinja: `d.get('x')`,
 * `d.items()`, `d.values()|sum`, `d[chave]`, `d|length`. Um objeto JS comum
 * não tem esses métodos, e trocar cada uso no template seria reescrever telas
 * inteiras. `dicionario()` devolve um objeto simples com as chaves como
 * propriedades (então `d[chave]`, `for k, v in d` e `|length` continuam
 * funcionando) e os quatro métodos NÃO enumeráveis — não aparecem no laço nem
 * na contagem.
 *
 * Existe para a tela, e só para ela: serviço continua devolvendo `Map`/objeto.
 */
export type Dicionario<V> = Record<string, V> & {
  get(chave: unknown, padrao?: V | null): V | null;
  items(): [string, V][];
  keys(): string[];
  values(): V[];
};

export function dicionario<V>(origem: Record<string, V> | Map<unknown, V> | null | undefined = {}): Dicionario<V> {
  const alvo: Record<string, V> = {};
  const entradas: [unknown, V][] = origem instanceof Map ? [...origem.entries()] : Object.entries(origem ?? {});
  for (const [k, v] of entradas) alvo[String(k)] = v;
  const metodos: PropertyDescriptorMap = {
    get: {
      value: (chave: unknown, padrao: V | null = null) =>
        Object.hasOwn(alvo, String(chave)) ? alvo[String(chave)] : padrao,
    },
    items: { value: () => Object.entries(alvo) },
    keys: { value: () => Object.keys(alvo) },
    values: { value: () => Object.values(alvo) },
  };
  Object.defineProperties(alvo, metodos);
  return alvo as Dicionario<V>;
}
