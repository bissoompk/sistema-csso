/**
 * Regras do parecer técnico: validação, emissão, assinatura e anulação.
 * Porte de `app/servicos/parecer.py`. Implementa RN-01 a RN-08, RN-13 a RN-15 e RN-22.
 *
 * **Forma do porte.** No Python as funções recebiam o `ParecerTecnico` do ORM,
 * navegavam as relações sob demanda (`parecer.portaria.data_publicacao`,
 * `exp.agente_nocivo.tipo_risco.nome`) e mudavam atributos que o `flush`
 * gravava. Aqui o parecer chega CARREGADO por `carregar`/`no_escopo` (a árvore
 * inteira que as regras e o editor leem, `COM_PARECER`), e cada serviço que
 * escreve grava com UPDATE e atualiza o mesmo objeto em memória.
 */
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  adicional_vigencia,
  exposicao as tabela_exposicao,
  laudo_tecnico,
  parecer_tecnico,
  profissional_habilitado,
  setor_emissor,
} from "../db/esquema/index.js";
import type * as E from "../db/esquema/index.js";
import { agora_utc } from "../db/esquema/base.js";
import { UnidadeUorg, vigente_em } from "../dominio/organizacao.js";
import { ParecerTecnico } from "../dominio/processo.js";
import { RegraViolada } from "../nucleo/erros.js";
import * as auditoria from "./auditoria.js";
import * as datas_br from "./datas_br.js";
import * as documento from "./documento.js";
import { ContextoParecer } from "./documento.js";
import * as numeracao from "./numeracao.js";
import * as servico_pdf from "./pdf.js";
import * as pendencias from "./pendencias.js";
import * as textos from "./textos.js";
import { declarar_porta } from "./anexo_acesso.js";
import { MENSAGEM_RN01, PermissaoNegada, aplicar_escopo, pode_subscrever, type UsuarioAtual } from "./rbac.js";

export type SetorEmissor = typeof setor_emissor.$inferSelect;

export const ANOS_PRESCRICAO = 5;

export const AVISO_PRESCRICAO =
  "possível prescrição quinquenal (Decreto 20.910/32; Súmula 85/STJ) — decisão é da PROGEP";

export class EmissaoBloqueada extends RegraViolada {
  constructor(public motivos: string[]) {
    super("Emissão bloqueada: " + motivos.join("; "));
  }
}

export class Validacao {
  faltantes: string[] = [];
  bloqueios: string[] = [];
  avisos: string[] = [];

  get ok(): boolean {
    return !this.faltantes.length && !this.bloqueios.length;
  }

  get motivos(): string[] {
    return [...this.faltantes, ...this.bloqueios];
  }
}

// ---------------------------------------------------------------------
// Carga: a árvore que as regras e o editor leem
// ---------------------------------------------------------------------
/**
 * O que o `lazy="selectin"` do Python trazia junto com o parecer. A ordem das
 * exposições é a do `id` (a ordem de inserção que o SQLite devolvia), e a dos
 * postos é `parecer_posto.ordem`, que o serviço aplica.
 */
export const COM_PARECER = {
  processo: true,
  servidor: { with: { cargo: true, unidade: true } },
  laudo: { with: { unidade: true, tipo_adicional: true } },
  tipo_adicional: true,
  tipo_movimento: true,
  unidade: true,
  uorg: true,
  portaria: { with: { unidade_emissora: true } },
  destinatario: true,
  signatario: true,
  setor_emissor: true,
  tipo_marco: true,
  postos: {
    with: { posto: true },
    orderBy: (pp: any, { asc: a }: any) => [a(pp.ordem), a(pp.posto_trabalho_id)],
  },
  exposicoes: {
    with: {
      agente_nocivo: { with: { tipo_risco: true } },
      percentual: { with: { tipo_adicional: true } },
      fundamentacao: true,
    },
    orderBy: (e: any, { asc: a }: any) => [a(e.id)],
  },
} as const;

async function _consultar(tx: Executor, id: number, escopo?: ReturnType<typeof aplicar_escopo>) {
  return tx.query.parecer_tecnico.findFirst({
    where: and(eq(parecer_tecnico.id, id), escopo),
    with: COM_PARECER as any,
  });
}

type L<T extends { $inferSelect: unknown }> = T["$inferSelect"];
type Unidade = L<typeof E.unidade_uorg>;

export type Exposicao = L<typeof E.exposicao> & {
  agente_nocivo: L<typeof E.agente_nocivo> & { tipo_risco: L<typeof E.tipo_risco> };
  percentual: L<typeof E.percentual_aplicavel> & { tipo_adicional: L<typeof E.tipo_adicional> | null };
  fundamentacao: L<typeof E.fundamentacao_legal>;
};

export type ParecerCompleto = L<typeof E.parecer_tecnico> & {
  processo: L<typeof E.processo> | null;
  servidor: (L<typeof E.servidor> & { cargo: L<typeof E.cargo> | null; unidade: Unidade | null }) | null;
  laudo: (L<typeof E.laudo_tecnico> & { unidade: Unidade; tipo_adicional: L<typeof E.tipo_adicional> }) | null;
  tipo_adicional: L<typeof E.tipo_adicional> | null;
  tipo_movimento: L<typeof E.tipo_movimento> | null;
  unidade: Unidade | null;
  uorg: Unidade | null;
  portaria: (L<typeof E.portaria_localizacao> & { unidade_emissora: Unidade }) | null;
  destinatario: L<typeof E.autoridade_destinataria> | null;
  signatario: L<typeof E.profissional_habilitado> | null;
  setor_emissor: SetorEmissor | null;
  tipo_marco: L<typeof E.tipo_marco_inicial> | null;
  postos: (L<typeof E.parecer_posto> & { posto: L<typeof E.posto_trabalho> })[];
  exposicoes: Exposicao[];
  /** `parecer.rotulo` do modelo Python ('N/AAAA'). */
  readonly rotulo: string;
};

function completar(linha: unknown): ParecerCompleto {
  const p = linha as ParecerCompleto;
  Object.defineProperty(p, "rotulo", {
    get: () => ParecerTecnico.rotulo(p),
    enumerable: false,
    configurable: true,
  });
  return p;
}

/** O parecer com a árvore inteira, SEM escopo (o `s.get` das rotas de escrita). */
export async function carregar(tx: Executor, parecer_id: number): Promise<ParecerCompleto | null> {
  const linha = await _consultar(tx, parecer_id);
  return linha ? completar(linha) : null;
}

/** Recarrega o mesmo objeto depois de escrever (o `refresh` do SQLAlchemy). */
export async function recarregar(tx: Executor, parecer: ParecerCompleto): Promise<ParecerCompleto> {
  const linha = await _consultar(tx, parecer.id);
  if (linha) Object.assign(parecer, linha);
  return parecer;
}

// ---------------------------------------------------------------------
// A porta de leitura do parecer
// ---------------------------------------------------------------------
/**
 * A ÚNICA leitura de parecer por id que as telas usam. Devolve `null` ou a linha.
 *
 * Com `parecer.ver` num perfil que vai para milhares de servidores, ler por id
 * sem escopo entregaria nome, agente nocivo, percentual e fundamentação de
 * qualquer pessoa — e o `.docx` oficial com o nome do terceiro no próprio nome
 * do arquivo. `ESCOPO_PROPRIO` filtra por `servidor_id`, e `parecer_tecnico`
 * tem a coluna: é exatamente o titular do art. 18, II que o filtro separa dos
 * outros.
 *
 * Mora no serviço, e não na rota: o download do anexo do parecer faz a mesma
 * pergunta, e uma segunda resposta em outro arquivo é o que produz a
 * divergência em que a tela aperta e o arquivo continua frouxo.
 */
export async function no_escopo(tx: Executor, usuario: UsuarioAtual, parecer_id: number): Promise<ParecerCompleto | null> {
  const linha = await _consultar(tx, parecer_id, aplicar_escopo(usuario, parecer_tecnico));
  return linha ? completar(linha) : null;
}

// ---------------------------------------------------------------------
// Exposições
// ---------------------------------------------------------------------
/** O `round(x, 2)` do Python para a conta da jornada. */
function arredondar2(x: number): number {
  return Number(x.toFixed(2));
}

/** RN-07 - CALCULADO, nunca digitado (art. 9º da IN 15/2022). */
export function classificar_exposicao(
  horas_exposicao: number | null | undefined,
  jornada: number | null | undefined,
): [number | null, string | null] {
  if (!horas_exposicao || !jornada) return [null, null];
  const percentual = arredondar2((Number(horas_exposicao) / Number(jornada)) * 100);
  if (percentual >= 100) return [percentual, "PERMANENTE"];
  if (percentual >= 50) return [percentual, "HABITUAL"];
  return [percentual, "EVENTUAL"];
}

/** O que `aplicar_classificacao` lê e escreve numa exposição (linha ou rascunho). */
export interface ExposicaoClassificavel {
  horas_exposicao_mensais: string | number | null;
  jornada_mensal_horas: string | number | null;
  percentual_jornada: string | number | null;
  classificacao_exposicao: string | null;
  classificacao_origem: string;
}

/**
 * Calcula a classificação a partir das horas; se não houver medição de
 * jornada, aceita a classificação informada pelo técnico.
 *
 * A IN 15/2022, art. 9º, define a habitualidade por tempo de exposição, então
 * a medição manda quando existe. A origem fica registrada em
 * `classificacao_origem` para que a auditoria saiba o que foi medido e o que
 * foi julgado — e, se as duas existirem e divergirem, quem vale é a medição.
 */
export function aplicar_classificacao<X extends ExposicaoClassificavel>(exposicao: X, informada: string | null = null): X {
  const [percentual, calculada] = classificar_exposicao(
    exposicao.horas_exposicao_mensais !== null ? Number(exposicao.horas_exposicao_mensais) : null,
    exposicao.jornada_mensal_horas !== null ? Number(exposicao.jornada_mensal_horas) : null,
  );
  exposicao.percentual_jornada = percentual;

  if (calculada !== null) {
    exposicao.classificacao_exposicao = calculada;
    exposicao.classificacao_origem = "CALCULADA";
  } else if (informada === "EVENTUAL" || informada === "HABITUAL" || informada === "PERMANENTE") {
    exposicao.classificacao_exposicao = informada;
    exposicao.classificacao_origem = "INFORMADA";
  } else {
    exposicao.classificacao_exposicao = null;
    exposicao.classificacao_origem = "CALCULADA";
  }
  return exposicao;
}

/** `str(float)` do Python: `100.0`, `62.5`. */
function float_python(v: string | number | null): string {
  if (v === null) return "None";
  const n = Number(v);
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

/** Aviso quando o técnico informa uma classe diferente da medição. */
export function divergencia_de_classificacao(exposicao: ExposicaoClassificavel, informada: string | null): string | null {
  if (!informada || exposicao.classificacao_origem !== "CALCULADA") return null;
  if (exposicao.classificacao_exposicao && informada !== exposicao.classificacao_exposicao) {
    return (
      `a jornada medida indica ${exposicao.classificacao_exposicao} ` +
      `(${float_python(exposicao.percentual_jornada)}%), não ${informada} — ` +
      "prevaleceu a medição (art. 9º)"
    );
  }
  return null;
}

export function exposicao_principal<X extends { principal: boolean }>(parecer: { exposicoes: X[] }): X | null {
  for (const e of parecer.exposicoes) if (e.principal) return e;
  return parecer.exposicoes[0] ?? null;
}

// ---------------------------------------------------------------------
// §7 do desenho de EPI - EPI neutraliza insalubridade; não cessa periculosidade
// ---------------------------------------------------------------------
export const EPI_NEUTRALIZA_VALORES = ["NAO_AVALIADO", "NAO_NEUTRALIZA", "NEUTRALIZA_PARCIAL", "NEUTRALIZA"] as const;

// Os dois valores que ALEGAM neutralização — os únicos que reduzem ou cessam
// direito, e por isso os únicos que a regra abaixo tranca.
export const EPI_ALEGA_NEUTRALIZACAO = ["NEUTRALIZA_PARCIAL", "NEUTRALIZA"] as const;

// Lista branca, e não lista negra, porque o catálogo de `tipo_adicional` é
// editável: com lista negra, um código novo cadastrado amanhã nasceria
// neutralizável por omissão, e a omissão aqui produz decisão ilegal em série.
//
// Os dois radiológicos ficam de fora DE PROPÓSITO: irradiação ionizante e raios
// X são risco de acidente, e ali o EPI reduz a consequência, não a existência
// do risco.
export const CODIGOS_NEUTRALIZAVEIS_POR_EPI: ReadonlySet<string> = new Set(["INSALUBRIDADE"]);

export const EPI_NEUTRALIZACAO_AVALIADA = "EPI_NEUTRALIZACAO_AVALIADA";

/** A recusa do §7.1, com o motivo por escrito para a tela mostrar. */
export class AvaliacaoDeEpiRecusada extends RegraViolada {
  constructor(public motivos: string[]) {
    super("Avaliação de EPI recusada: " + motivos.join("; "));
  }
}

type ComAdicional = { tipo_adicional: { codigo: string } | null };
type ExposicaoComPercentual = { percentual: { tipo_adicional: { codigo: string } | null } | null };

/**
 * Todos os tipos de adicional que esta exposição alimenta — pelos dois
 * caminhos (o percentual e o parecer). Basta um deles não ser de insalubridade
 * para a alegação cair: recusar por engano custa um clique, permitir por engano
 * custa o adicional de alguém.
 */
function _codigos_de_adicional(parecer: ComAdicional, exposicao: ExposicaoComPercentual): Set<string> {
  const codigos = new Set<string>();
  const percentual = exposicao.percentual;
  if (percentual && percentual.tipo_adicional) codigos.add(percentual.tipo_adicional.codigo);
  if (parecer.tipo_adicional) codigos.add(parecer.tipo_adicional.codigo);
  return codigos;
}

/**
 * A regra do §7.1, isolada para a tela poder perguntar antes de oferecer. Sem
 * código nenhum resolvido a resposta é **não**: "não sei qual é o adicional"
 * não é "pode neutralizar".
 */
export function epi_pode_neutralizar(parecer: ComAdicional, exposicao: ExposicaoComPercentual): boolean {
  const codigos = _codigos_de_adicional(parecer, exposicao);
  return codigos.size > 0 && [...codigos].every((c) => CODIGOS_NEUTRALIZAVEIS_POR_EPI.has(c));
}

/**
 * Grava se o EPI neutraliza o agente **desta** exposição — e recusa o resto.
 *
 * **O EPI neutraliza insalubridade; o EPI não cessa periculosidade.** Um
 * sistema que deixasse o EPI cessar periculosidade produziria decisão ilegal
 * em série, uma por parecer, todas com aparência de fundamentadas. Por isso a
 * recusa é dura e vem antes de qualquer gravação.
 *
 * Alegar neutralização também exige `pode_subscrever` (RN-01). `NAO_AVALIADO`
 * e `NAO_NEUTRALIZA` não exigem: eles não tiram nada de ninguém.
 */
export async function registrar_avaliacao_de_epi(
  tx: Executor,
  parecer: ParecerCompleto,
  exposicao: Exposicao,
  usuario: UsuarioAtual,
  d: { valor: string; justificativa?: string; quando?: string | null },
): Promise<Exposicao> {
  usuario.exigir("parecer.editar");
  const quando = d.quando ?? datas_br.hoje();
  const motivos: string[] = [];
  const valor = d.valor;

  if (!(EPI_NEUTRALIZA_VALORES as readonly string[]).includes(valor)) {
    throw new AvaliacaoDeEpiRecusada([`'${valor}' não é um resultado de avaliação de EPI`]);
  }
  if (exposicao.parecer_id !== parecer.id) throw new AvaliacaoDeEpiRecusada(["a exposição não é deste parecer"]);
  // RN-14/RN-15: parecer emitido é documento, não rascunho
  if (["EMITIDO", "ASSINADO", "ANULADO"].includes(parecer.situacao)) {
    throw new AvaliacaoDeEpiRecusada([
      `o parecer ${parecer.rotulo} está ${parecer.situacao.toLowerCase()}: ` +
        "a avaliação de EPI de um parecer emitido só muda em versão nova",
    ]);
  }

  // RN-30/RN-21: texto livre passa pelo filtro antes de qualquer gravação
  const limpa = textos.exigir_texto_limpo((d.justificativa ?? "").trim(), "justificativa da avaliação de EPI");

  const alega = (EPI_ALEGA_NEUTRALIZACAO as readonly string[]).includes(valor);
  if (alega) {
    if (!epi_pode_neutralizar(parecer, exposicao)) {
      const codigos = [..._codigos_de_adicional(parecer, exposicao)].sort().join(", ") || "—";
      motivos.push(
        `EPI não cessa periculosidade. Este parecer trata de ${codigos}, ` +
          "e o equipamento reduz a consequência do acidente, não a " +
          "existência do risco — o adicional continua devido. A " +
          "neutralização por EPI só se aplica a insalubridade " +
          "(IN SGP/SEDGG/ME 15/2022; Lei 8.112/90, art. 68, §2º)",
      );
    }
    if (!limpa) {
      motivos.push(
        "alegar neutralização exige a justificativa técnica por escrito: " +
          "qual EPI, com que CA vigente na data da avaliação, e por que ele " +
          "leva o agente abaixo do limite de tolerância",
      );
    }
    if (!(await pode_subscrever(tx, usuario))) motivos.push(MENSAGEM_RN01);
  }
  if (motivos.length) throw new AvaliacaoDeEpiRecusada(motivos);

  const anterior = exposicao.epi_neutraliza;
  const novos = {
    epi_neutraliza: valor,
    justificativa_epi: limpa || null,
    // `NAO_AVALIADO` não tem data: ele diz exatamente que ninguém avaliou
    epi_avaliado_em: valor === "NAO_AVALIADO" ? null : quando,
  };
  await tx.update(tabela_exposicao).set(novos).where(eq(tabela_exposicao.id, exposicao.id));
  Object.assign(exposicao, novos);

  await auditoria.registrar(tx, {
    entidade: "exposicao",
    entidade_id: exposicao.id,
    processo_id: parecer.processo_id,
    tipo_evento: EPI_NEUTRALIZACAO_AVALIADA,
    descricao:
      `${exposicao.agente_nocivo.descricao}: EPI ${valor.replaceAll("_", " ").toLowerCase()}` +
      (limpa ? ` — ${limpa}` : ""),
    campo: "epi_neutraliza",
    valor_anterior: anterior,
    valor_novo: valor,
    comentario: limpa || null,
    usuario,
  });
  return exposicao;
}

/**
 * A prova do §7.2: quais fichas o engenheiro olhou, com que CA e que data.
 *
 * Vai para `contexto_congelado['epi']` na emissão: zero acoplamento de esquema
 * entre os módulos, valor probatório completo e imutabilidade — uma entrega
 * feita depois da emissão não reescreve o fundamento de um parecer assinado.
 * O bloco não repete nome nem SIAPE do servidor (RN-19).
 */
export async function congelar_epi(tx: Executor, parecer: ParecerCompleto): Promise<Record<string, unknown>> {
  // import tardio, como no Python: o módulo de EPI importa este aqui
  const epi_ficha = await import("./epi_ficha.js");
  const quando = parecer.data_emissao ?? datas_br.hoje();
  const fichas = parecer.servidor_id ? await epi_ficha.entregas_ate(tx, parecer.servidor_id, quando) : [];
  return {
    referencia: quando,
    fichas: fichas.map((f) => f.congelar()),
    exposicoes: parecer.exposicoes.map((e) => ({
      exposicao: e.id,
      agente: e.agente_nocivo.descricao,
      epi_neutraliza: e.epi_neutraliza,
      justificativa: e.justificativa_epi,
      avaliado_em: e.epi_avaliado_em ?? null,
    })),
  };
}

// ---------------------------------------------------------------------
// Validação (RN-04 ... RN-08, RN-22)
// ---------------------------------------------------------------------
const OBRIGATORIOS: readonly (readonly [keyof ParecerCompleto, string])[] = [
  ["servidor_id", "servidor"],
  ["unidade_uorg_id", "unidade / UORG"],
  ["processo_id", "processo (NUP)"],
  ["laudo_id", "laudo técnico"],
  ["portaria_id", "portaria de localização"],
  ["tipo_marco_id", "marco inicial"],
  ["data_marco_inicial", "data do marco inicial"],
  ["texto_recomendacao", "recomendação"],
  ["signatario_id", "signatário"],
  ["destinatario_id", "autoridade destinatária"],
  ["tipo_adicional_id", "tipo de adicional"],
  ["tipo_movimento_id", "tipo de movimento"],
];

export async function validar(_tx: Executor, parecer: ParecerCompleto, hoje: string | null = null): Promise<Validacao> {
  const dia = hoje ?? datas_br.hoje();
  const v = new Validacao();

  for (const [campo, rotulo] of OBRIGATORIOS) {
    if (parecer[campo] === null || parecer[campo] === undefined) v.faltantes.push(rotulo);
  }

  if (parecer.servidor && !parecer.servidor.siape) v.faltantes.push("matrícula SIAPE");
  if (!parecer.postos.length) v.faltantes.push("posto de trabalho");

  const principal = exposicao_principal(parecer);
  if (principal === null) {
    v.faltantes.push("exposição (agente nocivo, percentual, fundamentação)");
  } else if (!parecer.exposicoes.some((e) => e.principal)) {
    v.bloqueios.push("marque qual exposição é a principal");
  }

  // §9 - percentuais divergentes
  const percentuais = new Set(parecer.exposicoes.map((e) => e.percentual_id));
  if (percentuais.size > 1) v.bloqueios.push("exposições com percentuais divergentes: escolha a principal");

  // RN-08 - percentual compatível com o tipo de adicional do parecer
  if (principal !== null && parecer.tipo_adicional_id !== null) {
    if (principal.percentual.tipo_adicional_id !== parecer.tipo_adicional_id) {
      v.bloqueios.push("o percentual escolhido pertence a outro tipo de adicional");
    }
  }

  // RN-06 - agente que exige avaliação quantitativa
  for (const exp of parecer.exposicoes) {
    if (exp.agente_nocivo.exige_reavaliacao_quantitativa && !parecer.texto_reavaliacao) {
      v.bloqueios.push(
        `o agente '${exp.agente_nocivo.descricao}' exige avaliação quantitativa: ` +
          "preencha o texto de reavaliação e abra a pendência",
      );
      break;
    }
  }

  // RN-07 - exposição eventual
  for (const exp of parecer.exposicoes) {
    if (exp.classificacao_exposicao === "EVENTUAL" && !exp.excecao_art9_par_unico) {
      v.bloqueios.push(
        "exposição EVENTUAL sem a exceção do art. 9º, parágrafo único: " +
          "enquadre um inciso do art. 11 e mova para INDEFERIDO_TECNICAMENTE",
      );
      break;
    }
  }

  v.avisos.push(..._validar_marco(parecer, dia));
  v.bloqueios.push(..._bloqueios_marco(parecer));
  v.bloqueios.push(..._validar_radiologico(parecer));

  // RN-13
  if (parecer.tipo_movimento && parecer.tipo_movimento.codigo === "REVISAO" && parecer.parecer_anterior_id === null) {
    v.bloqueios.push("movimento 'revisão' exige o parecer anterior vinculado");
  }
  return v;
}

function _bloqueios_marco(parecer: ParecerCompleto): string[] {
  const problemas: string[] = [];
  if (parecer.data_marco_inicial === null || parecer.tipo_marco === null) return problemas;

  // RN-05 - marco derivado da portaria
  if (parecer.tipo_marco.codigo === "PORTARIA_LOCALIZACAO") {
    if (parecer.portaria === null) {
      problemas.push("marco 'portaria de localização' sem portaria vinculada");
    } else if (parecer.data_marco_inicial !== parecer.portaria.data_publicacao) {
      problemas.push(
        "a data do marco inicial diverge da data de publicação da portaria " +
          `(${datas_br.numerica(parecer.portaria.data_publicacao)})`,
      );
    }
  } else if (!parecer.justificativa_marco) {
    problemas.push("marco diferente da portaria de localização exige justificativa");
  }

  // o marco nunca pode ser anterior à emissão do laudo
  if (parecer.laudo && parecer.laudo.data_emissao !== null) {
    if (parecer.data_marco_inicial < parecer.laudo.data_emissao) {
      problemas.push(
        "não há laudo que caracterize a exposição nesta data " +
          `(laudo emitido em ${datas_br.numerica(parecer.laudo.data_emissao)})`,
      );
    }
  }
  return problemas;
}

/** Alerta NÃO bloqueante de prescrição quinquenal. */
function _validar_marco(parecer: ParecerCompleto, hoje: string): string[] {
  if (parecer.data_marco_inicial === null) return [];
  const referencia = parecer.data_emissao ?? hoje;
  if (datas_br.meses_entre(parecer.data_marco_inicial, referencia) > ANOS_PRESCRICAO * 12) return [AVISO_PRESCRICAO];
  return [];
}

/** RN-22 - IN 15/2022, arts. 7º e 8º. */
export function _validar_radiologico(parecer: ParecerCompleto): string[] {
  if (parecer.tipo_adicional === null) return [];
  const codigo = parecer.tipo_adicional.codigo;
  const faltas: string[] = [];
  if (codigo === "RAIOS_X") {
    if (!parecer.horas_semanais_fonte || Number(parecer.horas_semanais_fonte) < 12) {
      faltas.push("raios X exige jornada de no mínimo 12 horas semanais junto à fonte (IN 15/2022, art. 8º, I)");
    }
    if (parecer.portaria_designacao_dirigente_id === null) {
      faltas.push("raios X exige portaria de designação do dirigente (art. 8º, II)");
    }
    if (parecer.area_radiologica !== "CONTROLADA") {
      faltas.push("raios X exige área radiológica CONTROLADA (art. 8º, III)");
    }
  } else if (codigo === "IRRADIACAO_IONIZANTE") {
    if (parecer.area_radiologica !== "CONTROLADA" && parecer.area_radiologica !== "SUPERVISIONADA") {
      faltas.push(
        "irradiação ionizante exige área CONTROLADA ou SUPERVISIONADA e " +
          "registro do credenciamento CNEN (art. 7º)",
      );
    }
  }
  return faltas;
}

// ---------------------------------------------------------------------
// Contexto do documento
// ---------------------------------------------------------------------
/**
 * O setor emissor cuja vigência cobre `quando` ('AAAA-MM-DD'); havendo mais de
 * um, o de início mais recente. Datas são texto ISO: comparar é comparar texto.
 */
export async function setor_emissor_vigente(tx: Executor, quando: string): Promise<SetorEmissor | null> {
  const candidatos = await tx.select().from(setor_emissor).orderBy(asc(setor_emissor.id));
  const vigentes = candidatos.filter(
    (se) => se.vigencia_inicio <= quando && (se.vigencia_fim === null || se.vigencia_fim >= quando),
  );
  if (!vigentes.length) return null;
  // `max(key=...)` do Python devolve o PRIMEIRO dos empatados
  return vigentes.reduce((a, b) => (b.vigencia_inicio > a.vigencia_inicio ? b : a));
}

export async function montar_contexto(
  tx: Executor,
  parecer: ParecerCompleto,
  quando: string | null = null,
): Promise<ContextoParecer> {
  // RN-15: parecer emitido reimprime do congelado, não do catálogo de hoje.
  // Sem isto, renomear um agente nocivo mudaria um documento já assinado.
  if (parecer.contexto_congelado && Object.keys(parecer.contexto_congelado).length) {
    return ContextoParecer.descongelar(parecer.contexto_congelado);
  }

  const dia = parecer.data_emissao ?? quando ?? datas_br.hoje();

  const setor = parecer.setor_emissor ?? (await setor_emissor_vigente(tx, dia));
  let sigla: string, nome_emissor: string, endereco: string, telefone: string;
  if (parecer.sigla_emissora_snapshot) {
    // RN-15 - reimpressão usa o congelado
    sigla = parecer.sigla_emissora_snapshot;
    nome_emissor = parecer.nome_emissor_snapshot || "";
    endereco = parecer.endereco_emissor_snapshot || "";
    telefone = parecer.telefone_emissor_snapshot || "";
  } else {
    sigla = setor ? setor.sigla_composta : "";
    nome_emissor = setor ? setor.nome_extenso : "";
    endereco = setor ? (setor.endereco ?? "") : "";
    telefone = setor ? (setor.telefone ?? "") : "";
  }

  const principal = exposicao_principal(parecer);
  const agentes: string[] = [];
  if (principal !== null) agentes.push(principal.agente_nocivo.descricao);
  for (const e of parecer.exposicoes) if (e !== principal) agentes.push(e.agente_nocivo.descricao);

  const postos = [...parecer.postos]
    .sort((a, b) => a.ordem - b.ordem || a.posto_trabalho_id - b.posto_trabalho_id)
    .map((pp) => pp.posto.nome);

  const servidor = parecer.servidor;
  // A cidade é a do SETOR EMISSOR, não a do campus avaliado: o parecer 2/2026,
  // da FAMMUC (Teófilo Otoni), foi datado em Diamantina, onde a CSSO funciona.
  const cidade = setor ? setor.cidade : "Diamantina";
  // UORG é campo próprio; só cai na Unidade quando não houver UORG distinta
  const uorg = parecer.uorg ?? parecer.unidade;

  return new ContextoParecer({
    numero_parecer: parecer.numero,
    ano: parecer.ano,
    data_emissao: dia,
    cidade,
    sigla_unidade_emissora: sigla,
    nome_extenso_emissor: nome_emissor,
    endereco_emissor: endereco,
    telefone_emissor: telefone,
    laudo_de: parecer.tipo_movimento ? parecer.tipo_movimento.nome : "",
    unidade: parecer.unidade ? parecer.unidade.nome_extenso : "",
    postos,
    uorg_bruto: uorg ? UnidadeUorg.uorg_bruto(uorg) : "",
    tipo_laudo: parecer.tipo_adicional ? parecer.tipo_adicional.nome : "",
    numero_processo_sei: parecer.processo ? parecer.processo.nup : "",
    nome_servidor: servidor ? servidor.nome : "",
    matricula: servidor ? servidor.siape : "",
    cargo: parecer.cargo_snapshot || (servidor && servidor.cargo ? servidor.cargo.nome : ""),
    funcao: parecer.funcao_snapshot || (servidor ? servidor.funcao : "") || "",
    laudo_siape: parecer.laudo ? parecer.laudo.numero_siape : "",
    agentes_nocivos: agentes,
    tipo_risco: principal ? principal.agente_nocivo.tipo_risco.nome : "",
    percentual_aplicavel: principal ? principal.percentual.rotulo : "",
    portaria_localizacao: parecer.portaria ? parecer.portaria.texto_original : "",
    fundamentacao_legal: principal ? principal.fundamentacao.texto : "",
    alteracao: parecer.texto_alteracao,
    recomendacao_tecnica: parecer.texto_recomendacao || "",
    reavaliacao: parecer.texto_reavaliacao,
    pro_reitor: parecer.destinatario ? parecer.destinatario.nome : "",
    pro_reitor_cargo: parecer.destinatario ? parecer.destinatario.cargo : "",
    tratamento_destinatario: parecer.destinatario ? parecer.destinatario.tratamento : "",
    assinante_nome: parecer.signatario ? parecer.signatario.nome : "",
    assinante_matricula: parecer.signatario ? (parecer.signatario.siape ?? "") : "",
    assinante_titulo: parecer.signatario ? parecer.signatario.titulo_assinatura : "",
  });
}

// ---------------------------------------------------------------------
// Recomendação a partir do catálogo
// ---------------------------------------------------------------------
export function montar_recomendacao(
  _codigo_texto: string,
  tipo_adicional_recomendacao: string,
  tipo_risco: string,
  data_marco: string,
  template: string,
): string {
  const valores: Record<string, string> = {
    tipo_adicional_recomendacao,
    tipo_risco,
    data_marco_extenso: datas_br.por_extenso(data_marco),
    data_marco_extenso_capitalizado: datas_br.por_extenso_capitalizado(data_marco),
    data_marco_numerica: datas_br.numerica(data_marco),
  };
  let texto = template;
  for (const [chave, valor] of Object.entries(valores)) texto = texto.replaceAll("{{" + chave + "}}", valor);
  return texto;
}

// ---------------------------------------------------------------------
// Emissão
// ---------------------------------------------------------------------
export interface ResultadoEmissao {
  parecer: ParecerCompleto;
  /** a chave do .docx no armazenamento (o `Path` do Python) */
  docx: string;
  pdf: string | null;
  aviso_pdf: string | null;
  avisos: string[];
}

export async function emitir(
  tx: Executor,
  parecer: ParecerCompleto,
  usuario: UsuarioAtual,
  opcoes: { data_emissao?: string | null; gerar_pdf?: boolean } = {},
): Promise<ResultadoEmissao> {
  usuario.exigir("parecer.emitir");

  if (parecer.situacao === "EMITIDO" || parecer.situacao === "ASSINADO") {
    throw new EmissaoBloqueada(["parecer já emitido — RN-14: crie uma nova versão"]);
  }

  const hoje = opcoes.data_emissao ?? datas_br.hoje();
  // A data da emissão vale para as checagens abaixo, mas só é GRAVADA depois
  // que todas passam. Carimbá-la antes contaminava o rascunho recusado. O
  // evento ASSINATURA_NEGADA, esse sim, é o registro da recusa e continua sendo
  // gravado de propósito — a rota confirma a transação antes de devolver a recusa.
  const data_efetiva = parecer.data_emissao ?? hoje;

  // RN-01 - o signatário precisa de habilitação vigente na data
  if (parecer.signatario === null || !vigente_em(parecer.signatario, data_efetiva)) {
    await auditoria.registrar(tx, {
      entidade: "parecer_tecnico",
      entidade_id: parecer.id || 0,
      tipo_evento: auditoria.ASSINATURA_NEGADA,
      descricao: MENSAGEM_RN01,
      usuario,
      processo_id: parecer.processo_id,
    });
    throw new PermissaoNegada("parecer.assinar", MENSAGEM_RN01);
  }

  const validacao = await validar(tx, parecer, data_efetiva);
  if (!validacao.ok) throw new EmissaoBloqueada(validacao.motivos);

  parecer.data_emissao = data_efetiva;

  // número só é consumido agora (RN-03)
  if (parecer.situacao === "RASCUNHO" && !parecer.numero) {
    parecer.numero = await numeracao.proximo_numero_parecer(tx, parecer.ano);
  }

  // RN-15 - congelar
  const setor = parecer.setor_emissor ?? (await setor_emissor_vigente(tx, parecer.data_emissao));
  if (setor !== null) {
    parecer.setor_emissor_id = setor.id;
    parecer.setor_emissor = setor;
    parecer.sigla_emissora_snapshot = setor.sigla_composta;
    parecer.nome_emissor_snapshot = setor.nome_extenso;
    parecer.endereco_emissor_snapshot = setor.endereco;
    parecer.telefone_emissor_snapshot = setor.telefone;
  }
  if (parecer.servidor !== null) {
    parecer.cargo_snapshot = parecer.cargo_snapshot || (parecer.servidor.cargo ? parecer.servidor.cargo.nome : null);
    parecer.funcao_snapshot = parecer.funcao_snapshot || parecer.servidor.funcao;
  }

  const contexto = await montar_contexto(tx, parecer);
  // congela ANTES de renderizar: o que sai no papel é o que fica guardado
  const congelado = contexto.congelar();
  // §7.2: a prova de EPI entra sob a chave "epi", ao lado — e não dentro — do
  // que o documento renderiza. `descongelar` lê só `CAMPOS_CONGELADOS`.
  congelado.epi = await congelar_epi(tx, parecer);
  const destino = documento.caminho_saida(
    parecer.numero,
    parecer.ano,
    contexto.sigla_unidade_emissora || "CSSO",
    contexto.nome_servidor,
  );
  const modelo = parecer.modelo_arquivo || documento.MODELO_V1;
  const info = await documento.renderizar(contexto, destino, modelo);

  const emitido_em = parecer.emitido_em ?? agora_utc();
  const gravar = {
    data_emissao: parecer.data_emissao,
    numero: parecer.numero,
    setor_emissor_id: parecer.setor_emissor_id,
    sigla_emissora_snapshot: parecer.sigla_emissora_snapshot,
    nome_emissor_snapshot: parecer.nome_emissor_snapshot,
    endereco_emissor_snapshot: parecer.endereco_emissor_snapshot,
    telefone_emissor_snapshot: parecer.telefone_emissor_snapshot,
    cargo_snapshot: parecer.cargo_snapshot,
    funcao_snapshot: parecer.funcao_snapshot,
    contexto_congelado: congelado,
    modelo_arquivo: info.modelo_arquivo,
    modelo_sha256: info.modelo_sha256,
    hash_conteudo: info.hash_conteudo,
    situacao: "EMITIDO",
    emitido_por: usuario.id,
    emitido_em,
  };
  await tx.update(parecer_tecnico).set(gravar).where(eq(parecer_tecnico.id, parecer.id));
  Object.assign(parecer, gravar);

  await auditoria.registrar(tx, {
    entidade: "parecer_tecnico",
    entidade_id: parecer.id,
    tipo_evento: auditoria.PARECER_EMITIDO,
    descricao: `Parecer ${parecer.rotulo} emitido (${info.modelo_arquivo}).`,
    usuario,
    processo_id: parecer.processo_id,
    valor_novo: { numero: parecer.numero, ano: parecer.ano, hash_conteudo: parecer.hash_conteudo },
  });
  for (const aviso of validacao.avisos) {
    await auditoria.registrar(tx, {
      entidade: "parecer_tecnico",
      entidade_id: parecer.id,
      tipo_evento: aviso === AVISO_PRESCRICAO ? auditoria.PRESCRICAO_QUINQUENAL_ALERTADA : "AVISO",
      descricao: aviso,
      usuario,
      processo_id: parecer.processo_id,
    });
  }
  for (const exp of parecer.exposicoes) {
    if (exp.excecao_art9_par_unico) {
      await auditoria.registrar(tx, {
        entidade: "exposicao",
        entidade_id: exp.id,
        tipo_evento: auditoria.EXCECAO_ART9_APLICADA,
        descricao: exp.justificativa_art9 || "",
        usuario,
        processo_id: parecer.processo_id,
      });
    }
    // RN-06: o texto de reavaliação não basta — a avaliação quantitativa vira
    // tarefa com dono e prazo.
    if (exp.agente_nocivo.exige_reavaliacao_quantitativa) {
      await pendencias.abrir(tx, {
        tipo: "AVALIACAO_QUANTITATIVA",
        chave: `quantitativa:exposicao:${exp.id}`,
        descricao:
          `Avaliar quantitativamente '${exp.agente_nocivo.descricao}' e ` +
          `elaborar novo laudo (parecer ${parecer.rotulo}).`,
        usuario,
        processo_id: parecer.processo_id,
        parecer_id: parecer.id,
      });
    }
  }

  await pendencias.abrir(tx, {
    tipo: "INCLUIR_NO_SEI",
    chave: `sei:parecer:${parecer.id}`,
    descricao: `Incluir o parecer ${parecer.rotulo} no SEI e registrar o nº do documento e o link permanente.`,
    usuario,
    processo_id: parecer.processo_id,
    parecer_id: parecer.id,
  });

  // A conversão é a ÚLTIMA coisa. Na nuvem não há LibreOffice (DESVIOS.md):
  // `converter_fora_da_transacao` devolve na hora o aviso de "sem PDF", o
  // mesmo que o Python dava numa máquina sem LibreOffice — e "indisponível"
  // não é incidente, então a trilha não ganha PDF_NAO_GERADO.
  let resultado_pdf: string | null = null;
  let aviso_pdf: string | null = null;
  if (opcoes.gerar_pdf ?? true) {
    [resultado_pdf, aviso_pdf] = await _pdf_depois_da_emissao(tx, parecer, usuario, destino);
  }
  return { parecer, docx: destino, pdf: resultado_pdf, aviso_pdf, avisos: validacao.avisos };
}

/**
 * No Python: converte com o lock solto e registra `PDF_NAO_GERADO` quando a
 * máquina TEM LibreOffice e mesmo assim não converteu. Na nuvem a conversão
 * nunca está disponível, e o ramo do incidente fica pelo contrato.
 */
async function _pdf_depois_da_emissao(
  tx: Executor,
  parecer: ParecerCompleto,
  usuario: UsuarioAtual,
  destino: string,
): Promise<[string | null, string | null]> {
  const conversao = servico_pdf.converter_fora_da_transacao(tx, destino, destino.replace(/\.docx$/, ".pdf"));
  if (!conversao.gerado && !conversao.indisponivel) {
    const nome = destino.split("/").pop();
    await auditoria.registrar(tx, {
      entidade: "parecer_tecnico",
      entidade_id: parecer.id,
      tipo_evento: auditoria.PDF_NAO_GERADO,
      descricao:
        `Parecer ${parecer.rotulo} emitido, mas o PDF não foi gerado. ` +
        `O .docx está em ${nome} e vale como o documento; ` +
        `reimprima o PDF pela ficha do parecer. Detalhe: ${conversao.aviso}`,
      usuario,
      processo_id: parecer.processo_id,
    });
  }
  return [conversao.caminho, conversao.aviso];
}

/** RN-01: permissão E habilitação vigente. Sem os dois, 403 duro. */
export async function assinar(tx: Executor, parecer: ParecerCompleto, usuario: UsuarioAtual): Promise<ParecerCompleto> {
  if (!usuario.pode("parecer.assinar") || !(await pode_subscrever(tx, usuario, datas_br.hoje()))) {
    await auditoria.registrar(tx, {
      entidade: "parecer_tecnico",
      entidade_id: parecer.id,
      tipo_evento: auditoria.ASSINATURA_NEGADA,
      descricao: MENSAGEM_RN01,
      usuario,
      processo_id: parecer.processo_id,
    });
    throw new PermissaoNegada("parecer.assinar", MENSAGEM_RN01);
  }

  if (parecer.situacao !== "EMITIDO") {
    throw new EmissaoBloqueada(["só um parecer EMITIDO pode ser marcado como assinado"]);
  }

  const novos = { situacao: "ASSINADO", assinado_em: agora_utc() };
  await tx.update(parecer_tecnico).set(novos).where(eq(parecer_tecnico.id, parecer.id));
  Object.assign(parecer, novos);
  await auditoria.registrar(tx, {
    entidade: "parecer_tecnico",
    entidade_id: parecer.id,
    tipo_evento: "PARECER_ASSINADO",
    descricao: `Parecer ${parecer.rotulo} marcado como assinado.`,
    usuario,
    processo_id: parecer.processo_id,
  });
  return parecer;
}

/** A anulação sem motivo (o `ValueError("anulação exige motivo")`). */
export class AnulacaoSemMotivo extends RegraViolada {}

export async function anular(
  tx: Executor,
  parecer: ParecerCompleto,
  usuario: UsuarioAtual,
  motivo: string,
): Promise<ParecerCompleto> {
  usuario.exigir("parecer.anular");
  if (!motivo || !motivo.trim()) throw new AnulacaoSemMotivo("anulação exige motivo");
  const novos = { situacao: "ANULADO", motivo_anulacao: motivo.trim() };
  await tx.update(parecer_tecnico).set(novos).where(eq(parecer_tecnico.id, parecer.id));
  Object.assign(parecer, novos);
  await auditoria.registrar(tx, {
    entidade: "parecer_tecnico",
    entidade_id: parecer.id,
    tipo_evento: auditoria.PARECER_ANULADO,
    descricao: `Parecer ${parecer.rotulo} anulado: ${motivo.trim()}`,
    usuario,
    processo_id: parecer.processo_id,
  });
  return parecer;
}

// ---------------------------------------------------------------------
// RN-11 - cascata de reavaliação
// ---------------------------------------------------------------------
type Laudo = typeof laudo_tecnico.$inferSelect;
type ParecerLinha = typeof parecer_tecnico.$inferSelect;

export async function marcar_laudo_superado(
  tx: Executor,
  laudo: Laudo,
  usuario: UsuarioAtual,
  motivo: string,
  substituto: Pick<Laudo, "id"> | null = null,
): Promise<ParecerLinha[]> {
  usuario.exigir("laudo.criar");
  const novos: Partial<Laudo> = {
    status: "SUPERADO",
    motivo_ultima_conferencia: motivo,
    data_ultima_conferencia: datas_br.hoje(),
  };
  if (substituto !== null) novos.substituido_por_id = substituto.id;
  await tx.update(laudo_tecnico).set(novos).where(eq(laudo_tecnico.id, laudo.id));
  Object.assign(laudo, novos);

  const derivados = await tx
    .select()
    .from(parecer_tecnico)
    .where(eq(parecer_tecnico.laudo_id, laudo.id))
    .orderBy(asc(parecer_tecnico.id));
  for (const parecer of derivados) {
    await tx
      .update(adicional_vigencia)
      .set({ estado: "EM_REAVALIACAO" })
      .where(
        and(
          eq(adicional_vigencia.parecer_id, parecer.id),
          inArray(adicional_vigencia.estado, ["VIGENTE", "ALTERADO", "SUSPENSO"]),
        ),
      );
    await pendencias.abrir(tx, {
      tipo: "REAVALIACAO_LAUDO",
      chave: `reavaliacao:parecer:${parecer.id}:laudo:${laudo.id}`,
      descricao: `Laudo ${laudo.numero_siape} superado (${motivo}) — reavaliar o parecer ${ParecerTecnico.rotulo(parecer)}.`,
      usuario,
      processo_id: parecer.processo_id,
      parecer_id: parecer.id,
      laudo_id: laudo.id,
    });
  }

  await auditoria.registrar(tx, {
    entidade: "laudo_tecnico",
    entidade_id: laudo.id,
    tipo_evento: auditoria.LAUDO_SUPERADO,
    descricao:
      `Laudo ${laudo.numero_siape} marcado como superado (${motivo}). ` +
      `${derivados.length} parecer(es) derivado(s) em reavaliação.`,
    usuario,
  });
  return derivados;
}

/** Os números já ocupados no ano, fora este parecer (o editor mostra). */
export async function numeros_usados(tx: Executor, parecer: Pick<ParecerLinha, "id" | "ano">): Promise<number[]> {
  const linhas = await tx
    .select({ numero: parecer_tecnico.numero })
    .from(parecer_tecnico)
    .where(and(eq(parecer_tecnico.ano, parecer.ano), ne(parecer_tecnico.id, parecer.id)));
  return [...new Set(linhas.map((l) => l.numero))].sort((a, b) => a - b);
}

/** Os profissionais com habilitação vigente na data (o painel conta). */
export async function habilitados_vigentes(tx: Executor, quando: string | null = null) {
  const dia = quando ?? datas_br.hoje();
  return (await tx.select().from(profissional_habilitado)).filter((h) => vigente_em(h, dia));
}

// A regra do dono do anexo `parecer_tecnico` é a porta de leitura deste
// serviço (DESVIOS.md: `anexo_acesso` recebe a regra de quem é dono).
declarar_porta("parecer_no_escopo", no_escopo);
