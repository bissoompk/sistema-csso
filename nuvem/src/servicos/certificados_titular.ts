/**
 * NUVEM (Portal do servidor, 22/10/2026): os certificados do PRÓPRIO titular
 * em cartões — "Meus certificados", o Início do servidor e o resumo de Minha
 * conta leem daqui.
 *
 * **O cartão lê do congelado (RN-15).** Nome do treinamento, norma, período,
 * carga, conteúdo programático e setor saem do `contexto_congelado`: o que o
 * papel diz. Só o que NÃO está no papel vem do cadastro de hoje: a sigla, a
 * cor e o ícone do setor promotor (pela turma), e o fallback do nome do setor
 * quando o congelado antigo não o tem.
 *
 * **Só o que é do titular.** Toda consulta é presa ao `servidor_id` da conta
 * (`emissao_certificado.consulta_do_titular`) — ou, para o terceirizado e o
 * discente, ao participante ligado à conta (`titular_externo.ts`); nenhum CPF
 * sai daqui — nem o do titular, nem o de instrutor (`instrutores[].cpf` fica
 * no congelado).
 */
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  campus as tabela_campus,
  certificado as tabela_certificado,
  servidor as tabela_servidor,
  inscricao as tabela_inscricao,
  participante as tabela_participante,
  treinamento as tabela_treinamento,
  turma as tabela_turma,
  unidade_uorg as tabela_unidade,
} from "../db/esquema/index.js";
import { Certificado as C, Treinamento, situacao_do_cartao, type SituacaoCartao } from "../dominio/treinamento.js";
import * as datas_br from "./datas_br.js";
import { numero as numero_br } from "./presenca.js";
import { qr_png } from "./qr.js";
import { chave_busca } from "./textos.js";
import { aberta_a_pedido_proprio } from "./turma.js";
import * as titular_externo from "./titular_externo.js";
import type { UsuarioAtual } from "./rbac.js";

type CertificadoRegistro = typeof tabela_certificado.$inferSelect;

/**
 * De quem são os certificados: o `servidor_id` (o número sozinho, como sempre
 * foi) ou, para o titular externo, `{ participante_id }`. `null` é ninguém.
 */
export type ChaveDoTitular = number | { participante_id: number } | null;

/** A chave da CONTA: o servidor ligado, ou o participante da conta externa. */
export async function chave_da_conta(tx: Executor, usuario: UsuarioAtual): Promise<ChaveDoTitular> {
  if (usuario.servidor_id !== null) return usuario.servidor_id;
  const participante_id = await titular_externo.id_do_participante_da_conta(tx, usuario);
  return participante_id === null ? null : { participante_id };
}

export interface SetorDoCartao {
  nome: string;
  sigla: string;
  /** chave da paleta (`dominio/organizacao.CORES_SETOR`) ou null */
  cor: string | null;
  icone: string | null;
}

export interface CartaoCertificado {
  id: number;
  /** `CSSO-NR35-2026-0001`, ou `27/2026` no emitido antes */
  rotulo: string;
  chave: string;
  url_validacao: string;
  treinamento_id: number;
  treinamento: string;
  norma: string;
  setor: SetorDoCartao;
  turma_codigo: string;
  inicio: string | null;
  fim: string | null;
  /** "17, 18 e 19/08/2026" — `datas_br.periodo_curto` */
  periodo: string;
  /** "16" (horas, decimal em vírgula) */
  carga_horaria: string;
  /** número para somar (a "X h de capacitação") */
  horas: number;
  data_emissao: string;
  data_vencimento: string | null;
  situacao: SituacaoCartao;
  /** o rótulo do certificado em vigor do mesmo treinamento, quando não é este */
  superado_por: string | null;
  conteudo: string[];
  /** modelo enviado pela tela: o PDF fiel depende do conversor */
  modelo_enviado: boolean;
  /** o ano da conclusão (data de término da turma), para agrupar */
  ano: number;
  anulado: boolean;
  substituido_por: { id: number; rotulo: string } | null;
  /** a vencer ou vencido, não superado nem anulado: pede a reciclagem */
  reciclagem: boolean;
  /** há turma aberta do treinamento (preenchido pela rota; null = não consultado) */
  turma_aberta: boolean | null;
  /** o QR do link de validação, `data:image/png;base64,…` (preenchido pela rota) */
  qr: string | null;
}

export interface CartaoEmEmissao {
  inscricao_id: number;
  turma_codigo: string;
  treinamento: string;
  norma: string;
  setor: SetorDoCartao;
  inicio: string;
  fim: string;
  periodo: string;
  carga_horaria: string;
  ano: number;
}

export interface ResumoDoTitular {
  /** emitidos e não anulados */
  emitidos: number;
  /** soma da carga dos emitidos não anulados */
  horas: number;
  validos: number;
  a_vencer: number;
  vencidos: number;
  indeterminados: number;
  /** superados pela reciclagem (fora das três contagens acima) */
  substituidos: number;
  /** o próximo a vencer entre os em vigor (não superados), ou null */
  proximo_a_vencer: { treinamento: string; norma: string; data_vencimento: string; dias: number } | null;
}

export interface CertificadosDoTitular {
  cartoes: CartaoCertificado[];
  anulados: CartaoCertificado[];
  em_emissao: CartaoEmEmissao[];
  resumo: ResumoDoTitular;
}

function _texto(v: unknown): string {
  return typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
}

function _horas(v: unknown): number {
  const n = Number.parseFloat(_texto(v));
  return Number.isFinite(n) ? n : 0;
}

/**
 * O último de cada grupo, pela ordem de emissão (data, ano, número), sem os
 * anulados: é o certificado EM VIGOR. `chave` diz o grupo — o treinamento,
 * para um titular só; participante × treinamento, no monitor de reciclagem
 * (`reciclagem.ts`), que usa a mesma regra.
 */
export function ultimos_por<T extends { situacao: string; data_emissao: string; ano: number; numero: number }, K>(
  linhas: ReadonlyArray<T>,
  chave: (linha: T) => K,
): Map<K, T> {
  const ordenadas = linhas
    .filter((l) => l.situacao !== "ANULADO")
    .sort((a, b) => a.data_emissao.localeCompare(b.data_emissao) || a.ano - b.ano || a.numero - b.numero);
  const mapa = new Map<K, T>();
  for (const l of ordenadas) mapa.set(chave(l), l);
  return mapa;
}

/**
 * O certificado EM VIGOR de cada treinamento do titular: o último emitido (não
 * anulado), pela ordem de emissão — a mesma regra do monitor de reciclagem.
 * Devolve `treinamento_id → certificado_id`.
 */
export function em_vigor(
  linhas: ReadonlyArray<{ id: number; treinamento_id: number; situacao: string; data_emissao: string; ano: number; numero: number }>,
): Map<number, number> {
  const mapa = new Map<number, number>();
  for (const [t, l] of ultimos_por(linhas, (l) => l.treinamento_id)) mapa.set(t, l.id);
  return mapa;
}

/**
 * Um cartão a partir da linha do certificado e do congelado. `unidade` é o
 * setor promotor de HOJE (sigla, cor, ícone), quando a consulta o trouxe.
 * Nenhum CPF entra no cartão.
 */
export function cartao_de(
  c: CertificadoRegistro,
  unidade: { sigla: string | null; nome: string | null; cor: string | null; icone: string | null } | null,
  vigentes: Map<number, number>,
  por_id: Map<number, CertificadoRegistro>,
  hoje: string,
): CartaoCertificado {
  const k = (c.contexto_congelado ?? {}) as Record<string, unknown>;
  const inicio = _texto(k.turma_data_inicio) || null;
  const fim = _texto(k.turma_data_fim) || null;
  const vigente_id = vigentes.get(c.treinamento_id);
  const anulado = C.anulado(c);
  const superado = !anulado && vigente_id !== undefined && vigente_id !== c.id ? por_id.get(vigente_id) ?? null : null;
  const substituto = c.substituido_por_id !== null ? por_id.get(c.substituido_por_id) ?? null : null;
  const situacao = situacao_do_cartao(c, hoje);
  return {
    id: c.id,
    rotulo: C.rotulo(c),
    chave: c.chave_validacao,
    url_validacao: _texto(k.url_validacao) || `/validar/${c.chave_validacao}`,
    treinamento_id: c.treinamento_id,
    treinamento: _texto(k.treinamento_nome),
    norma: _texto(k.treinamento_norma),
    setor: {
      nome: _texto(k.turma_unidade_promotora) || unidade?.nome || "",
      sigla: unidade?.sigla ?? "",
      cor: unidade?.cor ?? null,
      icone: unidade?.icone ?? null,
    },
    turma_codigo: _texto(k.turma_codigo),
    inicio,
    fim,
    periodo: inicio ? datas_br.periodo_curto(inicio, fim) : "",
    carga_horaria: numero_br(_texto(k.carga_horaria) || null),
    horas: _horas(k.carga_horaria),
    data_emissao: c.data_emissao,
    data_vencimento: c.data_vencimento,
    situacao,
    superado_por: superado ? C.rotulo(superado) : null,
    conteudo: Treinamento.topicos({ conteudo_programatico: _texto(k.treinamento_conteudo) || null }),
    modelo_enviado: Boolean(k.modelo_chave),
    ano: Number((fim ?? c.data_emissao).slice(0, 4)),
    anulado,
    substituido_por: substituto ? { id: substituto.id, rotulo: C.rotulo(substituto) } : null,
    reciclagem: !anulado && !superado && (situacao.tipo === "a_vencer" || situacao.tipo === "vencido"),
    turma_aberta: null,
    qr: null,
  };
}

/** Da conclusão mais recente para a mais antiga. */
export function ordenar(cartoes: CartaoCertificado[]): CartaoCertificado[] {
  return cartoes.sort((a, b) => (b.fim ?? b.data_emissao).localeCompare(a.fim ?? a.data_emissao) || b.id - a.id);
}

/** Os cartões, os anulados, os "em emissão" e o resumo do titular — duas consultas. */
export async function do_titular(tx: Executor, titular: ChaveDoTitular, hoje: string): Promise<CertificadosDoTitular> {
  const vazio: CertificadosDoTitular = {
    cartoes: [],
    anulados: [],
    em_emissao: [],
    resumo: { emitidos: 0, horas: 0, validos: 0, a_vencer: 0, vencidos: 0, indeterminados: 0, substituidos: 0, proximo_a_vencer: null },
  };
  if (titular === null) return vazio;
  // o certificado e o participante da inscrição presos ao MESMO titular
  const do_certificado =
    typeof titular === "number"
      ? eq(tabela_certificado.servidor_id, titular)
      : eq(tabela_certificado.participante_id, titular.participante_id);
  const do_participante =
    typeof titular === "number"
      ? eq(tabela_participante.servidor_id, titular)
      : eq(tabela_participante.id, titular.participante_id);

  const [linhas, aprovadas] = await Promise.all([
    tx
      .select({
        c: tabela_certificado,
        unidade_sigla: tabela_unidade.sigla,
        unidade_nome: tabela_unidade.nome_extenso,
        unidade_cor: tabela_unidade.cor_setor,
        unidade_icone: tabela_unidade.icone_setor,
      })
      .from(tabela_certificado)
      .leftJoin(tabela_inscricao, eq(tabela_inscricao.id, tabela_certificado.inscricao_id))
      .leftJoin(tabela_turma, eq(tabela_turma.id, tabela_inscricao.turma_id))
      .leftJoin(tabela_unidade, eq(tabela_unidade.id, tabela_turma.unidade_promotora_id))
      .where(do_certificado)
      .orderBy(desc(tabela_certificado.data_emissao), desc(tabela_certificado.id)),
    // inscrição APROVADA sem certificado ativo: "em emissão"
    tx
      .select({
        inscricao_id: tabela_inscricao.id,
        turma_codigo: tabela_turma.codigo,
        inicio: tabela_turma.data_inicio,
        fim: tabela_turma.data_fim,
        carga_turma: tabela_turma.carga_horaria_horas,
        carga_treinamento: tabela_treinamento.carga_horaria_horas,
        treinamento: tabela_treinamento.nome,
        norma: tabela_treinamento.norma_referencia,
        unidade_sigla: tabela_unidade.sigla,
        unidade_nome: tabela_unidade.nome_extenso,
        unidade_cor: tabela_unidade.cor_setor,
        unidade_icone: tabela_unidade.icone_setor,
      })
      .from(tabela_inscricao)
      .innerJoin(tabela_participante, eq(tabela_participante.id, tabela_inscricao.participante_id))
      .innerJoin(tabela_turma, eq(tabela_turma.id, tabela_inscricao.turma_id))
      .innerJoin(tabela_treinamento, eq(tabela_treinamento.id, tabela_turma.treinamento_id))
      .leftJoin(tabela_unidade, eq(tabela_unidade.id, tabela_turma.unidade_promotora_id))
      .leftJoin(
        tabela_certificado,
        and(eq(tabela_certificado.inscricao_id, tabela_inscricao.id), ne(tabela_certificado.situacao, "ANULADO")),
      )
      .where(
        and(
          do_participante,
          eq(tabela_inscricao.situacao, "APROVADO"),
          isNull(tabela_certificado.id),
        ),
      ),
  ]);

  const vigentes = em_vigor(linhas.map((l) => l.c));
  const por_id = new Map(linhas.map((l) => [l.c.id, l.c]));

  const cartoes: CartaoCertificado[] = [];
  const anulados: CartaoCertificado[] = [];
  for (const l of linhas) {
    const cartao = cartao_de(
      l.c,
      { sigla: l.unidade_sigla, nome: l.unidade_nome, cor: l.unidade_cor, icone: l.unidade_icone },
      vigentes,
      por_id,
      hoje,
    );
    (cartao.anulado ? anulados : cartoes).push(cartao);
  }
  ordenar(cartoes);
  ordenar(anulados);

  const resumo: ResumoDoTitular = { ...vazio.resumo };
  for (const x of cartoes) {
    resumo.emitidos += 1;
    resumo.horas += x.horas;
    // o superado pela reciclagem não é vencimento de ninguém: a pessoa tem o novo
    if (x.superado_por) resumo.substituidos += 1;
    else if (x.situacao.tipo === "valido") resumo.validos += 1;
    else if (x.situacao.tipo === "a_vencer") resumo.a_vencer += 1;
    else if (x.situacao.tipo === "vencido") resumo.vencidos += 1;
    else if (x.situacao.tipo === "indeterminado") resumo.indeterminados += 1;
    if (!x.superado_por && (x.situacao.tipo === "a_vencer" || x.situacao.tipo === "valido") && x.data_vencimento) {
      const atual = resumo.proximo_a_vencer;
      if (!atual || x.data_vencimento < atual.data_vencimento) {
        resumo.proximo_a_vencer = {
          treinamento: x.treinamento,
          norma: x.norma,
          data_vencimento: x.data_vencimento,
          dias: x.situacao.dias,
        };
      }
    }
  }
  resumo.horas = Math.round(resumo.horas * 10) / 10;

  const em_emissao: CartaoEmEmissao[] = aprovadas.map((a) => ({
    inscricao_id: a.inscricao_id,
    turma_codigo: a.turma_codigo,
    treinamento: a.treinamento,
    norma: a.norma ?? "",
    setor: { nome: a.unidade_nome ?? "", sigla: a.unidade_sigla ?? "", cor: a.unidade_cor ?? null, icone: a.unidade_icone ?? null },
    inicio: a.inicio,
    fim: a.fim,
    periodo: datas_br.periodo_curto(a.inicio, a.fim),
    carga_horaria: numero_br(a.carga_turma || a.carga_treinamento),
    ano: Number(a.fim.slice(0, 4)),
  }));
  return { cartoes, anulados, em_emissao, resumo };
}

/** Os ids dos certificados não anulados do titular (para o teste e o escopo). */
export async function ids_do_titular(tx: Executor, servidor_id: number): Promise<number[]> {
  const linhas = await tx
    .select({ id: tabela_certificado.id })
    .from(tabela_certificado)
    .where(and(eq(tabela_certificado.servidor_id, servidor_id), eq(tabela_certificado.situacao, "EMITIDO")));
  return linhas.map((l) => l.id);
}


// =====================================================================
// Filtros, contagens e grupos de "Meus certificados"
// =====================================================================
export const SITUACOES_FILTRO = ["todos", "validos", "a_vencer", "vencidos"] as const;
export type SituacaoFiltro = (typeof SITUACOES_FILTRO)[number];

export const ROTULO_SITUACAO_FILTRO: Readonly<Record<SituacaoFiltro, string>> = {
  todos: "Todos",
  validos: "Válidos",
  a_vencer: "A vencer",
  vencidos: "Vencidos",
};

/** Acima disto, o seletor de ano aparece e a lista se divide por ano. */
export const LIMITE_SEM_ANO = 6;
/** A partir disto, a busca por nome aparece. */
export const MINIMO_BUSCA = 12;

export interface FiltrosDoTitular {
  situacao: SituacaoFiltro;
  ano: number | null;
  q: string;
}

/**
 * Os filtros da URL, em lista fechada: o que não está na lista vira o padrão
 * (situação "todos", sem ano, sem busca). O ano só vale se o titular tem
 * certificado naquele ano; a busca, até 80 caracteres.
 */
export function ler_filtros(
  query: { situacao?: string; ano?: string; q?: string },
  anos_validos: readonly number[],
): FiltrosDoTitular {
  const situacao = (SITUACOES_FILTRO as readonly string[]).includes(query.situacao ?? "")
    ? (query.situacao as SituacaoFiltro)
    : "todos";
  const ano = /^\d{4}$/.test(query.ano ?? "") && anos_validos.includes(Number(query.ano)) ? Number(query.ano) : null;
  const q = (query.q ?? "").trim().slice(0, 80);
  return { situacao, ano, q };
}

/**
 * Em qual pílula o cartão entra. O superado pela reciclagem só aparece em
 * "Todos": vencido ou não, a pessoa já tem o certificado novo. "Válidos"
 * inclui o sem prazo de validade.
 */
export function categoria(c: CartaoCertificado): Exclude<SituacaoFiltro, "todos"> | null {
  if (c.anulado || c.superado_por) return null;
  if (c.situacao.tipo === "a_vencer") return "a_vencer";
  if (c.situacao.tipo === "vencido") return "vencidos";
  return "validos";
}

export function contagens(cartoes: readonly CartaoCertificado[]): Record<SituacaoFiltro, number> {
  const r: Record<SituacaoFiltro, number> = { todos: cartoes.length, validos: 0, a_vencer: 0, vencidos: 0 };
  for (const c of cartoes) {
    const k = categoria(c);
    if (k) r[k] += 1;
  }
  return r;
}

/** Os anos de conclusão que existem, do mais recente ao mais antigo. */
export function anos_de(cartoes: readonly { ano: number }[]): number[] {
  return [...new Set(cartoes.map((c) => c.ano))].sort((a, b) => b - a);
}

export interface GrupoDoAno {
  ano: number;
  cartoes: CartaoCertificado[];
  em_emissao: CartaoEmEmissao[];
}

export interface ListaFiltrada {
  filtros: FiltrosDoTitular;
  contagens: Record<SituacaoFiltro, number>;
  anos: number[];
  /** o seletor de ano aparece (mais de 6 certificados) */
  com_ano: boolean;
  /** a busca aparece (12 ou mais) */
  com_busca: boolean;
  /** a lista vem dividida por ano */
  agrupar: boolean;
  grupos: GrupoDoAno[];
  /** cartões depois do filtro (sem os "em emissão") */
  total: number;
  /** algum filtro está ativo */
  filtrado: boolean;
}

/**
 * Aplica os filtros aos cartões do titular e divide por ano. O "em emissão"
 * entra só sem filtro de situação nem busca (ele ainda não tem situação).
 */
export function filtrar(
  dados: Pick<CertificadosDoTitular, "cartoes" | "em_emissao">,
  query: { situacao?: string; ano?: string; q?: string },
): ListaFiltrada {
  const anos = anos_de([...dados.cartoes, ...dados.em_emissao]);
  const com_ano = dados.cartoes.length > LIMITE_SEM_ANO;
  const com_busca = dados.cartoes.length >= MINIMO_BUSCA;
  const lidos = ler_filtros(query, anos);
  const filtros: FiltrosDoTitular = { situacao: lidos.situacao, ano: com_ano ? lidos.ano : null, q: com_busca ? lidos.q : "" };
  const termo = chave_busca(filtros.q);
  const cartoes = dados.cartoes.filter(
    (c) =>
      (filtros.situacao === "todos" || categoria(c) === filtros.situacao) &&
      (filtros.ano === null || c.ano === filtros.ano) &&
      (!termo || chave_busca([c.treinamento, c.norma, c.setor.sigla, c.setor.nome, c.rotulo, c.turma_codigo].join(" ")).includes(termo)),
  );
  const em_emissao =
    filtros.situacao === "todos" && !termo
      ? dados.em_emissao.filter((x) => filtros.ano === null || x.ano === filtros.ano)
      : [];
  const agrupar = cartoes.length + em_emissao.length > LIMITE_SEM_ANO;
  const grupos: GrupoDoAno[] = [];
  if (agrupar) {
    for (const ano of anos) {
      const g = { ano, cartoes: cartoes.filter((c) => c.ano === ano), em_emissao: em_emissao.filter((x) => x.ano === ano) };
      if (g.cartoes.length || g.em_emissao.length) grupos.push(g);
    }
  } else if (cartoes.length || em_emissao.length) {
    grupos.push({ ano: 0, cartoes, em_emissao });
  }
  return {
    filtros,
    contagens: contagens(dados.cartoes),
    anos,
    com_ano,
    com_busca,
    agrupar,
    grupos,
    total: cartoes.length,
    filtrado: filtros.situacao !== "todos" || filtros.ano !== null || Boolean(termo),
  };
}

// =====================================================================
// Reciclagem e QR
// =====================================================================
/**
 * Dos treinamentos pedidos, os que têm turma recebendo pedido do próprio hoje
 * (`turma.aberta_a_pedido_proprio`, a mesma regra do cartaz). Uma consulta.
 */
export async function treinamentos_com_turma_aberta(tx: Executor, ids: readonly number[], hoje: string): Promise<Set<number>> {
  if (!ids.length) return new Set();
  const turmas = await tx
    .select()
    .from(tabela_turma)
    .where(and(eq(tabela_turma.situacao, "INSCRICOES_ABERTAS"), inArray(tabela_turma.treinamento_id, [...new Set(ids)])));
  return new Set(turmas.filter((t) => !aberta_a_pedido_proprio(t, hoje)).map((t) => t.treinamento_id));
}

/** Marca, nos cartões que pedem reciclagem, se há turma aberta do treinamento. */
export async function marcar_turmas_abertas(tx: Executor, cartoes: CartaoCertificado[], hoje: string): Promise<void> {
  const alvo = cartoes.filter((c) => c.reciclagem);
  const abertos = await treinamentos_com_turma_aberta(tx, alvo.map((c) => c.treinamento_id), hoje);
  for (const c of alvo) c.turma_aberta = abertos.has(c.treinamento_id);
}

/** O QR como `data:` URI (a CSP permite `img-src data:`). */
export function qr_data_uri(texto: string, escala = 4): string {
  return `data:image/png;base64,${Buffer.from(qr_png(texto, escala)).toString("base64")}`;
}

/** Põe o QR do link de validação em cada cartão. */
export function com_qr<T extends CartaoCertificado>(cartoes: T[], escala = 4): T[] {
  for (const c of cartoes) c.qr = qr_data_uri(c.url_validacao, escala);
  return cartoes;
}

/**
 * Os cartões a partir de linhas já carregadas (o acesso sem conta): sem
 * consulta de setor — o nome do setor vem do congelado.
 */
export function cartoes_de_linhas(linhas: CertificadoRegistro[], hoje: string): CartaoCertificado[] {
  const vigentes = em_vigor(linhas);
  const por_id = new Map(linhas.map((c) => [c.id, c]));
  return ordenar(linhas.map((c) => cartao_de(c, null, vigentes, por_id, hoje)));
}

/** Em vigor para o comprovante: não anulado, não superado, não vencido. */
export function para_o_comprovante(cartoes: readonly CartaoCertificado[]): CartaoCertificado[] {
  return cartoes.filter((c) => !c.anulado && !c.superado_por && c.situacao.tipo !== "vencido");
}

/**
 * O cabeçalho do comprovante: nome, lotação e campus. Sem SIAPE e sem CPF —
 * quem confere digita o nome em `/validar` e recebe só "confere".
 */
export async function identificacao_do_titular(
  tx: Executor,
  titular: number | { participante_id: number },
): Promise<{ nome: string; lotacao: string; campus: string; organizacao: string }> {
  if (typeof titular !== "number") {
    // o externo não tem lotação nem campus: tem a organização (a contratada)
    const [p] = await tx
      .select({ nome: tabela_participante.nome, organizacao: tabela_participante.organizacao })
      .from(tabela_participante)
      .where(eq(tabela_participante.id, titular.participante_id));
    return { nome: p?.nome ?? "", lotacao: "", campus: "", organizacao: p?.organizacao ?? "" };
  }
  const servidor_id = titular;
  const [l] = await tx
    .select({
      nome: tabela_servidor.nome,
      sigla: tabela_unidade.sigla,
      unidade: tabela_unidade.nome_extenso,
      campus: tabela_campus.nome,
    })
    .from(tabela_servidor)
    .leftJoin(tabela_unidade, eq(tabela_unidade.id, tabela_servidor.unidade_uorg_id))
    .leftJoin(tabela_campus, eq(tabela_campus.id, tabela_unidade.campus_id))
    .where(eq(tabela_servidor.id, servidor_id));
  const lotacao = l?.unidade ? (l.sigla && l.sigla !== l.unidade ? `${l.sigla} · ${l.unidade}` : l.unidade) : "";
  return { nome: l?.nome ?? "", lotacao, campus: l?.campus ?? "", organizacao: "" };
}
