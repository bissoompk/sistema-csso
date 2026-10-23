/**
 * Liberação de módulo por módulo (22/10/2026) — O MAPA, num lugar só.
 *
 * A coordenação escolhe, para cada módulo do menu, um de três níveis:
 *
 * - **Sem acesso**: nenhuma permissão do módulo;
 * - **Consulta**: as permissões de LEITURA do módulo (`*.ver` e equivalentes);
 * - **Operação**: todas as do módulo — a consulta e as de escrita.
 *
 * O nível vale por PERFIL (`perfil_nivel_modulo`) e, por cima dele, por PESSOA
 * (`usuario_nivel_modulo`, a exceção que dá ou retira). Linha ausente é "o
 * padrão": no perfil, as permissões de `perfil_permissao`, exatamente como
 * eram até aqui (por isso a implantação não muda o acesso de ninguém); na
 * pessoa, "seguir o perfil".
 *
 * O que NÃO se libera por módulo e continua vindo só do perfil
 * (`PERMISSOES_SO_DO_PERFIL`): o escopo de cada uma (campus, equipe, próprio),
 * a assinatura e a habilitação profissional (IN 15/2022), a administração de
 * acesso e do sistema, o dado nominal (RN-19) e as transversais (indicadores,
 * exportação, catálogos da base). Elas atravessam módulos, ou dependem de
 * cargo, ou dariam a quem recebe o poder de mudar o próprio acesso.
 *
 * O cálculo (`permissoes_com_niveis`) é aplicado a cada concessão de perfil em
 * `rbac.perfis_vigentes`, e por isso o menu, as rotas, o `pode()` dos
 * templates e as comparações de governança ("ninguém concede mais do que tem")
 * enxergam o efeito sem mudar nada: perfil → nível do módulo → exceção da pessoa.
 *
 * Este arquivo não importa nada do RBAC (para `rbac.ts` poder importá-lo); a
 * conferência contra `PERMISSOES` mora lá (`_conferir_niveis`).
 */

export const SEM_ACESSO = "SEM_ACESSO";
export const CONSULTA = "CONSULTA";
export const OPERACAO = "OPERACAO";
export type Nivel = typeof SEM_ACESSO | typeof CONSULTA | typeof OPERACAO;
export const NIVEIS: readonly Nivel[] = [SEM_ACESSO, CONSULTA, OPERACAO];

/** O padrão do perfil que não é nenhum dos três: um pedaço do módulo. */
export const PARCIAL = "PARCIAL";

export const ROTULO_NIVEL: Readonly<Record<string, string>> = {
  [SEM_ACESSO]: "Sem acesso",
  [CONSULTA]: "Consulta",
  [OPERACAO]: "Operação",
  [PARCIAL]: "Parcial",
};

export function eh_nivel(valor: string): valor is Nivel {
  return (NIVEIS as readonly string[]).includes(valor);
}

export interface ModuloNivelado {
  /** o código do módulo em `modulos.ts` (ou da base, para Demandas) */
  readonly codigo: string;
  readonly nome: string;
  /** "Consulta": as de leitura */
  readonly consulta: readonly string[];
  /** "Operação" = `consulta` + estas */
  readonly escrita: readonly string[];
}

/**
 * O MAPEAMENTO módulo → permissões. Os conjuntos são disjuntos entre módulos
 * (conferido em `rbac._conferir_niveis`): uma permissão pertence a um módulo só.
 * Os três módulos ainda não disponíveis (Acidentes, CISSP, PGR) não têm
 * permissão nenhuma e por isso não aparecem.
 */
export const MODULOS_NIVELADOS: readonly ModuloNivelado[] = Object.freeze([
  {
    codigo: "processos-sei",
    nome: "Processos SEI",
    consulta: ["processo.ver", "parecer.ver", "laudo.ver"],
    escrita: [
      "processo.criar",
      "processo.editar",
      "processo.status",
      "processo.atribuir",
      "parecer.criar",
      "parecer.editar",
      "parecer.emitir",
      "parecer.anular",
      "anexo.enviar",
    ],
  },
  {
    codigo: "epis",
    nome: "Gestão de EPI",
    // `epi.ficha` é leitura (a ficha de outro servidor), e por isso consulta:
    // ler a de outro continua caindo em `acesso_dado_sensivel` (RN-23)
    consulta: ["epi.ver", "epi.ficha"],
    escrita: ["epi.catalogo", "epi.entregar", "epi.estoque", "epi.requisitar", "epi.analisar"],
  },
  {
    codigo: "certificados",
    nome: "Certificados e Treinamentos",
    consulta: ["treinamento.ver", "certificado.ver"],
    escrita: [
      "treinamento.gerenciar",
      "turma.criar",
      "turma.inscrever",
      "turma.concluir",
      "turma.avaliar",
      "certificado.emitir",
      "certificado.anular",
      "participante.mesclar",
    ],
  },
  {
    codigo: "demandas",
    nome: "Demandas",
    consulta: ["demanda.ver"],
    escrita: ["demanda.registrar"],
  },
]);

/**
 * As que nunca se liberam por módulo — vêm só do perfil (e do vínculo do
 * titular). Toda permissão de `PERMISSOES` está OU num módulo OU aqui
 * (`rbac._conferir_niveis`): permissão nova obriga a decidir.
 */
export const PERMISSOES_SO_DO_PERFIL: Readonly<Record<string, string>> = Object.freeze({
  "parecer.assinar": "assinatura — exige habilitação técnica (IN 15/2022, art. 10, §2º, I)",
  "laudo.criar": "habilitação profissional — exige habilitação técnica (IN 15/2022)",
  "assinatura.gerenciar": "assinatura — a rubrica de instrutor no certificado",
  "habilitacao.atestar": "administração de acesso — atesta habilitação técnica",
  "usuario.criar_conta": "administração de acesso",
  "usuario.resetar_senha": "administração de acesso",
  "perfil.conceder": "administração de acesso",
  "auditoria.ver": "administração do sistema — a trilha",
  "backup.executar": "administração do sistema",
  "exposicao.ver": "dado nominal e de exposição: segue o cargo, não o módulo",
  "indicador.ver": "transversal — indicadores de todos os módulos",
  exportar: "transversal — exportação de todos os módulos",
  "catalogo.gerenciar": "configuração do setor e catálogos da base",
  "turma.inscrever_se": "do titular — inscrever a si mesmo",
  "turma.todos_os_setores": "alcance de setor — ver as turmas de todos os setores promotores",
});

/**
 * O perfil que está SEMPRE no nível mais alto de cada módulo, sem ajuste: o
 * Administrador do sistema (23/10/2026) — Operação em todos. Nem o nível do
 * perfil nem a exceção da pessoa valem sobre ele (`rbac.aceita_nivel_modulo`
 * devolve `false`), e as permissões que não são de módulo vêm todas do perfil.
 * O código fica aqui escrito (este arquivo não importa o RBAC);
 * `perfil_admin_sistema.test.ts` confere que é `rbac.PERFIL_ADMINISTRADOR_SISTEMA`.
 */
export const PERFIS_NO_NIVEL_MAIS_ALTO: Readonly<Record<string, Readonly<Record<string, Nivel>>>> = Object.freeze({
  administrador_sistema: Object.freeze(
    Object.fromEntries(MODULOS_NIVELADOS.map((m) => [m.codigo, OPERACAO as Nivel])),
  ),
});

export function modulo_nivelado(codigo: string): ModuloNivelado | null {
  return MODULOS_NIVELADOS.find((m) => m.codigo === codigo) ?? null;
}

/** Todas as permissões de um módulo (as da operação). */
export function permissoes_do_modulo(m: ModuloNivelado): readonly string[] {
  return [...m.consulta, ...m.escrita];
}

/** O que um nível dá num módulo. */
export function permissoes_do_nivel(m: ModuloNivelado, nivel: Nivel): readonly string[] {
  if (nivel === SEM_ACESSO) return [];
  if (nivel === CONSULTA) return m.consulta;
  return permissoes_do_modulo(m);
}

const _niveladas = new Map<string, ModuloNivelado>(
  MODULOS_NIVELADOS.flatMap((m) => permissoes_do_modulo(m).map((p) => [p, m] as const)),
);

/** O módulo a que a permissão pertence para a liberação, ou `null` (só do perfil). */
export function modulo_de_permissao(codigo: string): ModuloNivelado | null {
  return _niveladas.get(codigo) ?? null;
}

/** Nível por módulo: `{ "epis": "CONSULTA" }`. Módulo ausente = padrão. */
export type NiveisPorModulo = Readonly<Record<string, Nivel>>;

/**
 * As permissões efetivas de UMA concessão: as do perfil (`cruas`) com o nível
 * de cada módulo aplicado — o da pessoa por cima do do perfil. O que não é de
 * módulo nenhum passa como está (só do perfil).
 */
export function permissoes_com_niveis(
  cruas: Iterable<string>,
  do_perfil: NiveisPorModulo = {},
  da_pessoa: NiveisPorModulo = {},
): string[] {
  const base = new Set(cruas);
  const saida = new Set<string>();
  for (const p of base) if (!_niveladas.has(p)) saida.add(p);
  for (const m of MODULOS_NIVELADOS) {
    const nivel = da_pessoa[m.codigo] ?? do_perfil[m.codigo];
    const dele = nivel === undefined ? permissoes_do_modulo(m).filter((p) => base.has(p)) : permissoes_do_nivel(m, nivel);
    for (const p of dele) saida.add(p);
  }
  return [...saida];
}

/**
 * Como o padrão de um perfil se lê no módulo: um dos três níveis quando bate
 * exatamente, ou `PARCIAL` (o perfil tem só um pedaço — o técnico, que emite e
 * não anula certificado).
 */
export function nivel_lido(cruas: Iterable<string>, m: ModuloNivelado): Nivel | typeof PARCIAL {
  const tem = new Set(cruas);
  const dele = permissoes_do_modulo(m).filter((p) => tem.has(p));
  if (!dele.length) return SEM_ACESSO;
  const iguais = (lista: readonly string[]) => lista.length === dele.length && lista.every((p) => tem.has(p));
  if (iguais(m.consulta)) return CONSULTA;
  if (iguais(permissoes_do_modulo(m))) return OPERACAO;
  return PARCIAL;
}

/** As permissões de um módulo que `cruas` tem. */
export function do_modulo(cruas: Iterable<string>, m: ModuloNivelado): string[] {
  const tem = new Set(cruas);
  return permissoes_do_modulo(m).filter((p) => tem.has(p));
}

/** Converte linhas do banco (`{modulo, nivel}`) em `NiveisPorModulo`, ignorando o que não vale mais. */
export function niveis_de(linhas: readonly { modulo: string; nivel: string }[]): NiveisPorModulo {
  const saida: Record<string, Nivel> = {};
  for (const l of linhas) if (modulo_nivelado(l.modulo) && eh_nivel(l.nivel)) saida[l.modulo] = l.nivel;
  return saida;
}
