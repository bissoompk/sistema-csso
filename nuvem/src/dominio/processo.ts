/** Constantes e `@property` de `app/modelos/processo.py`. Padroes SEM ancora. */

export const PADRAO_NUP = String.raw`23086\.\d{6}/\d{4}-\d{2}`;
export const PADRAO_LAUDO = String.raw`\d{5}-\d{3}\.\d{3}/\d{4}`;
export const PADRAO_PARECER = String.raw`\d+/\d{4}`;

export const ParecerTecnico = {
  rotulo(parecer: { numero: number; ano: number }): string {
    return `${parecer.numero}/${parecer.ano}`;
  },
};

/**
 * A categoria do anexo como a tela a escreve. A chave é a do banco (o `CHECK`
 * de `ck_anexo_cat`, a lista de `dominio/auditoria`) e não muda; o que muda é
 * só o que a pessoa lê — "Formulário", e não FORMULARIO. Categoria sem rótulo
 * aqui cai no código cru, e o teste da ficha confere que as do processo têm.
 */
export const ROTULO_CATEGORIA_ANEXO_TELA: Readonly<Record<string, string>> = Object.freeze({
  PARECER_ASSINADO: "Parecer assinado",
  LAUDO: "Laudo",
  PORTARIA: "Portaria de localização",
  DESPACHO: "Despacho",
  FORMULARIO: "Formulário",
  RELATORIO_CAMPO: "Relatório de campo",
  FOTO: "Foto",
  OUTRO: "Outro",
  MANUAL_EPI: "Manual do EPI",
  FICHA_EPI: "Ficha de EPI",
  RUBRICA_INSTRUTOR: "Rubrica do instrutor",
  LISTA_PRESENCA: "Lista de presença",
  CERTIFICADO: "Certificado",
  CAT_SP: "CAT / Comunicação de acidente",
  RELATORIO_INVESTIGACAO: "Relatório de investigação",
  EVIDENCIA_ACIDENTE: "Evidência do acidente",
});
