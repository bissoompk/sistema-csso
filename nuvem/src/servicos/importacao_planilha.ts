/**
 * Fase 2 — importação da planilha de pareceres (.xlsx).
 * Porte de `app/servicos/importacao_planilha.py`.
 *
 * Princípios (§10):
 *   - staging obrigatório — as 25 colunas entram como texto puro;
 *   - idempotência por (origem_migracao, origem_ref) — a carga roda muitas vezes;
 *   - nada descartado em silêncio — o rejeitado vai para migracao_rejeitada;
 *   - preservar o literal — portaria.texto_original, cargo_snapshot, coluna V.
 *
 * **Desvio da nuvem.** O Python lia a planilha de um CAMINHO (`entrada/`), onde
 * a rota a gravava antes. A função do Netlify não tem disco: aqui a planilha
 * chega como BYTES com o nome do arquivo (`ArquivoPlanilha`), e o nome continua
 * sendo a chave do staging (`arquivo`, `origem_ref`), como era `caminho.name`.
 * A leitura é do exceljs no lugar do openpyxl (`data_only=True`: fórmula vale
 * pelo resultado gravado).
 */
import ExcelJS from "exceljs";
import { and, asc, eq } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  agente_nocivo,
  autoridade_destinataria,
  cargo as tabela_cargo,
  exposicao,
  fluxo_etapa,
  laudo_tecnico,
  migracao_rejeitada,
  parecer_posto,
  parecer_tecnico,
  percentual_aplicavel,
  portaria_localizacao,
  posto_trabalho,
  processo as tabela_processo,
  profissional_habilitado,
  servidor as tabela_servidor,
  setor_emissor,
  stg_planilha_parecer,
  tipo_adicional,
  tipo_marco_inicial,
  tipo_movimento,
  tipo_processo,
  unidade_uorg,
} from "../db/esquema/index.js";
import * as auditoria from "./auditoria.js";
import * as datas_br from "./datas_br.js";
import * as servico_nup from "./nup.js";
import * as pendencias from "./pendencias.js";
import * as textos from "./textos.js";
import type { UsuarioAtual } from "./rbac.js";

export const ORIGEM = "PLANILHA";

export const COLUNAS = [
  "col_a_data_solicitacao",
  "col_b_numero_parecer",
  "col_c_nome_servidor",
  "col_d_ano",
  "col_e_data",
  "col_f_laudo_de",
  "col_g_unidade",
  "col_h_posto_trabalho",
  "col_i_uorg",
  "col_j_tipo_laudo",
  "col_k_numero_processo",
  "col_l_matricula",
  "col_m_cargo",
  "col_n_funcao",
  "col_o_laudo_siape",
  "col_p_agente_nocivo",
  "col_q_tipo_risco",
  "col_r_percentual",
  "col_s_portaria",
  "col_t_fundamentacao",
  "col_u_alteracao",
  "col_v_recomendacao",
  "col_w_reavaliacao",
  "col_x_pro_reitor",
  "col_Y_sem_cabecalho",
] as const;
type Coluna = (typeof COLUNAS)[number];

// COMPLETA exige C, E, K, L, O, P, R, S, T, V
export const COLUNAS_COMPLETA: readonly Coluna[] = [
  "col_c_nome_servidor",
  "col_e_data",
  "col_k_numero_processo",
  "col_l_matricula",
  "col_o_laudo_siape",
  "col_p_agente_nocivo",
  "col_r_percentual",
  "col_s_portaria",
  "col_t_fundamentacao",
  "col_v_recomendacao",
];

// de-para de grafia observada na planilha (nunca normaliza caixa; corrige erro)
export const DEPARA_POSTO: Readonly<Record<string, string>> = {
  "Central de Esterelização de Materiais (CME)": "Central de Esterilização de Materiais (CME)",
};

// `\w` do Python em str é Unicode ("março"); no JS é o `[\p{L}\p{N}_]` com `u`.
export const RE_PORTARIA =
  /portaria\s*[/\s]\s*(?<emissor>[A-Za-zÀ-ÿ]+)\s*n[ºo°]?\.?\s*(?<numero>\d+)(?:\/(?:\d{4}|[A-Za-z]+))?\s*,?\s*de\s+(?<dia>\d{1,2})\s+de\s+(?<mes>[\p{L}\p{N}_]+)\s+de\s+(?<ano>\d{4})/iu;

export const RE_MARCO_PORTARIA: readonly RegExp[] = [
  /a partir da data da Portaria de Localização:?\s*(.+)/iu,
  /a partir da portaria de localização\s*(.+)/iu,
];
export const RE_MARCO_SOLICITACAO = /a partir da data da solicitação\s*(.+)/iu;

export interface PortariaAnalisada {
  emissor: string;
  numero: string;
  /** 'AAAA-MM-DD' */
  data: string;
  texto: string;
}

export function analisar_portaria(texto: string | null | undefined): PortariaAnalisada | null {
  if (!texto) return null;
  const m = RE_PORTARIA.exec(String(texto));
  if (!m) return null;
  const g = m.groups!;
  const mes = datas_br.indice_mes(g.mes!);
  if (mes === null) return null;
  let data: string;
  try {
    data = datas_br.montar(Number(g.ano), mes, Number(g.dia));
  } catch {
    return null;
  }
  return {
    emissor: g.emissor!.toUpperCase(),
    numero: g.numero!.replace(/^0+/, "") || "0",
    data,
    texto: String(texto).trim(),
  };
}

export interface MarcoExtraido {
  codigo: string;
  data: string | null;
  texto: string;
}

/** A coluna A está 100% vazia; a data do marco vive dentro da recomendação. */
export function extrair_marco(recomendacao: string | null | undefined): MarcoExtraido | null {
  if (!recomendacao) return null;
  for (const padrao of RE_MARCO_PORTARIA) {
    const m = padrao.exec(recomendacao);
    if (m) {
      const bruto = m[1]!.trim();
      return { codigo: "PORTARIA_LOCALIZACAO", data: analisar_seguro(bruto), texto: bruto };
    }
  }
  const m = RE_MARCO_SOLICITACAO.exec(recomendacao);
  if (m) {
    const bruto = m[1]!.trim();
    return { codigo: "SOLICITACAO_SEST", data: analisar_seguro(bruto), texto: bruto };
  }
  return null;
}

function analisar_seguro(texto: unknown): string | null {
  try {
    return datas_br.analisar(texto);
  } catch {
    return null;
  }
}

export interface LinhaRelatorio {
  linha: number;
  classificacao: string;
  numero: number | null;
  ano: number | null;
  acao: string;
  pendencias: string[];
  divergencias: string[];
}

export class RelatorioImportacao {
  linhas: LinhaRelatorio[] = [];
  rejeitadas: [string, string][] = [];
  constructor(readonly arquivo: string) {}

  get total(): number {
    return this.linhas.length;
  }

  contar(classificacao: string): number {
    return this.linhas.filter((l) => l.classificacao === classificacao).length;
  }
}

/** A planilha que chegou: o nome (chave do staging) e os bytes. */
export interface ArquivoPlanilha {
  nome: string;
  conteudo: Uint8Array;
}

type Registro = typeof stg_planilha_parecer.$inferSelect;

// ---------------------------------------------------------------------
/** `str(datetime)` do Python: '2026-02-11 00:00:00'. */
function str_datetime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

/** O valor da célula como o openpyxl o devolveria (`data_only=True`). */
function valor_da_celula(v: ExcelJS.CellValue): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && !(v instanceof Date)) {
    const o = v as unknown as Record<string, unknown>;
    if ("result" in o) return valor_da_celula(o.result as ExcelJS.CellValue);
    if ("formula" in o || "sharedFormula" in o) return null;
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((t) => t.text).join("");
    if ("text" in o) return valor_da_celula(o.text as ExcelJS.CellValue);
    if ("error" in o) return String(o.error);
    return null;
  }
  return v;
}

function _texto(valor: unknown): string | null {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === "string") {
    const limpo = valor.trim();
    return limpo || null;
  }
  if (valor instanceof Date) return str_datetime(valor);
  if (typeof valor === "boolean") return valor ? "True" : "False";
  return String(valor);
}

export async function carregar_staging(tx: Executor, arquivo: ArquivoPlanilha): Promise<Registro[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(arquivo.conteudo) as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  const registros: Registro[] = [];
  if (!ws) return registros;
  for (let indice = 2; indice <= ws.rowCount; indice++) {
    const linha = ws.getRow(indice);
    const valores: unknown[] = [];
    for (let c = 1; c <= 25; c++) valores.push(valor_da_celula(linha.getCell(c).value));
    if (valores.every((v) => v === null || v === "")) continue;

    const campos: Record<string, string | null> = {};
    COLUNAS.forEach((nome, i) => {
      const valor = valores[i];
      if (nome === "col_e_data") {
        const data = analisar_planilha(valor);
        campos[nome] = data ? data : _texto(valor);
      } else {
        campos[nome] = _texto(valor);
      }
    });

    const [existente] = await tx
      .select()
      .from(stg_planilha_parecer)
      .where(and(eq(stg_planilha_parecer.arquivo, arquivo.nome), eq(stg_planilha_parecer.linha_origem, indice)));
    let registro: Registro;
    if (existente) {
      [registro] = (await tx
        .update(stg_planilha_parecer)
        .set(campos)
        .where(eq(stg_planilha_parecer.id, existente.id))
        .returning()) as [Registro];
    } else {
      [registro] = (await tx
        .insert(stg_planilha_parecer)
        .values({ arquivo: arquivo.nome, linha_origem: indice, ...campos })
        .returning()) as [Registro];
    }
    registros.push(registro);
  }
  return registros;
}

function analisar_planilha(valor: unknown): string | null {
  try {
    return datas_br.data_de_planilha(valor);
  } catch {
    return null;
  }
}

export function classificar(registro: Record<Coluna, string | null>): string {
  const preenchidas = COLUNAS.filter((nome) => nome !== "col_b_numero_parecer" && registro[nome]).length;
  const tem_numero = Boolean(registro.col_b_numero_parecer);
  if (tem_numero && preenchidas <= COLUNAS.length - 1 - 8) {
    // número preenchido e >= 8 das 24 demais colunas vazias
    if (preenchidas <= 2) return "RESERVA";
  }
  if (COLUNAS_COMPLETA.every((nome) => registro[nome])) return "COMPLETA";
  if (tem_numero && preenchidas <= 2) return "RESERVA";
  return "PARCIAL";
}

// ---------------------------------------------------------------------
// Resolução de entidades
// ---------------------------------------------------------------------
type Unidade = typeof unidade_uorg.$inferSelect;
type Posto = typeof posto_trabalho.$inferSelect;
type Cargo = typeof tabela_cargo.$inferSelect;
type Servidor = typeof tabela_servidor.$inferSelect;
type Agente = typeof agente_nocivo.$inferSelect;
type Portaria = typeof portaria_localizacao.$inferSelect;
type Laudo = typeof laudo_tecnico.$inferSelect;
type Processo = typeof tabela_processo.$inferSelect;
type Parecer = typeof parecer_tecnico.$inferSelect;

export async function resolver_unidade(
  tx: Executor,
  uorg_bruto: string | null,
  nome_extenso: string | null,
): Promise<Unidade | null> {
  const codigo = textos.codigo_uorg(uorg_bruto);
  if (codigo) {
    const [unidade] = await tx.select().from(unidade_uorg).where(eq(unidade_uorg.codigo_uorg, codigo));
    if (unidade) return unidade;
  }
  if (nome_extenso) {
    const alvo = textos.chave_busca(nome_extenso);
    for (const unidade of await tx.select().from(unidade_uorg).orderBy(asc(unidade_uorg.id))) {
      if (textos.chave_busca(unidade.nome_extenso) === alvo) return unidade;
    }
  }
  return null;
}

export async function resolver_postos(tx: Executor, unidade: Unidade | null, bruto: string | null): Promise<Posto[]> {
  if (!bruto || unidade === null) return [];
  const partes = String(bruto)
    .split(/[\n/]/)
    .map((p) => p.trim())
    .filter(Boolean);
  const encontrados: Posto[] = [];
  for (const parte of partes) {
    const nome = DEPARA_POSTO[parte] ?? parte;
    let [posto] = await tx
      .select()
      .from(posto_trabalho)
      .where(and(eq(posto_trabalho.unidade_uorg_id, unidade.id), eq(posto_trabalho.nome, nome)));
    if (!posto) {
      const alvo = textos.chave_busca(nome);
      for (const candidato of await tx
        .select()
        .from(posto_trabalho)
        .where(eq(posto_trabalho.unidade_uorg_id, unidade.id))
        .orderBy(asc(posto_trabalho.id))) {
        if (textos.chave_busca(candidato.nome) === alvo) {
          posto = candidato;
          break;
        }
      }
    }
    if (!posto) {
      [posto] = await tx.insert(posto_trabalho).values({ unidade_uorg_id: unidade.id, nome }).returning();
    }
    encontrados.push(posto!);
  }
  return encontrados;
}

/** Chave = SIAPE, nunca o nome. */
export async function resolver_servidor(
  tx: Executor,
  siape: string | null,
  nome: string | null,
  cargo: Cargo | null,
  unidade: Unidade | null,
): Promise<Servidor | null> {
  if (!siape) return null;
  // `re.sub(r"\D", "", siape).zfill(7)[-7:]`
  const limpo = String(siape).replace(/\D/g, "").padStart(7, "0").slice(-7);
  if (!/^\d{7}$/.test(limpo)) return null;
  const [existente] = await tx.select().from(tabela_servidor).where(eq(tabela_servidor.siape, limpo));
  if (existente) return existente;
  const [novo] = await tx
    .insert(tabela_servidor)
    .values({
      siape: limpo,
      nome: (nome || `SERVIDOR ${limpo}`).trim(),
      cargo_id: cargo ? cargo.id : null,
      unidade_uorg_id: unidade ? unidade.id : null,
    })
    .returning();
  return novo!;
}

export async function resolver_cargo(tx: Executor, nome: string | null): Promise<Cargo | null> {
  if (!nome) return null;
  const [cargo] = await tx.select().from(tabela_cargo).where(eq(tabela_cargo.nome, nome.trim()));
  if (cargo) return cargo;
  const [novo] = await tx.insert(tabela_cargo).values({ nome: nome.trim() }).returning();
  return novo!;
}

export async function resolver_agente(tx: Executor, descricao: string | null): Promise<Agente | null> {
  if (!descricao) return null;
  let [agente] = await tx.select().from(agente_nocivo).where(eq(agente_nocivo.descricao, descricao.trim()));
  if (!agente) {
    const alvo = textos.chave_busca(descricao);
    for (const candidato of await tx.select().from(agente_nocivo).orderBy(asc(agente_nocivo.id))) {
      if (textos.chave_busca(candidato.descricao) === alvo) {
        agente = candidato;
        break;
      }
    }
  }
  // de-para de sinônimo -> canônico (único que altera semântica)
  if (agente && agente.agente_canonico_id) {
    const [canonico] = await tx.select().from(agente_nocivo).where(eq(agente_nocivo.id, agente.agente_canonico_id));
    return canonico ?? null;
  }
  return agente ?? null;
}

export async function resolver_portaria(
  tx: Executor,
  texto: string | null,
  unidade_padrao: Unidade | null,
): Promise<[Portaria | null, PortariaAnalisada | null]> {
  const analise = analisar_portaria(texto);
  if (analise === null) return [null, analise];
  let [emissor] = await tx.select().from(unidade_uorg).where(eq(unidade_uorg.sigla, analise.emissor));
  if (!emissor) {
    const alvo = textos.chave_busca(analise.emissor);
    for (const candidato of await tx.select().from(unidade_uorg).orderBy(asc(unidade_uorg.id))) {
      if (candidato.sigla && textos.chave_busca(candidato.sigla) === alvo) {
        emissor = candidato;
        break;
      }
    }
  }
  const unidade = emissor ?? unidade_padrao;
  if (!unidade) return [null, analise];

  const ano = Number(analise.data.slice(0, 4));
  const [existente] = await tx
    .select()
    .from(portaria_localizacao)
    .where(
      and(
        eq(portaria_localizacao.unidade_emissora_id, unidade.id),
        eq(portaria_localizacao.numero, analise.numero),
        eq(portaria_localizacao.ano, ano),
      ),
    );
  if (existente) return [existente, analise];
  const [nova] = await tx
    .insert(portaria_localizacao)
    .values({
      unidade_emissora_id: unidade.id,
      numero: analise.numero,
      ano,
      data_publicacao: analise.data,
      texto_original: analise.texto,
    })
    .returning();
  return [nova!, analise];
}

export async function resolver_laudo(
  tx: Executor,
  numero: string | null,
  unidade: Unidade,
  tipo: { id: number },
): Promise<Laudo | null> {
  if (!numero) return null;
  const limpo = numero.trim();
  if (!/^\d{5}-\d{3}\.\d{3}\/\d{4}$/.test(limpo)) return null;
  const [existente] = await tx.select().from(laudo_tecnico).where(eq(laudo_tecnico.numero_siape, limpo));
  if (existente) return existente;
  const [novo] = await tx
    .insert(laudo_tecnico)
    .values({ numero_siape: limpo, ano: Number(limpo.slice(-4)), tipo_adicional_id: tipo.id, unidade_uorg_id: unidade.id })
    .returning();
  return novo!;
}

export async function resolver_processo(
  tx: Executor,
  bruto: string | null,
  servidor: Servidor | null,
  unidade: Unidade | null,
  tipo: { id: number },
  etapa: { id: number },
): Promise<[Processo | null, servico_nup.ResultadoNup | null]> {
  if (!bruto) return [null, null];
  const resultado = servico_nup.validar(bruto);
  if (!resultado.formato_ok) return [null, resultado];
  const [existente] = await tx.select().from(tabela_processo).where(eq(tabela_processo.nup, resultado.valor));
  if (existente) return [existente, resultado];
  const [novo] = await tx
    .insert(tabela_processo)
    .values({
      nup: resultado.valor,
      tipo_processo_id: tipo.id,
      etapa_id: etapa.id,
      estado_tecnico: "CONCLUIDO",
      situacao: "CONCLUIDO",
      data_conclusao: datas_br.hoje(),
      servidor_id: servidor ? servidor.id : null,
      unidade_uorg_id: unidade ? unidade.id : null,
      nup_dv_dispensado: !resultado.dv_ok,
      origem_migracao: ORIGEM,
      origem_ref: `nup:${resultado.valor}`,
    })
    .returning();
  return [novo!, resultado];
}

// ---------------------------------------------------------------------
export async function importar(
  tx: Executor,
  arquivo: ArquivoPlanilha,
  usuario: UsuarioAtual,
  aplicar = true,
): Promise<RelatorioImportacao> {
  const relatorio = new RelatorioImportacao(arquivo.nome);
  const registros = await carregar_staging(tx, arquivo);

  const [tipo] = await tx.select().from(tipo_processo).where(eq(tipo_processo.codigo, "ADICIONAL_OCUPACIONAL"));
  const [etapa_concluido] = await tx.select().from(fluxo_etapa).where(eq(fluxo_etapa.codigo, "CONCLUIDO"));
  const [insalubridade] = await tx.select().from(tipo_adicional).where(eq(tipo_adicional.codigo, "INSALUBRIDADE"));
  if (!tipo || !etapa_concluido || !insalubridade) throw new Error("catálogo básico ausente: rode as sementes");

  let ano_vizinho: number | null = null;
  for (const registro of registros) {
    const classificacao = classificar(registro);
    await tx
      .update(stg_planilha_parecer)
      .set({ classificacao })
      .where(eq(stg_planilha_parecer.id, registro.id));
    registro.classificacao = classificacao;
    const numero = _numero(registro.col_b_numero_parecer);
    let ano = _numero(registro.col_d_ano);
    let ano_inferido = false;
    if (ano === null && numero !== null) {
      ano = ano_vizinho;
      ano_inferido = ano !== null;
    }
    if (ano) ano_vizinho = ano;

    const linha: LinhaRelatorio = {
      linha: registro.linha_origem,
      classificacao,
      numero,
      ano,
      acao: "ignorada",
      pendencias: [],
      divergencias: [],
    };

    if (numero === null || ano === null) {
      const payload: Record<string, string | null> = {};
      for (const c of COLUNAS) payload[c] = registro[c];
      await _rejeitar(tx, relatorio, {
        ref: `${arquivo.nome}:${registro.linha_origem}`,
        motivo: "linha sem número de parecer ou sem ano identificável",
        payload,
      });
      linha.acao = "rejeitada";
      relatorio.linhas.push(linha);
      continue;
    }

    if (!aplicar) {
      linha.acao = "simulada";
      relatorio.linhas.push(linha);
      continue;
    }

    const parecer = await _obter_parecer(tx, numero, ano, arquivo, registro, usuario);
    parecer.ano_inferido = ano_inferido;
    await tx.update(parecer_tecnico).set({ ano_inferido }).where(eq(parecer_tecnico.id, parecer.id));
    if (ano_inferido) {
      await auditoria.registrar(tx, {
        entidade: "parecer_tecnico",
        entidade_id: parecer.id,
        tipo_evento: auditoria.ANO_INFERIDO,
        descricao: `Linha ${registro.linha_origem}: ano ausente, herdado da linha vizinha não vazia (${ano}).`,
        usuario,
        origem: "MIGRACAO_PLANILHA",
        origem_ref: `${arquivo.nome}:${registro.linha_origem}`,
      });
    }

    if (classificacao === "RESERVA") {
      await tx.update(parecer_tecnico).set({ situacao: "RESERVADO" }).where(eq(parecer_tecnico.id, parecer.id));
      linha.acao = "reservado";
      relatorio.linhas.push(linha);
      continue;
    }

    await _preencher(tx, parecer, registro, linha, { tipo, etapa: etapa_concluido, insalubridade, usuario });
    const situacao = classificacao === "COMPLETA" && !linha.pendencias.length ? "EMITIDO" : "RASCUNHO";
    await tx.update(parecer_tecnico).set({ situacao }).where(eq(parecer_tecnico.id, parecer.id));
    linha.acao = situacao === "EMITIDO" ? "emitido" : "rascunho";
    relatorio.linhas.push(linha);
  }
  return relatorio;
}

function _numero(valor: string | null): number | null {
  if (valor === null || valor === undefined) return null;
  const limpo = String(valor).replace(/\D/g, "");
  return limpo ? Number(limpo) : null;
}

/**
 * O parecer da linha: o mesmo de sempre por `origem_ref`, ou o que já ocupa o
 * número.
 *
 * **O reencontro por (numero, ano) é deliberado e continua.** A planilha é
 * editada entre uma carga e outra e a linha 40 vira 41; sem ele, a segunda
 * carga criaria um segundo 12/2025.
 *
 * O que ele NÃO pode ser é silencioso quando o ocupante **não veio da
 * migração**: aí o número foi consumido dentro do sistema, e a carga estaria
 * reescrevendo um parecer vivo — o `CONFLITO_NUMERACAO`.
 */
async function _obter_parecer(
  tx: Executor,
  numero: number,
  ano: number,
  arquivo: ArquivoPlanilha,
  registro: Registro,
  usuario: UsuarioAtual | null,
): Promise<Parecer> {
  const ref = `${arquivo.nome}:${registro.linha_origem}`;
  let [parecer] = await tx
    .select()
    .from(parecer_tecnico)
    .where(and(eq(parecer_tecnico.origem_migracao, ORIGEM), eq(parecer_tecnico.origem_ref, ref)));
  if (!parecer) {
    [parecer] = await tx
      .select()
      .from(parecer_tecnico)
      .where(and(eq(parecer_tecnico.numero, numero), eq(parecer_tecnico.ano, ano)));
    if (parecer && parecer.origem_migracao === null) await _conflito_de_numeracao(tx, parecer, ref, usuario);
  }
  const novos = { numero, ano, origem_migracao: ORIGEM, origem_ref: ref };
  if (!parecer) {
    [parecer] = await tx
      .insert(parecer_tecnico)
      .values({ ...novos, situacao: "RASCUNHO" })
      .returning();
  } else {
    [parecer] = await tx.update(parecer_tecnico).set(novos).where(eq(parecer_tecnico.id, parecer.id)).returning();
  }
  return parecer!;
}

/**
 * Tarefa com dono e prazo para o número que a carga encontrou ocupado. Não
 * recusa a linha: a decisão de qual dos dois documentos fica com `N/AAAA` é de
 * quem responde pela numeração, com os dois na mão.
 */
async function _conflito_de_numeracao(tx: Executor, parecer: Parecer, ref: string, usuario: UsuarioAtual | null) {
  await pendencias.abrir(tx, {
    tipo: "CONFLITO_NUMERACAO",
    chave: `conflito-numeracao:parecer:${parecer.id}`,
    descricao:
      `O número ${parecer.numero}/${parecer.ano} já era de um parecer criado ` +
      `no sistema (situação ${parecer.situacao}) e a carga da planilha ` +
      `(${ref}) escreveu por cima dele. Confira qual dos dois documentos ` +
      "fica com este número e renumere o outro.",
    usuario,
    parecer_id: parecer.id,
    processo_id: parecer.processo_id,
  });
  await auditoria.registrar(tx, {
    entidade: "parecer_tecnico",
    entidade_id: parecer.id,
    processo_id: parecer.processo_id,
    tipo_evento: "CONFLITO_NUMERACAO",
    descricao:
      `Carga da planilha (${ref}) assumiu o número ${parecer.numero}/` +
      `${parecer.ano}, que já pertencia a um parecer do sistema.`,
    usuario,
    origem: "MIGRACAO_PLANILHA",
    origem_ref: ref,
  });
}

async function _preencher(
  tx: Executor,
  parecer: Parecer,
  registro: Registro,
  linha: LinhaRelatorio,
  d: { tipo: { id: number }; etapa: { id: number }; insalubridade: { id: number }; usuario: UsuarioAtual },
): Promise<void> {
  const unidade = await resolver_unidade(tx, registro.col_i_uorg, registro.col_g_unidade);
  if (unidade === null) linha.pendencias.push("UORG não reconhecida");
  const cargo = await resolver_cargo(tx, registro.col_m_cargo);
  const servidor = await resolver_servidor(tx, registro.col_l_matricula, registro.col_c_nome_servidor, cargo, unidade);
  if (servidor === null) linha.pendencias.push("matrícula SIAPE ausente");

  const [processo, resultado_nup] = await resolver_processo(
    tx,
    registro.col_k_numero_processo,
    servidor,
    unidade,
    d.tipo,
    d.etapa,
  );
  if (processo === null) linha.pendencias.push("sem número de processo (NUP)");
  else if (resultado_nup && !resultado_nup.dv_ok) linha.divergencias.push(`NUP com DV inválido: ${resultado_nup.valor}`);

  const laudo = unidade ? await resolver_laudo(tx, registro.col_o_laudo_siape, unidade, d.insalubridade) : null;
  if (laudo === null) linha.pendencias.push("laudo técnico ausente");

  const [portaria, analise] = await resolver_portaria(tx, registro.col_s_portaria, unidade);
  if (portaria === null) linha.pendencias.push("portaria de localização ausente");

  let movimento: { id: number } | null = null;
  if (registro.col_f_laudo_de) {
    const alvo = textos.chave_busca(registro.col_f_laudo_de);
    for (const candidato of await tx.select().from(tipo_movimento).orderBy(asc(tipo_movimento.id))) {
      if (textos.chave_busca(candidato.nome) === alvo) {
        movimento = candidato;
        break;
      }
    }
  }

  const p: Partial<Parecer> = {
    processo_id: processo ? processo.id : null,
    servidor_id: servidor ? servidor.id : null,
    unidade_uorg_id: unidade ? unidade.id : null,
    laudo_id: laudo ? laudo.id : null,
    portaria_id: portaria ? portaria.id : null,
    tipo_adicional_id: d.insalubridade.id,
    tipo_movimento_id: movimento ? movimento.id : null,
    cargo_snapshot: registro.col_m_cargo,
    funcao_snapshot: registro.col_n_funcao,
    data_emissao: analisar_seguro(registro.col_e_data),
  };
  if (p.data_emissao && Number(p.data_emissao.slice(0, 4)) !== parecer.ano) {
    linha.divergencias.push(`data ${p.data_emissao} não bate com o ano ${parecer.ano}`);
    p.data_emissao = null;
  }

  p.texto_alteracao = registro.col_u_alteracao;
  p.texto_reavaliacao = registro.col_w_reavaliacao;
  p.texto_recomendacao = registro.col_v_recomendacao;
  p.texto_recomendacao_literal = Boolean(registro.col_v_recomendacao);
  p.modelo_arquivo = "modelo_parecer_v1.docx";

  let destinatario: { id: number } | undefined;
  if (registro.col_x_pro_reitor) {
    [destinatario] = await tx
      .select()
      .from(autoridade_destinataria)
      .where(eq(autoridade_destinataria.nome, registro.col_x_pro_reitor.trim()));
  }
  if (!destinatario) {
    [destinatario] = await tx.select().from(autoridade_destinataria).orderBy(asc(autoridade_destinataria.id)).limit(1);
  }
  p.destinatario_id = destinatario ? destinatario.id : null;

  const [signatario] = await tx
    .select()
    .from(profissional_habilitado)
    .orderBy(asc(profissional_habilitado.id))
    .limit(1);
  p.signatario_id = signatario ? signatario.id : null;

  if (p.data_emissao) {
    let setor: typeof setor_emissor.$inferSelect | null = null;
    for (const candidato of await tx.select().from(setor_emissor).orderBy(asc(setor_emissor.id))) {
      if (
        candidato.vigencia_inicio <= p.data_emissao &&
        (candidato.vigencia_fim === null || candidato.vigencia_fim >= p.data_emissao)
      ) {
        setor = candidato;
      }
    }
    if (setor) {
      p.setor_emissor_id = setor.id;
      p.sigla_emissora_snapshot = setor.sigla_composta;
      p.nome_emissor_snapshot = setor.nome_extenso;
      p.endereco_emissor_snapshot = setor.endereco;
      p.telefone_emissor_snapshot = setor.telefone;
    }
  }

  await tx.update(parecer_tecnico).set(p).where(eq(parecer_tecnico.id, parecer.id));
  Object.assign(parecer, p);

  // postos
  const postos = await resolver_postos(tx, unidade, registro.col_h_posto_trabalho);
  await tx.delete(parecer_posto).where(eq(parecer_posto.parecer_id, parecer.id));
  let ordem = 1;
  for (const posto of postos) {
    await tx.insert(parecer_posto).values({ parecer_id: parecer.id, posto_trabalho_id: posto.id, ordem: ordem++ });
  }
  if (!postos.length) linha.pendencias.push("posto de trabalho ausente");

  // exposição
  const agente = await resolver_agente(tx, registro.col_p_agente_nocivo);
  let percentual: { id: number } | null = null;
  if (registro.col_r_percentual) {
    const alvo = textos.chave_busca(registro.col_r_percentual);
    for (const candidato of await tx
      .select()
      .from(percentual_aplicavel)
      .where(eq(percentual_aplicavel.tipo_adicional_id, d.insalubridade.id))
      .orderBy(asc(percentual_aplicavel.id))) {
      if (textos.chave_busca(candidato.rotulo) === alvo) {
        percentual = candidato;
        break;
      }
    }
  }
  if (percentual === null) linha.pendencias.push("Percentual aplicável ausente");
  if (agente === null) linha.pendencias.push("agente nocivo não reconhecido");

  if (agente !== null && percentual !== null && agente.fundamentacao_id) {
    const [ja] = await tx
      .select({ id: exposicao.id })
      .from(exposicao)
      .where(and(eq(exposicao.parecer_id, parecer.id), eq(exposicao.agente_nocivo_id, agente.id)));
    if (!ja) {
      await tx.insert(exposicao).values({
        parecer_id: parecer.id,
        agente_nocivo_id: agente.id,
        percentual_id: percentual.id,
        fundamentacao_id: agente.fundamentacao_id,
        principal: true,
      });
    }
    // RN-06: o parecer migrado já saiu, mas a avaliação quantitativa continua
    // devida — a migração é justamente onde essa dívida aparece.
    if (agente.exige_reavaliacao_quantitativa) {
      await pendencias.abrir(tx, {
        tipo: "AVALIACAO_QUANTITATIVA",
        chave: `quantitativa:migrado:parecer:${parecer.id}`,
        descricao:
          `Parecer ${parecer.numero}/${parecer.ano} (migrado): avaliar ` +
          `quantitativamente '${agente.descricao}' e elaborar novo laudo.`,
        usuario: d.usuario,
        processo_id: processo ? processo.id : null,
        parecer_id: parecer.id,
      });
    }
  }

  // marco embutido na recomendação (coluna A está 100% vazia)
  const marco = extrair_marco(registro.col_v_recomendacao);
  if (marco !== null) {
    const [tipo_marco] = await tx.select().from(tipo_marco_inicial).where(eq(tipo_marco_inicial.codigo, marco.codigo));
    const m = { tipo_marco_id: tipo_marco ? tipo_marco.id : null, data_marco_inicial: marco.data };
    await tx.update(parecer_tecnico).set(m).where(eq(parecer_tecnico.id, parecer.id));
    Object.assign(parecer, m);
    if (marco.codigo === "SOLICITACAO_SEST" && processo !== null && marco.data) {
      await tx
        .update(tabela_processo)
        .set({ data_solicitacao_sest: marco.data })
        .where(eq(tabela_processo.id, processo.id));
    }
    if (marco.codigo === "PORTARIA_LOCALIZACAO" && analise !== null && marco.data && marco.data !== analise.data) {
      linha.divergencias.push(`marco ${marco.data} diverge da portaria ${analise.data}`);
    }
  } else {
    linha.pendencias.push("marco inicial não identificado na recomendação");
  }
}

async function _rejeitar(
  tx: Executor,
  relatorio: RelatorioImportacao,
  d: { ref: string; motivo: string; payload: Record<string, unknown> },
): Promise<void> {
  const [ja] = await tx
    .select({ id: migracao_rejeitada.id })
    .from(migracao_rejeitada)
    .where(and(eq(migracao_rejeitada.origem, ORIGEM), eq(migracao_rejeitada.ref, d.ref)));
  if (!ja) {
    await tx.insert(migracao_rejeitada).values({
      origem: ORIGEM,
      ref: d.ref,
      motivo: d.motivo,
      payload: d.payload,
      // RN-23: payload expurgado 90 dias após o encerramento da migração
      expurgar_apos: datas_br.somar_dias(datas_br.hoje(), 90),
    });
  }
  relatorio.rejeitadas.push([d.ref, d.motivo]);
}
