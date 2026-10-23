/** Constantes e metodos de `app/modelos/auditoria.py`. */

import { hoje_iso } from './datas';

/**
 * As categorias que `ck_anexo_cat` admite, na ordem do modelo Python. As oito
 * primeiras sao do Processos SEI; as oito seguintes entraram de uma vez para
 * EPI, Certificados e Acidentes; `EPI_CATALOGO` entrou em 22/10/2026. E a mesma lista de `anexos.CATEGORIAS` do
 * servico Python — quem portar `servicos/anexos.py` deve le-la DAQUI, e nao
 * escrever uma segunda.
 */
export const CATEGORIAS_ANEXO = [
  'PARECER_ASSINADO',
  'LAUDO',
  'PORTARIA',
  'DESPACHO',
  'FORMULARIO',
  'RELATORIO_CAMPO',
  'FOTO',
  'OUTRO',
  'MANUAL_EPI',
  'FICHA_EPI',
  'RUBRICA_INSTRUTOR',
  'LISTA_PRESENCA',
  'CERTIFICADO',
  'CAT_SP',
  'RELATORIO_INVESTIGACAO',
  'EVIDENCIA_ACIDENTE',
  // 22/10/2026 (paridade com o IntegraSST, migração 0015): a foto e o PDF de
  // orientação do catálogo de EPI. Público dentro do sistema: não nomeia pessoa.
  'EPI_CATALOGO',
] as const;

export const Pendencia = {
  /** Vermelho na tela. `hoje` no fuso de negocio, e nao no UTC do servidor. */
  atrasada(pendencia: { concluida: boolean; prazo: string | null }, hoje: string = hoje_iso()): boolean {
    if (pendencia.concluida || pendencia.prazo === null) return false;
    return pendencia.prazo < hoje;
  },
};
