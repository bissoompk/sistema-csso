/**
 * Liberação de módulo por módulo (22/10/2026) — O MAPA, num lugar só.
 *
 * Quem administra acesso (o Administrador do sistema e o Superintendente)
 * escolhe, para cada módulo do menu, um de três níveis:
 *
 * - **Sem acesso**: nenhuma permissão do módulo;
 * - **Consulta**: as permissões de LEITURA do módulo (`*.ver` e equivalentes);
 * - **Operação**: todas as do módulo — a consulta e as de escrita — ATÉ O TETO
 *   DO PERFIL (`NUNCA_POR_NIVEL`): o que a matriz tirou de propósito do perfil
 *   (o técnico não anula certificado, o almoxarife não lê parecer, a secretaria
 *   não analisa EPI) nenhum nível devolve.
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
 * Os dois módulos ainda não disponíveis (CISSP, PGR) não têm permissão nenhuma
 * e por isso não aparecem. Acidentes entrou em 23/10/2026.
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
  {
    // Acidentes (CAT/SP, 23/10/2026). A saúde, o relatório técnico e o dado
    // nominal NÃO entram aqui: ficam só do perfil (`PERMISSOES_SO_DO_PERFIL`).
    // `comunicar` é escrita, mas também vem com o vínculo a servidor
    // (`rbac.PERMISSOES_DO_TITULAR`), em escopo próprio.
    codigo: "acidentes",
    nome: "Análise de Acidentes",
    consulta: ["acidente.ver"],
    escrita: ["acidente.comunicar", "acidente.triar", "acidente.investigar", "acidente.siass"],
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
  "dados.limpar": "administração do sistema — apaga dado de movimento; só o Administrador do sistema",
  "exposicao.ver": "dado nominal e de exposição: segue o cargo, não o módulo",
  "indicador.ver": "transversal — indicadores de todos os módulos",
  exportar: "transversal — exportação de todos os módulos",
  "catalogo.gerenciar": "configuração do setor e catálogos da base",
  "turma.inscrever_se": "do titular — inscrever a si mesmo",
  "turma.todos_os_setores": "alcance de setor — ver as turmas de todos os setores promotores",
  "acidente.relatorio_emitir": "ato técnico assinado — emitir o relatório do acidente segue o cargo, como a assinatura",
  "acidente.identificacao_ver": "dado pessoal restrito (CPF, RG, endereço, telefone; LGPD; ROPA §4.3) — segue o cargo, não o módulo",
  "acidente.saude_ver": "dado de saúde, nível 1 (LGPD art. 5º, II; ROPA §4.4) — segue o cargo, não o módulo",
  "acidente.saude_detalhe_ver": "dado de saúde, nível 2 (LGPD art. 5º, II; ROPA §4.4) — segue o cargo, não o módulo",
  "acidente.saude_registrar": "dado de saúde (LGPD art. 5º, II; ROPA §4.4) — só quem registra saúde, por cargo",
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

/**
 * O TETO de cada perfil que aceita nível (23/10/2026, D1): as permissões que
 * NENHUM nível devolve, porque a matriz as tirou do perfil de propósito (cada
 * exclusão tem a razão no comentário do perfil em `rbac.ts`). "Operação" é o
 * módulo MENOS o teto; "Consulta", a leitura do módulo menos o teto.
 *
 * - `consulta_progep` e `auditor_interno`: TODA a escrita de todos os módulos
 *   (D2: no máximo Consulta, "escrita nenhuma");
 * - o técnico "emite e não anula" (certificado, parecer) e não atribui;
 * - o engenheiro e o médico "não operam o balcão" do almoxarifado;
 * - a secretaria: decidir (parecer, EPI) é ato técnico, e a ficha nominal de
 *   EPI fica fora da base dela (D3: `epi.ficha` segue sendo consulta, e é o
 *   teto que a exclui);
 * - o almoxarife "não lê parecer" e "não decide o direito ao item".
 *
 * Perfil de equipe SEM entrada aqui derruba a importação (`rbac._conferir_niveis`);
 * `[]` é a declaração de que não há teto (superintendente e coordenador).
 * O Administrador do sistema não aceita nível (`PERFIS_NO_NIVEL_MAIS_ALTO`):
 * é o único perfil sem teto e sem nível, sempre em Operação.
 */
const _TODA_A_ESCRITA: readonly string[] = MODULOS_NIVELADOS.flatMap((m) => m.escrita);

export const NUNCA_POR_NIVEL: Readonly<Record<string, readonly string[]>> = Object.freeze({
  superintendente: Object.freeze([] as string[]),
  coordenador_csso: Object.freeze([] as string[]),
  engenheiro_seguranca: Object.freeze(["epi.entregar", "epi.estoque"]),
  // o médico não tria nem investiga o acidente (D10): é a engenharia e a segurança
  medico_trabalho: Object.freeze(["epi.catalogo", "epi.entregar", "epi.estoque", "acidente.triar", "acidente.investigar"]),
  tecnico_seguranca: Object.freeze(["processo.atribuir", "parecer.anular", "certificado.anular", "participante.mesclar"]),
  secretaria_csso: Object.freeze([
    "processo.atribuir",
    "parecer.criar",
    "parecer.editar",
    "parecer.emitir",
    "parecer.anular",
    "treinamento.gerenciar",
    "certificado.anular",
    "participante.mesclar",
    "epi.ficha",
    "epi.catalogo",
    "epi.entregar",
    "epi.estoque",
    "epi.analisar",
    // a secretaria tria a comunicação, e investigar e encaminhar ao SIASS são atos técnicos (D10)
    "acidente.investigar",
    "acidente.siass",
  ]),
  almoxarife_sesmt: Object.freeze([
    "parecer.ver",
    "parecer.criar",
    "parecer.editar",
    "parecer.emitir",
    "parecer.anular",
    "epi.catalogo",
    "epi.requisitar",
    "epi.analisar",
    // o almoxarife só comunica o acidente (D10); triar, investigar e encaminhar não
    "acidente.triar",
    "acidente.investigar",
    "acidente.siass",
  ]),
  consulta_progep: Object.freeze([..._TODA_A_ESCRITA]),
  auditor_interno: Object.freeze([..._TODA_A_ESCRITA]),
});

/** O teto do perfil (vazio quando não há: o perfil não aceita nível, ou não tem exclusão). */
export function teto_do_perfil(perfil: string | null | undefined): readonly string[] {
  return perfil && Object.hasOwn(NUNCA_POR_NIVEL, perfil) ? NUNCA_POR_NIVEL[perfil]! : [];
}

/** As permissões de leitura do módulo que o teto deixa. */
function _consulta_ate_o_teto(m: ModuloNivelado, teto: readonly string[]): string[] {
  return m.consulta.filter((p) => !teto.includes(p));
}

/** O nível mais alto que o perfil alcança no módulo: Operação, ou só Consulta (PROGEP, auditor). */
export function nivel_maximo(m: ModuloNivelado, teto: readonly string[]): Nivel {
  return m.escrita.every((p) => teto.includes(p)) ? CONSULTA : OPERACAO;
}

export function modulo_nivelado(codigo: string): ModuloNivelado | null {
  return MODULOS_NIVELADOS.find((m) => m.codigo === codigo) ?? null;
}

/** Todas as permissões de um módulo (as da operação). */
export function permissoes_do_modulo(m: ModuloNivelado): readonly string[] {
  return [...m.consulta, ...m.escrita];
}

/** O que um nível dá num módulo. */
export function permissoes_do_nivel(m: ModuloNivelado, nivel: Nivel, teto: readonly string[] = []): readonly string[] {
  if (nivel === SEM_ACESSO) return [];
  const tiradas = (lista: readonly string[]) => lista.filter((p) => !teto.includes(p));
  if (nivel === CONSULTA) return tiradas(m.consulta);
  return tiradas(permissoes_do_modulo(m));
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
  perfil: string | null = null,
): string[] {
  const teto = teto_do_perfil(perfil);
  const base = new Set(cruas);
  const saida = new Set<string>();
  for (const p of base) if (!_niveladas.has(p)) saida.add(p);
  for (const m of MODULOS_NIVELADOS) {
    const nivel = da_pessoa[m.codigo] ?? do_perfil[m.codigo];
    const dele = nivel === undefined ? permissoes_do_modulo(m).filter((p) => base.has(p)) : permissoes_do_nivel(m, nivel, teto);
    for (const p of dele) saida.add(p);
  }
  return [...saida];
}

/**
 * Como o que o perfil tem se lê no módulo, JÁ DESCONTADO o teto dele: um dos
 * três níveis quando bate exatamente com o que o nível dá a esse perfil
 * (Consulta = a leitura menos o teto; Operação = o módulo menos o teto), ou
 * `PARCIAL` quando é um pedaço que nenhum nível dá. Com o teto, o técnico que
 * "emite e não anula" lê Operação, e não mais Parcial.
 */
export function nivel_lido(
  cruas: Iterable<string>,
  m: ModuloNivelado,
  teto: readonly string[] = [],
): Nivel | typeof PARCIAL {
  const tem = new Set(cruas);
  const dele = permissoes_do_modulo(m).filter((p) => tem.has(p));
  if (!dele.length) return SEM_ACESSO;
  const iguais = (lista: readonly string[]) => lista.length === dele.length && lista.every((p) => tem.has(p));
  if (iguais(_consulta_ate_o_teto(m, teto))) return CONSULTA;
  if (iguais(permissoes_do_nivel(m, OPERACAO, teto))) return OPERACAO;
  return PARCIAL;
}

/** O rótulo curto do que o teto tira, para "Operação (sem anular certificado)". */
const RESUMO_DO_TETO: Readonly<Record<string, string>> = Object.freeze({
  "processo.atribuir": "atribuir",
  "parecer.ver": "parecer",
  "parecer.criar": "parecer",
  "parecer.editar": "parecer",
  "parecer.emitir": "parecer",
  "parecer.anular": "anular parecer",
  "treinamento.gerenciar": "gerenciar o catálogo",
  "certificado.anular": "anular certificado",
  "participante.mesclar": "juntar cadastros",
  "epi.ficha": "ficha nominal",
  "epi.catalogo": "catálogo de EPI",
  "epi.entregar": "entregar",
  "epi.estoque": "estoque",
  "epi.requisitar": "pedir EPI",
  "epi.analisar": "analisar pedido",
  "acidente.triar": "triar",
  "acidente.investigar": "investigar",
  "acidente.siass": "encaminhar ao SIASS",
});

/**
 * O nível como a tela o escreve (D10), nas DUAS telas: "Sem acesso", "Consulta",
 * "Operação", "Parcial" — e, quando o teto do perfil tira algo do que o nível
 * daria, "Operação (sem anular certificado, juntar cadastros)". `PARCIAL` fica
 * "Parcial" (um pedaço que nenhum nível dá).
 */
export function rotulo_do_nivel(nivel: string, m: ModuloNivelado, perfil: string | null): string {
  const base = ROTULO_NIVEL[nivel] ?? nivel;
  if (nivel !== CONSULTA && nivel !== OPERACAO) return base;
  const teto = teto_do_perfil(perfil);
  const deste_nivel = nivel === CONSULTA ? m.consulta : permissoes_do_modulo(m);
  const tiradas = deste_nivel.filter((p) => teto.includes(p));
  // o perfil que só chega à Consulta não tem teto "a mostrar" em Consulta: o teto é a escrita inteira
  if (!tiradas.length) return base;
  if (nivel === OPERACAO && tiradas.length === m.escrita.length && tiradas.every((p) => m.escrita.includes(p))) {
    return `${base} (sem escrita)`;
  }
  const textos = [...new Set(tiradas.map((p) => RESUMO_DO_TETO[p] ?? p))];
  const sem = textos.includes("parecer") ? textos.filter((t) => t !== "anular parecer") : textos;
  return `${base} (sem ${sem.join(", ")})`;
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

// ---------------------------------------------------------------------
// A base compartilhada (Servidores, Catálogos) com "Sem acesso" em Processos
// SEI (23/10/2026)
// ---------------------------------------------------------------------
/**
 * A permissão DERIVADA da base compartilhada. Não é permissão do banco (não se
 * concede nem aparece na matriz, por isso o `@`, como `@titular`): sai, em
 * `rbac.perfis_vigentes`, na concessão que lê a base hoje (`processo.ver` do
 * perfil, antes ou depois do nível) E que ainda dá acesso a algum módulo.
 *
 * Por quê: Servidores e Catálogos eram guardados por `processo.ver`, e "Sem
 * acesso" a Processos SEI os tirava de quem continua trabalhando no EPI ou nos
 * Certificados — o cadastro é o mesmo para todos os módulos. Com a derivada, o
 * técnico sem Processos SEI continua vendo a base, com o MESMO alcance que a
 * concessão dele tinha; e quem nunca leu a base (o almoxarife) continua sem
 * ela. Fica só na concessão, e não em `UsuarioAtual.permissoes` (a lista que a
 * API devolve não muda): `UsuarioAtual.pode(PERMISSAO_DA_BASE)` a lê das
 * concessões.
 */
export const PERMISSAO_DA_BASE = "@base";

/** Os módulos cujo acesso sustenta a base (Demandas é base, e não sustenta). */
// Acidentes entrou em 23/10/2026: o formulário acha o acidentado pelo cadastro de servidores
const MODULOS_QUE_SUSTENTAM_A_BASE: ReadonlySet<string> = new Set(["processos-sei", "epis", "certificados", "acidentes"]);

/** A concessão dá a base? `cruas` = as do perfil; `efetivas` = depois dos níveis. */
export function concessao_da_a_base(cruas: Iterable<string>, efetivas: Iterable<string>): boolean {
  const antes = new Set(cruas);
  const depois = [...efetivas];
  if (!antes.has("processo.ver") && !depois.includes("processo.ver")) return false;
  return depois.some((p) => {
    const m = _niveladas.get(p);
    return m !== undefined && MODULOS_QUE_SUSTENTAM_A_BASE.has(m.codigo);
  });
}
