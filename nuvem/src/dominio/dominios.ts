/**
 * O que em `app/modelos/dominios.py` era logica, e nao coluna.
 *
 * As `@property` do SQLAlchemy viram funcoes puras agrupadas pelo nome da classe
 * Python (`ChecklistModelo.lista_de_itens(modelo)`), porque a linha que o Drizzle
 * devolve e objeto simples, sem metodo. Template que fazia
 * `modelo.lista_de_itens` passa a receber o valor ja calculado pela rota.
 */

type ComItens = { itens: string | null };

export const ChecklistModelo = {
  lista_de_itens(modelo: ComItens): string[] {
    return linhas(modelo.itens);
  },
};

/** `[linha.strip() for linha in texto.splitlines() if linha.strip()]`. */
export function linhas(texto: string | null | undefined): string[] {
  return (texto ?? '')
    .split(/\r\n|\r|\n/)
    .map((linha) => linha.trim())
    .filter((linha) => linha.length > 0);
}
