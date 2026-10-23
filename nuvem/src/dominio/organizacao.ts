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

// =====================================================================
// Portal do servidor (22/10/2026) — cor e icone do setor promotor
// =====================================================================

/**
 * A paleta FECHADA de cores do setor promotor (proposta em DESVIOS.md, "Portal
 * do servidor"): o banco guarda a CHAVE, e a cor de verdade mora em
 * `csso.css` (`.setor--{chave}`), com a versao clara e a escura — cor solta
 * digitada nao passa pelo contraste AA. Sem cor, o setor usa a do sistema.
 */
export const CORES_SETOR = ['azul', 'verde', 'petroleo', 'roxo', 'marinho', 'vinho', 'ambar', 'grafite'] as const;
export type CorSetor = (typeof CORES_SETOR)[number];
export const ROTULO_COR_SETOR: Readonly<Record<CorSetor, string>> = {
  azul: 'Azul',
  verde: 'Verde',
  petroleo: 'Verde-petróleo',
  roxo: 'Roxo',
  marinho: 'Azul-marinho',
  vinho: 'Vinho',
  ambar: 'Âmbar',
  grafite: 'Grafite',
};

/** Os icones que o setor pode escolher (todos da folha `icones.svg`). */
export const ICONES_SETOR = [
  'shield-plus',
  'heart-pulse',
  'clipboard2-check',
  'mortarboard',
  'building',
  'people',
  'award',
  'journal-bookmark',
  'person-badge',
] as const;
export type IconeSetor = (typeof ICONES_SETOR)[number];
export const ROTULO_ICONE_SETOR: Readonly<Record<IconeSetor, string>> = {
  'shield-plus': 'Escudo (segurança)',
  'heart-pulse': 'Coração (saúde)',
  'clipboard2-check': 'Prancheta (perícia)',
  mortarboard: 'Capelo (educação)',
  building: 'Prédio (secretaria)',
  people: 'Pessoas',
  award: 'Medalha',
  'journal-bookmark': 'Caderno',
  'person-badge': 'Crachá',
};

/**
 * A proposta inicial (migração 0016 e semente), pelo nome oficial: a equipe
 * troca em Treinamentos → Setores promotores.
 */
export const APARENCIA_SETOR_INICIAL: Readonly<Record<string, { cor: CorSetor; icone: IconeSetor }>> = {
  'COORDENADORIA DE SEGURANCA E SAUDE OCUPACIONAL': { cor: 'azul', icone: 'shield-plus' },
  'COORDENADORIA DE SAUDE E QUALIDADE DE VIDA': { cor: 'verde', icone: 'heart-pulse' },
  'COORDENADORIA DE PERICIA OFICIAL EM SAUDE': { cor: 'petroleo', icone: 'clipboard2-check' },
  'COORDENADORIA DE PROMOCAO E EDUCACAO EM SAUDE': { cor: 'roxo', icone: 'mortarboard' },
  'SECRETARIA DA SISA': { cor: 'marinho', icone: 'building' },
};
