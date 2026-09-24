/**
 * Constantes e `@property` de `app/modelos/organizacao.py`.
 *
 * Os padroes ficam SEM ancora, como no Python: quem valida em codigo usa
 * `confere_regex` (que ancora sozinho), e o `CHECK` do banco recebe a versao
 * ancorada por `check_regex`.
 */

export const PADRAO_SIAPE = String.raw`\d{7}`;

type Periodo = { vigencia_inicio: string; vigencia_fim: string | null };

/** `vigente_em` repetido em quatro classes do Python; a regra e uma so. */
export function vigente_em(periodo: Periodo, quando: string): boolean {
  return (
    periodo.vigencia_inicio <= quando && (periodo.vigencia_fim === null || periodo.vigencia_fim >= quando)
  );
}

export const UnidadeUorg = {
  /** '250 - FACULDADE DE MEDICINA DE DIAMANTINA' (formato da coluna I). */
  uorg_bruto(unidade: { codigo_uorg: string | null; nome_oficial: string }): string {
    return unidade.codigo_uorg ? `${unidade.codigo_uorg} - ${unidade.nome_oficial}` : unidade.nome_oficial;
  },
};

export const ServidorLotacao = {
  /**
   * Os postos do periodo, na ordem de `lotacao_posto.ordem`. Exige a relacao
   * `vinculos_posto: { with: { posto: true }, orderBy: ordem }` carregada.
   */
  postos<P>(lotacao: { vinculos_posto: ReadonlyArray<{ posto: P }> }): P[] {
    return lotacao.vinculos_posto.map((vinculo) => vinculo.posto);
  },
  aberta(lotacao: { vigencia_fim: string | null }): boolean {
    return lotacao.vigencia_fim === null;
  },
  vigente_em,
};
