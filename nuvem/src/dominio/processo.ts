/** Constantes e `@property` de `app/modelos/processo.py`. Padroes SEM ancora. */

export const PADRAO_NUP = String.raw`23086\.\d{6}/\d{4}-\d{2}`;
export const PADRAO_LAUDO = String.raw`\d{5}-\d{3}\.\d{3}/\d{4}`;
export const PADRAO_PARECER = String.raw`\d+/\d{4}`;

export const ParecerTecnico = {
  rotulo(parecer: { numero: number; ano: number }): string {
    return `${parecer.numero}/${parecer.ano}`;
  },
};
