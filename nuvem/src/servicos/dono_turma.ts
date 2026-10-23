/**
 * NUVEM: a REGRA DE DONO do módulo Certificados e Treinamentos (23/10/2026) —
 * a decisão num lugar só. Rotas, serviços e templates perguntam AQUI.
 *
 * **O dono.** O treinamento do catálogo e a turma são da conta que os CRIOU
 * (`criado_por`; a migração 0017 preencheu os antigos pelo evento de criação
 * da trilha). Sem dono registrado (nulo) = "sem dono": só a hierarquia
 * superior altera. O dono não se troca (trava `csso_dono_imutavel`).
 *
 * **Quem altera** (`direito_na_turma`), além de ter a permissão do ato — a
 * regra é uma camada A MAIS sobre o RBAC, nunca dá permissão:
 *
 * 1. o dono;
 * 2. o superintendente (tudo);
 * 3. a coordenação (`rbac.NIVEL_HIERARQUICO_POR_PERFIL`) da turma do PRÓPRIO
 *    setor promotor — o setor a que a conta está vinculada, e não o "ver
 *    todos os setores" — quando o dono está ABAIXO dela (ou não há dono);
 *    entre coordenadores, só o dono;
 * 4. o AJUDANTE que o dono (ou quem está acima dele) designou, só nos papéis
 *    dados (`turma_ajudante`); ajudante não designa ninguém;
 * 5. o resto só CONSULTA: os botões somem e o POST é recusado (403) com o
 *    aviso "Esta turma é de {dono}; só ele ou a coordenação acima pode alterar".
 *
 * A leitura não muda, e o titular continua com o que é dele (inscrever-se,
 * desistir, o próprio certificado) — nada disso passa por aqui.
 *
 * **Os papéis.** `GERAL` é o do dono e de quem está acima dele, e não se
 * delega: editar a turma, mudar a situação (concluir, cancelar), excluir,
 * registrar como realizada, instrutores, link público, retificação, designar
 * ajudantes. Os três delegáveis, escolhidos para ficar simples:
 *
 * - `INSCRICOES` — inscrever (uma a uma e em lote), aceitar/recusar pedidos
 *   (inclusive os do link público), cancelar inscrição, corrigir o cadastro e o
 *   CPF do inscrito;
 * - `PRESENCA` — presença e notas;
 * - `EMISSAO` — emitir, anular, reemitir e enviar os certificados da turma, e
 *   os campos que o modelo pede.
 *
 * O nome do dono que aparece no aviso é o NOME DA CONTA (`usuario.nome`) —
 * quem operou é nominal, como na trilha; a RN-19 protege o titular (o
 * servidor e o participante), e nenhum dado dele sai aqui.
 *
 * **Compatibilidade.** O `UsuarioAtual` montado à mão nos testes de serviço
 * (`concessoes === null`) não é recortado, como no resto do RBAC
 * (`setor_equipe.ve_todos`).
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  certificado as tabela_certificado,
  equipe_setor_promotor as tabela_equipe,
  inscricao as tabela_inscricao,
  turma as tabela_turma,
  turma_ajudante as tabela_ajudante,
  unidade_uorg as tabela_unidade,
  usuario as tabela_usuario,
} from "../db/esquema/index.js";
import { PermissaoNegada } from "../nucleo/erros.js";
import * as auditoria from "./auditoria.js";
import {
  NIVEL_COORDENACAO,
  NIVEL_SUPERINTENDENCIA,
  NOME_OFICIAL_CSSO,
  nivel_hierarquico,
  perfis_vigentes,
  type UsuarioAtual,
} from "./rbac.js";

/** Os eventos da trilha (rótulos em `auditoria.ROTULO_EVENTO`). */
export const TURMA_AJUDANTE_DESIGNADO = "TURMA_AJUDANTE_DESIGNADO";
export const TURMA_AJUDANTE_RETIRADO = "TURMA_AJUDANTE_RETIRADO";

// =====================================================================
// Papéis
// =====================================================================
export const GERAL = "GERAL";
export const INSCRICOES = "INSCRICOES";
export const PRESENCA = "PRESENCA";
export const EMISSAO = "EMISSAO";
export type Papel = typeof GERAL | typeof INSCRICOES | typeof PRESENCA | typeof EMISSAO;
export type PapelDeAjudante = typeof INSCRICOES | typeof PRESENCA | typeof EMISSAO;

/** Os papéis que se delegam ao ajudante, na ordem da ficha (coluna de `turma_ajudante`). */
export const PAPEIS_DE_AJUDANTE: readonly { papel: PapelDeAjudante; coluna: "inscricoes" | "presenca" | "emissao"; rotulo: string; dica: string }[] =
  Object.freeze([
    {
      papel: INSCRICOES,
      coluna: "inscricoes",
      rotulo: "Inscrições",
      dica: "inscrever, aceitar ou recusar pedidos (também os do link), cancelar inscrição",
    },
    { papel: PRESENCA, coluna: "presenca", rotulo: "Presença e notas", dica: "lançar presença e notas" },
    {
      papel: EMISSAO,
      coluna: "emissao",
      rotulo: "Emissão",
      dica: "emitir, anular, reemitir e enviar os certificados da turma",
    },
  ]);

export const ROTULO_PAPEL: Readonly<Record<Papel, string>> = Object.freeze({
  [GERAL]: "Dados da turma",
  [INSCRICOES]: "Inscrições",
  [PRESENCA]: "Presença e notas",
  [EMISSAO]: "Emissão",
});

/**
 * O papel que o ato de cada permissão pede na turma — o que o template usa
 * (`pode_aqui`) para esconder o botão. Permissão fora daqui não é de
 * alteração de turma e passa como está.
 */
export const PAPEL_DA_PERMISSAO: Readonly<Record<string, Papel>> = Object.freeze({
  "turma.criar": GERAL,
  "turma.concluir": GERAL,
  "turma.inscrever": INSCRICOES,
  "turma.avaliar": PRESENCA,
  "certificado.emitir": EMISSAO,
  "certificado.anular": EMISSAO,
});

// =====================================================================
// A recusa
// =====================================================================
export const CODIGO_RECUSA = "turma.dono";

/** A recusa do ato por não ser dono, superior nem ajudante do papel: 403 com o aviso. */
export class AlteracaoRecusada extends PermissaoNegada {
  constructor(mensagem: string) {
    super(CODIGO_RECUSA, mensagem);
  }
}

// =====================================================================
// O direito
// =====================================================================
export type Motivo = "DONO" | "SUPERIOR" | "AJUDANTE" | "CONSULTA" | "LIVRE";

export interface Dono {
  id: number;
  nome: string;
  nivel: number;
  setores: readonly number[];
  csso: boolean;
}

/** O que a conta pode na turma, já decidido. O template lê `pode(papel)` e `aviso`. */
export class DireitoNaTurma {
  constructor(
    readonly motivo: Motivo,
    readonly papeis: ReadonlySet<Papel>,
    readonly dono: { id: number; nome: string } | null,
    readonly aviso: string,
  ) {
    Object.freeze(this);
  }

  /** Pode alterar a turma neste papel? (a permissão do ato é pergunta à parte) */
  pode(papel: Papel): boolean {
    return this.papeis.has(papel);
  }

  /** Designa e retira ajudantes: o dono e quem está acima dele — nunca o ajudante. */
  get designa(): boolean {
    return this.papeis.has(GERAL);
  }

  /** Só consulta: nenhum papel. */
  get so_consulta(): boolean {
    return this.papeis.size === 0;
  }

  get eh_dono(): boolean {
    return this.motivo === "DONO";
  }

  /** O nome que a tela mostra como dono, ou a frase do "sem dono". */
  get nome_do_dono(): string {
    return this.dono ? this.dono.nome : SEM_DONO;
  }
}

export const SEM_DONO = "sem dono registrado";

const TODOS: ReadonlySet<Papel> = Object.freeze(new Set<Papel>([GERAL, INSCRICOES, PRESENCA, EMISSAO]));
const NENHUM: ReadonlySet<Papel> = Object.freeze(new Set<Papel>());

/** A frase da recusa, também a que a ficha mostra a quem só consulta. */
export function aviso_de(dono: { nome: string } | null, coisa: "turma" | "treinamento" = "turma"): string {
  const artigo = coisa === "turma" ? "Esta turma" : "Este treinamento";
  if (dono) return `${artigo} é de ${dono.nome}; só ele ou a coordenação acima pode alterar.`;
  return (
    `${artigo} não tem dono registrado (é de antes da regra de dono); ` +
    "só a coordenação do setor ou a superintendência pode alterar."
  );
}

/** A conta que criou: nome, nível hierárquico de hoje e setores promotores. */
async function _dono(tx: Executor, usuario_id: number): Promise<Dono | null> {
  const [conta, vigentes, setores] = await Promise.all([
    tx.select({ id: tabela_usuario.id, nome: tabela_usuario.nome }).from(tabela_usuario).where(eq(tabela_usuario.id, usuario_id)),
    perfis_vigentes(tx, usuario_id),
    tx
      .select({ id: tabela_equipe.unidade_uorg_id, nome_oficial: tabela_unidade.nome_oficial })
      .from(tabela_equipe)
      .innerJoin(tabela_unidade, eq(tabela_unidade.id, tabela_equipe.unidade_uorg_id))
      .where(eq(tabela_equipe.usuario_id, usuario_id)),
  ]);
  if (!conta[0]) return null;
  return {
    id: conta[0].id,
    nome: conta[0].nome,
    nivel: nivel_hierarquico(vigentes.perfis),
    setores: setores.map((s) => s.id),
    csso: setores.some((s) => s.nome_oficial === NOME_OFICIAL_CSSO),
  };
}

/** O dono, lido uma vez por conta dentro de uma decisão em lote. */
function _dono_guardado(tx: Executor, id: number | null, donos: Map<number, Promise<Dono | null>>): Promise<Dono | null> {
  if (id === null) return Promise.resolve(null);
  let p = donos.get(id);
  if (!p) {
    p = _dono(tx, id);
    donos.set(id, p);
  }
  return p;
}

/** A conta está VINCULADA ao setor promotor da turma (sem setor = a CSSO)? */
function _do_meu_setor(usuario: UsuarioAtual, unidade_promotora_id: number | null): boolean {
  if (unidade_promotora_id === null) return usuario.setor_csso;
  return usuario.setores_promotores.includes(unidade_promotora_id);
}

/** O que a turma precisa ter para a decisão. */
export interface TurmaDoDono {
  id: number;
  criado_por: number | null;
  unidade_promotora_id: number | null;
}

/**
 * A decisão: o que `usuario` pode alterar em `turma`. Uma leitura do dono e
 * uma do ajudante; quem chama várias vezes na mesma requisição guarda o
 * resultado (a ficha o põe no contexto).
 */
export async function direito_na_turma(
  tx: Executor,
  usuario: UsuarioAtual,
  turma: TurmaDoDono,
  donos: Map<number, Promise<Dono | null>> = new Map(),
): Promise<DireitoNaTurma> {
  const dono = await _dono_guardado(tx, turma.criado_por, donos);
  const visivel = dono ? { id: dono.id, nome: dono.nome } : null;
  const aviso = aviso_de(visivel);
  if (usuario.concessoes === null) return new DireitoNaTurma("LIVRE", TODOS, visivel, aviso);
  if (dono && dono.id === usuario.id) return new DireitoNaTurma("DONO", TODOS, visivel, aviso);
  const meu = nivel_hierarquico(usuario.perfis);
  if (meu >= NIVEL_SUPERINTENDENCIA) return new DireitoNaTurma("SUPERIOR", TODOS, visivel, aviso);
  const abaixo = dono === null || dono.nivel < meu;
  if (meu >= NIVEL_COORDENACAO && abaixo && _do_meu_setor(usuario, turma.unidade_promotora_id)) {
    return new DireitoNaTurma("SUPERIOR", TODOS, visivel, aviso);
  }
  const [ajuda] = await tx
    .select()
    .from(tabela_ajudante)
    .where(and(eq(tabela_ajudante.turma_id, turma.id), eq(tabela_ajudante.usuario_id, usuario.id)));
  if (ajuda) {
    const papeis = new Set<Papel>(PAPEIS_DE_AJUDANTE.filter((p) => ajuda[p.coluna]).map((p) => p.papel));
    return new DireitoNaTurma("AJUDANTE", Object.freeze(papeis), visivel, aviso);
  }
  return new DireitoNaTurma("CONSULTA", NENHUM, visivel, aviso);
}

/** A pergunta curta: `usuario` pode alterar `turma` em `papel`? */
export async function pode_alterar_turma(
  tx: Executor,
  usuario: UsuarioAtual,
  turma: TurmaDoDono,
  papel: Papel,
): Promise<boolean> {
  return (await direito_na_turma(tx, usuario, turma)).pode(papel);
}

/** A frase da recusa para quem tem o direito `d` e pediu `papel`. */
export function recusa_de(d: DireitoNaTurma, papel: Papel): string {
  if (d.motivo === "AJUDANTE") {
    const dados = [...d.papeis].map((p) => ROTULO_PAPEL[p]).join(", ");
    return `Você ajuda nesta turma só em: ${dados}. ${d.aviso}`;
  }
  void papel;
  return d.aviso;
}

/**
 * A porta dos atos: devolve o direito, ou recusa (403 com o aviso) quem não é
 * dono, superior nem ajudante do papel. Ninguém grava nada antes daqui.
 */
export async function exigir_alterar_turma(
  tx: Executor,
  usuario: UsuarioAtual,
  turma: TurmaDoDono,
  papel: Papel,
): Promise<DireitoNaTurma> {
  const d = await direito_na_turma(tx, usuario, turma);
  if (!d.pode(papel)) throw new AlteracaoRecusada(recusa_de(d, papel));
  return d;
}

/**
 * O `pode()` da ficha: a permissão do RBAC E o papel na turma. É o que o
 * template chama no lugar de `usuario.pode(...)` para os botões da turma.
 */
export function pode_aqui(usuario: UsuarioAtual, d: DireitoNaTurma, permissao: string): boolean {
  if (!usuario.pode(permissao)) return false;
  const papel = Object.hasOwn(PAPEL_DA_PERMISSAO, permissao) ? PAPEL_DA_PERMISSAO[permissao]! : null;
  return papel === null || d.pode(papel);
}

/**
 * Várias turmas de uma vez (as ações em lote: pedidos do link, fila de
 * emissão, envio por e-mail): `{turma_id: direito}`.
 */
export async function direitos_nas_turmas(
  tx: Executor,
  usuario: UsuarioAtual,
  turma_ids: readonly number[],
): Promise<Map<number, DireitoNaTurma>> {
  const saida = new Map<number, DireitoNaTurma>();
  const ids = [...new Set(turma_ids)];
  if (!ids.length) return saida;
  const turmas = await tx
    .select({ id: tabela_turma.id, criado_por: tabela_turma.criado_por, unidade_promotora_id: tabela_turma.unidade_promotora_id })
    .from(tabela_turma)
    .where(inArray(tabela_turma.id, ids));
  const donos = new Map<number, Promise<Dono | null>>();
  for (const t of turmas) saida.set(t.id, await direito_na_turma(tx, usuario, t, donos));
  return saida;
}

// =====================================================================
// Treinamento do catálogo
// =====================================================================
export interface TreinamentoDoDono {
  id: number;
  criado_por: number | null;
}

export interface DireitoNoTreinamento {
  pode: boolean;
  dono: { id: number; nome: string } | null;
  aviso: string;
}

/**
 * O treinamento não tem setor: a coordenação altera o do dono abaixo dela que
 * está num setor promotor DELA (ou o sem dono); o superintendente, todos.
 * Não há ajudante no catálogo.
 */
export async function direito_no_treinamento(
  tx: Executor,
  usuario: UsuarioAtual,
  treinamento: TreinamentoDoDono,
  donos: Map<number, Promise<Dono | null>> = new Map(),
): Promise<DireitoNoTreinamento> {
  const dono = await _dono_guardado(tx, treinamento.criado_por, donos);
  const visivel = dono ? { id: dono.id, nome: dono.nome } : null;
  const resposta = (pode: boolean) => ({ pode, dono: visivel, aviso: aviso_de(visivel, "treinamento") });
  if (usuario.concessoes === null) return resposta(true);
  if (dono && dono.id === usuario.id) return resposta(true);
  const meu = nivel_hierarquico(usuario.perfis);
  if (meu >= NIVEL_SUPERINTENDENCIA) return resposta(true);
  if (meu >= NIVEL_COORDENACAO) {
    if (dono === null) return resposta(true);
    const mesmo_setor =
      dono.setores.some((s) => usuario.setores_promotores.includes(s)) || (dono.csso && usuario.setor_csso);
    if (dono.nivel < meu && mesmo_setor) return resposta(true);
  }
  return resposta(false);
}

/** O direito em cada treinamento da lista (o catálogo): `{id: direito}`. */
export async function direitos_nos_treinamentos(
  tx: Executor,
  usuario: UsuarioAtual,
  itens: readonly TreinamentoDoDono[],
): Promise<Record<number, DireitoNoTreinamento>> {
  const donos = new Map<number, Promise<Dono | null>>();
  const saida: Record<number, DireitoNoTreinamento> = {};
  for (const t of itens) saida[t.id] = await direito_no_treinamento(tx, usuario, t, donos);
  return saida;
}

export async function exigir_alterar_treinamento(
  tx: Executor,
  usuario: UsuarioAtual,
  treinamento: TreinamentoDoDono,
): Promise<void> {
  const d = await direito_no_treinamento(tx, usuario, treinamento);
  if (!d.pode) throw new AlteracaoRecusada(d.aviso);
}

// =====================================================================
// Ajudantes
// =====================================================================
export interface Ajudante {
  usuario_id: number;
  nome: string;
  login: string;
  papeis: PapelDeAjudante[];
  rotulos: string[];
  designado_em: Date;
}

export async function ajudantes_da_turma(tx: Executor, turma_id: number): Promise<Ajudante[]> {
  const linhas = await tx
    .select({ a: tabela_ajudante, nome: tabela_usuario.nome, login: tabela_usuario.login })
    .from(tabela_ajudante)
    .innerJoin(tabela_usuario, eq(tabela_usuario.id, tabela_ajudante.usuario_id))
    .where(eq(tabela_ajudante.turma_id, turma_id))
    .orderBy(asc(tabela_usuario.nome));
  return linhas.map(({ a, nome, login }) => {
    const dele = PAPEIS_DE_AJUDANTE.filter((p) => a[p.coluna]);
    return {
      usuario_id: a.usuario_id,
      nome,
      login,
      papeis: dele.map((p) => p.papel),
      rotulos: dele.map((p) => p.rotulo),
      designado_em: a.designado_em,
    };
  });
}

/**
 * Quem pode ser designado: conta ATIVA vinculada ao setor promotor da turma
 * (a turma sem setor é da CSSO), fora o dono.
 */
export async function candidatos_a_ajudante(
  tx: Executor,
  turma: TurmaDoDono,
): Promise<{ id: number; nome: string; login: string }[]> {
  let unidade = turma.unidade_promotora_id;
  if (unidade === null) {
    const [csso] = await tx
      .select({ id: tabela_unidade.id })
      .from(tabela_unidade)
      .where(eq(tabela_unidade.nome_oficial, NOME_OFICIAL_CSSO));
    if (!csso) return [];
    unidade = csso.id;
  }
  const linhas = await tx
    .select({ id: tabela_usuario.id, nome: tabela_usuario.nome, login: tabela_usuario.login })
    .from(tabela_equipe)
    .innerJoin(tabela_usuario, eq(tabela_usuario.id, tabela_equipe.usuario_id))
    .where(and(eq(tabela_equipe.unidade_uorg_id, unidade), eq(tabela_usuario.ativo, true)))
    .orderBy(asc(tabela_usuario.nome));
  return linhas.filter((l) => l.id !== turma.criado_por);
}

/** A recusa da tela de ajudantes, que a rota traduz em aviso. */
export class AjudanteRecusado extends Error {}

function _frase_papeis(papeis: readonly PapelDeAjudante[]): string {
  return PAPEIS_DE_AJUDANTE.filter((p) => papeis.includes(p.papel))
    .map((p) => p.rotulo.toLowerCase())
    .join(", ");
}

/**
 * Designa (ou muda os papéis de) um ajudante. Só o dono e quem está acima
 * dele (`GERAL`); o ajudante não designa. Sem papel nenhum, recusa: para
 * tirar, é "retirar".
 */
export async function designar_ajudante(
  tx: Executor,
  usuario: UsuarioAtual,
  turma: TurmaDoDono & { codigo: string },
  conta_id: number,
  papeis: readonly string[],
): Promise<void> {
  await exigir_alterar_turma(tx, usuario, turma, GERAL);
  const escolhidos = PAPEIS_DE_AJUDANTE.filter((p) => papeis.includes(p.papel)).map((p) => p.papel);
  if (!escolhidos.length) throw new AjudanteRecusado("Marque ao menos um papel para o ajudante.");
  if (conta_id === turma.criado_por) throw new AjudanteRecusado("O dono da turma já pode tudo nela: não precisa ser ajudante.");
  const candidatos = await candidatos_a_ajudante(tx, turma);
  const conta = candidatos.find((c) => c.id === conta_id);
  if (!conta) {
    throw new AjudanteRecusado("Escolha uma conta ativa da equipe do setor promotor da turma.");
  }
  const valores = {
    inscricoes: escolhidos.includes(INSCRICOES),
    presenca: escolhidos.includes(PRESENCA),
    emissao: escolhidos.includes(EMISSAO),
  };
  const [ja] = await tx
    .select()
    .from(tabela_ajudante)
    .where(and(eq(tabela_ajudante.turma_id, turma.id), eq(tabela_ajudante.usuario_id, conta_id)));
  if (ja && ja.inscricoes === valores.inscricoes && ja.presenca === valores.presenca && ja.emissao === valores.emissao) {
    return;
  }
  await tx
    .insert(tabela_ajudante)
    .values({ turma_id: turma.id, usuario_id: conta_id, ...valores, designado_por: usuario.id })
    .onConflictDoUpdate({
      target: [tabela_ajudante.turma_id, tabela_ajudante.usuario_id],
      set: { ...valores, designado_por: usuario.id },
    });
  await auditoria.registrar(tx, {
    entidade: "turma",
    entidade_id: turma.id,
    tipo_evento: TURMA_AJUDANTE_DESIGNADO,
    descricao: `${turma.codigo} · ajudante ${conta.nome} (${conta.login}) · ${_frase_papeis(escolhidos)}`,
    valor_anterior: ja ? { inscricoes: ja.inscricoes, presenca: ja.presenca, emissao: ja.emissao } : null,
    valor_novo: valores,
    usuario,
  });
}

/** Retira o ajudante (apaga a designação; a trilha fica). */
export async function retirar_ajudante(
  tx: Executor,
  usuario: UsuarioAtual,
  turma: TurmaDoDono & { codigo: string },
  conta_id: number,
): Promise<void> {
  await exigir_alterar_turma(tx, usuario, turma, GERAL);
  const [ja] = await tx
    .select({ a: tabela_ajudante, nome: tabela_usuario.nome, login: tabela_usuario.login })
    .from(tabela_ajudante)
    .innerJoin(tabela_usuario, eq(tabela_usuario.id, tabela_ajudante.usuario_id))
    .where(and(eq(tabela_ajudante.turma_id, turma.id), eq(tabela_ajudante.usuario_id, conta_id)));
  if (!ja) throw new AjudanteRecusado("Esta conta não é ajudante da turma.");
  await tx
    .delete(tabela_ajudante)
    .where(and(eq(tabela_ajudante.turma_id, turma.id), eq(tabela_ajudante.usuario_id, conta_id)));
  await auditoria.registrar(tx, {
    entidade: "turma",
    entidade_id: turma.id,
    tipo_evento: TURMA_AJUDANTE_RETIRADO,
    descricao: `${turma.codigo} · ajudante ${ja.nome} (${ja.login}) retirado`,
    valor_anterior: { inscricoes: ja.a.inscricoes, presenca: ja.a.presenca, emissao: ja.a.emissao },
    usuario,
  });
}

// =====================================================================
// Certificado: a turma dele decide
// =====================================================================
/** A turma de cada certificado (`{certificado_id: turma}`) — todo certificado tem inscrição e turma. */
export async function turmas_dos_certificados(
  tx: Executor,
  certificado_ids: readonly number[],
): Promise<Map<number, TurmaDoDono>> {
  const saida = new Map<number, TurmaDoDono>();
  const ids = [...new Set(certificado_ids)];
  if (!ids.length) return saida;
  const linhas = await tx
    .select({
      certificado_id: tabela_certificado.id,
      id: tabela_turma.id,
      criado_por: tabela_turma.criado_por,
      unidade_promotora_id: tabela_turma.unidade_promotora_id,
    })
    .from(tabela_certificado)
    .innerJoin(tabela_inscricao, eq(tabela_inscricao.id, tabela_certificado.inscricao_id))
    .innerJoin(tabela_turma, eq(tabela_turma.id, tabela_inscricao.turma_id))
    .where(inArray(tabela_certificado.id, ids));
  for (const { certificado_id, ...turma } of linhas) saida.set(certificado_id, turma);
  return saida;
}

/** O direito sobre o certificado é o da turma dele (`EMISSAO`: emitir, anular, corrigir, enviar). */
export async function direito_no_certificado(
  tx: Executor,
  usuario: UsuarioAtual,
  certificado_id: number,
): Promise<DireitoNaTurma | null> {
  const turma = (await turmas_dos_certificados(tx, [certificado_id])).get(certificado_id);
  return turma ? direito_na_turma(tx, usuario, turma) : null;
}

export async function exigir_alterar_certificado(
  tx: Executor,
  usuario: UsuarioAtual,
  certificado_id: number,
  papel: Papel = EMISSAO,
): Promise<void> {
  const d = await direito_no_certificado(tx, usuario, certificado_id);
  if (d && !d.pode(papel)) throw new AlteracaoRecusada(recusa_de(d, papel));
}
