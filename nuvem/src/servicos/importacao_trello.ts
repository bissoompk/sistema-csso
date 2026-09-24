/**
 * Fase 3 — importação do quadro do Trello a partir do JSON completo.
 * Porte de `app/servicos/importacao_trello.py`.
 *
 * Usa o JSON do quadro (`/b/<id>.json`), não o CSV: só ele traz o feed
 * `actions`. Lista não mapeada vira `migracao_rejeitada` — nunca chute.
 *
 * **Desvio da nuvem.** O Python lia o JSON de um caminho em `entrada/`; aqui
 * `importar` recebe o quadro JÁ LIDO (o objeto), porque a função do Netlify
 * não tem disco. E anexo acima do teto de 4 MB do armazenamento
 * (`anexos.LIMITE_BYTES`) não derruba a carga: entra no relatório de perdidos
 * e em `migracao_rejeitada`, como o anexo que não baixou.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  checklist,
  checklist_item,
  fluxo_etapa,
  historico_evento,
  migracao_rejeitada,
  processo as tabela_processo,
  servidor as tabela_servidor,
  stg_trello_acao,
  stg_trello_cartao,
  tipo_processo,
} from "../db/esquema/index.js";
import * as anexos from "./anexos.js";
import * as auditoria from "./auditoria.js";
import * as datas_br from "./datas_br.js";
import { nup_dv } from "./nup.js";
import * as servico_nup from "./nup.js";
import * as textos from "./textos.js";
import type { UsuarioAtual } from "./rbac.js";

export const ORIGEM = "TRELLO";
export const MOTIVO_NAO_PROCESSO = "CARTAO_NAO_PROCESSO";

type Json = Record<string, any>;

export interface RegraLista {
  etapa?: string;
  estado?: string;
  tipo?: string;
  repositorio?: boolean;
  separar_backlog?: boolean;
  campi?: readonly string[];
  situacao?: string;
  ignorar?: boolean;
  ano_referencia?: number;
}

// De-para de listas, explícito e semeado. Lista fora daqui = rejeitada, nunca
// chutada. Conferido contra o quadro real "SEI" (23 listas, 727 cartões) em
// 11/08/2026.
export const DEPARA_LISTAS: Readonly<Record<string, RegraLista>> = {
  "não iniciado": { etapa: "NAO_INICIADO", estado: "NAO_INICIADO" },
  "a fazer": { etapa: "A_FAZER", estado: "EM_TRIAGEM" },
  "em andamento": { etapa: "EM_ANDAMENTO", estado: "AGUARDANDO_INSPECAO" },
  aguardando: { etapa: "AGUARDANDO", estado: "PENDENTE_DOCUMENTO" },
  // filas de entrada do quadro (todos os tipos, não só adicional)
  entrada: { etapa: "A_FAZER", estado: "RECEBIDO" },
  processos: { etapa: "A_FAZER", estado: "RECEBIDO" },
  delegar: { etapa: "A_FAZER", estado: "RECEBIDO" },
  "adicional ocupacional": {
    etapa: "BACKLOG_ADICIONAL",
    estado: "RECEBIDO",
    tipo: "ADICIONAL_OCUPACIONAL",
    repositorio: true,
    separar_backlog: true,
  },
  "adicional ocupacional - campus avançados": {
    etapa: "BACKLOG_CAMPI_AVANCADOS",
    estado: "RECEBIDO",
    tipo: "ADICIONAL_OCUPACIONAL",
    repositorio: true,
    campi: ["JAN", "UNA"],
  },
  "adicional ocupacional - digitalizados": {
    etapa: "BACKLOG_ADICIONAL",
    estado: "RECEBIDO",
    tipo: "ADICIONAL_OCUPACIONAL",
    repositorio: true,
    separar_backlog: true,
  },
  "aposentadoria especial = concluídos": {
    etapa: "ARQUIVO_APOSENTADORIA",
    estado: "CONCLUIDO",
    tipo: "APOSENTADORIA_ESPECIAL",
    repositorio: true,
    situacao: "CONCLUIDO",
  },
  comissões: { etapa: "A_FAZER", estado: "RECEBIDO", tipo: "CONSULTA_NORMATIVA" },
  // Painéis e listas de anotação NÃO são etapa e NÃO viram processo.
  "painel geral": { ignorar: true },
  "painel de controle": { ignorar: true },
  "processos geral - informação": { ignorar: true },
};

export const MOTIVO_LISTA_IGNORADA = "LISTA_DE_ANOTACAO";

// Aceita "Concluído 2025", "Concluído - 2021" e "Processos Concluidos - 2022".
export const RE_CONCLUIDO_ANO = /^(?:processos\s+)?conclu[íi]d[oa]s?\s*[-–]?\s*(?<ano>\d{4})$/iu;
// Cuidado com a âncora: a busca é por palavra inteira em qualquer posição
// ('ADICIONAL DE INSALUBRIDADE ANTIGO' não pode passar como processo). O `\b`
// do Python em str é Unicode; aqui, lookarounds de letra/número.
const F = "(?<![\\p{L}\\p{N}_])";
const T = "(?![\\p{L}\\p{N}_])";
export const RE_NAO_PROCESSO = new RegExp(
  `(?:^\\s*(?:1-)?modelo${T})|${F}modelos?${T}|${F}antigos?${T}|${F}desativad[oa]s?${T}`,
  "iu",
);
export const RE_PARECER_TITULO = /(?<numero>\d{1,3})\s*[-/]\s*(?<ano>\d{4})$/u;
// Duas grafias reais no quadro: 'Parecer (1234567).pdf' e 'SEI_1486577_Oficio.pdf'
export const RE_DOC_SEI_ANEXO = new RegExp(`\\((?<doc_sei>\\d{7})\\)|${F}SEI[_ -](?<doc_sei2>\\d{7})(?!\\d)`, "iu");
export const RE_PARECER_ANEXO = /Parecer[ _]T[eé]cnico[ _](\d{2})[-/](\d{4})/iu;
export const RE_LAUDO_ANEXO = /(26255)-?(000)\.?(\d{3})\.?\/?(\d{4})/u;

export class RelatorioTrello {
  cartoes = 0;
  processos = 0;
  eventos = 0;
  anexos = 0;
  anexos_duplicados = 0;
  anexos_perdidos: [string, string][] = [];
  rejeitados: [string, string][] = [];
  listas_desconhecidas = new Set<string>();
  conflitos_numeracao: Record<string, unknown>[] = [];
  orfaos_processo: string[] = [];
  laudos_candidatos: Record<string, unknown>[] = [];
  backlog_historico = 0;
  backlog_pendente = 0;
  motivos_pendente: Record<string, unknown>[] = [];
}

export type BuscarAnexo = (url: string) => Promise<Uint8Array>;

/**
 * Busca o anexo no Trello. As URLs expiram — baixe tudo antes do corte.
 *
 * Anexo do Trello exige autenticação: sem `CSSO_TRELLO_KEY`/`CSSO_TRELLO_TOKEN`
 * isto devolve 401 e o anexo entra no relatório de perdidos.
 */
export async function baixar_url(url: string, tempo_limite = 60): Promise<Uint8Array> {
  const chave = process.env.CSSO_TRELLO_KEY ?? "";
  const token = process.env.CSSO_TRELLO_TOKEN ?? "";
  const cabecalhos: Record<string, string> = { "User-Agent": "CSSO/1.0" };
  if (chave && token) cabecalhos.Authorization = `OAuth oauth_consumer_key="${chave}", oauth_token="${token}"`;
  const resposta = await fetch(url, { headers: cabecalhos, signal: AbortSignal.timeout(tempo_limite * 1000) });
  if (!resposta.ok) throw new Error(`HTTP Error ${resposta.status}: ${resposta.statusText}`);
  return new Uint8Array(await resposta.arrayBuffer());
}

export const ARQUIVO_INDICE_ANEXOS = "_indice.json";

function listar_arquivos(pasta: string): string[] {
  const saida: string[] = [];
  for (const nome of readdirSync(pasta).sort()) {
    const caminho = path.join(pasta, nome);
    if (statSync(caminho).isDirectory()) saida.push(...listar_arquivos(caminho));
    else saida.push(caminho);
  }
  return saida;
}

/**
 * Fábrica de um `buscar_anexo` que lê os bytes de uma pasta local (a linha de
 * comando; a função do Netlify não tem pasta). Usa o índice url -> arquivo
 * escrito pela ferramenta de download; sem índice, cai para a busca por nome.
 */
export function buscar_em_pasta(pasta: string): BuscarAnexo {
  const por_url = new Map<string, string>();
  const indice = path.join(pasta, ARQUIVO_INDICE_ANEXOS);
  if (existsSync(indice)) {
    for (const [url, nome] of Object.entries(JSON.parse(readFileSync(indice, "utf8")) as Record<string, string>)) {
      por_url.set(url, path.join(pasta, nome));
    }
  }
  const por_nome = new Map<string, string>();
  if (existsSync(pasta)) {
    for (const arquivo of listar_arquivos(pasta)) {
      const nome = path.basename(arquivo);
      if (nome === ARQUIVO_INDICE_ANEXOS) continue;
      if (!por_nome.has(nome)) por_nome.set(nome, arquivo);
      const chave = textos.chave_busca(nome);
      if (!por_nome.has(chave)) por_nome.set(chave, arquivo);
    }
  }
  return async (url: string) => {
    let alvo = por_url.get(url);
    if (alvo === undefined) {
      const nome = urllib_parse_nome(url);
      alvo = por_nome.get(nome) ?? por_nome.get(textos.chave_busca(nome));
    }
    if (alvo === undefined || !existsSync(alvo)) {
      const erro = new Error(`anexo não encontrado em ${pasta}: ${url}`);
      erro.name = "FileNotFoundError";
      throw erro;
    }
    return new Uint8Array(readFileSync(alvo));
  };
}

export function urllib_parse_nome(url: string): string {
  let caminho = url;
  try {
    caminho = new URL(url).pathname;
  } catch {
    caminho = url.split(/[?#]/)[0] ?? url;
  }
  const ultimo = caminho.split("/").pop() ?? "";
  try {
    return decodeURIComponent(ultimo);
  } catch {
    return ultimo;
  }
}

// O `mimetypes.guess_type` do Python, para as extensões que o quadro tem.
const MIME: Readonly<Record<string, string>> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".html": "text/html",
  ".htm": "text/html",
  ".zip": "application/zip",
  ".json": "application/json",
};

function _mime_por_extensao(nome: string): string {
  const i = nome.lastIndexOf(".");
  return i >= 0 ? (MIME[nome.slice(i).toLowerCase()] ?? "application/octet-stream") : "application/octet-stream";
}

export const CATEGORIA_POR_PALAVRA: readonly (readonly [string, string])[] = [
  ["parecer", "PARECER_ASSINADO"],
  ["laudo", "LAUDO"],
  ["portaria", "PORTARIA"],
  ["despacho", "DESPACHO"],
  ["formulario", "FORMULARIO"],
  ["formulário", "FORMULARIO"],
  ["relatorio", "RELATORIO_CAMPO"],
  ["relatório", "RELATORIO_CAMPO"],
  ["foto", "FOTO"],
];

export function categoria_do_anexo(nome: string | null | undefined): string {
  const alvo = textos.chave_busca(nome);
  for (const [palavra, categoria] of CATEGORIA_POR_PALAVRA) {
    if (alvo.includes(textos.chave_busca(palavra))) return categoria;
  }
  return "OUTRO";
}

/** 'MARCÍLIO COELHO FERREIRA 01-2025' -> '1/2025'. Nunca vincula sozinho. */
export function parecer_candidato(nome: string | null | undefined): string | null {
  if (!nome) return null;
  const m = RE_PARECER_TITULO.exec(nome.trim());
  if (!m) return null;
  return `${Number(m.groups!.numero)}/${m.groups!.ano}`;
}

/** 'Laudo 26255-000.1102022' -> '26255-000.110/2022' (marcado para conferência). */
export function laudo_candidato(texto: string | null | undefined): string | null {
  if (!texto) return null;
  const m = RE_LAUDO_ANEXO.exec(texto);
  if (!m) return null;
  return `${m[1]}-${m[2]}.${m[3]}/${m[4]}`;
}

export function documento_sei_de_anexo(nome: string | null | undefined): string | null {
  if (!nome) return null;
  const m = RE_DOC_SEI_ANEXO.exec(nome);
  if (!m) return null;
  return m.groups!.doc_sei ?? m.groups!.doc_sei2 ?? null;
}

// ---------------------------------------------------------------------
// Separação do backlog: cadastro histórico x trabalho pendente
// ---------------------------------------------------------------------
// O backlog "Adicional Ocupacional" tem 381 cartões com idade mediana de 3
// anos. 92% deles não têm anexo, checklist, comentário nem descrição além do
// NUP: são o cadastro histórico de quem já teve adicional, não fila de
// trabalho. Um cartão só conta como TRABALHO PENDENTE se deixou algum rastro.
export const DIAS_PARA_HISTORICO = 365;
export const TAMANHO_DESCRICAO_UTIL = 40;

export interface Classificacao {
  historico: boolean;
  motivo: string;
}

function _dias_entre(inicio: string, fim: string): number {
  const d = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((d(fim) - d(inicio)) / 86_400_000);
}

/**
 * Devolve se o cartão é cadastro histórico ou trabalho pendente. Qualquer
 * sinal de trabalho — anexo, checklist, comentário, prazo, descrição com
 * conteúdo ou atividade recente — mantém o cartão na fila.
 */
export function classificar_backlog(cartao: Json, hoje: string | null = null): Classificacao {
  const dia = hoje ?? datas_br.hoje();
  const marcas = (cartao.badges as Json) || {};
  const sinais: string[] = [];

  if (marcas.attachments || 0 || (cartao.attachments || []).length) sinais.push("tem anexo");
  if (marcas.checkItems || 0 || (cartao.checklists || []).length) sinais.push("tem checklist");
  if (marcas.comments || 0) sinais.push("tem comentário");
  if (cartao.due && !cartao.dueComplete) sinais.push("tem prazo em aberto");

  const descricao = String(cartao.desc || "").trim();
  // a descrição típica do cadastro é só "SEI 23086.000171/1993-41"
  const sem_nup = descricao
    .replace(/(?<![\p{L}\p{N}_])sei(?![\p{L}\p{N}_])|23086\.\d{6}\/\d{4}-\d{2}/giu, "")
    .trim();
  if ([...sem_nup].length >= TAMANHO_DESCRICAO_UTIL) sinais.push("tem descrição com conteúdo");

  const quando = _data(cartao.dateLastActivity);
  const dias = quando ? _dias_entre(quando, dia) : null;
  if (dias !== null && dias <= DIAS_PARA_HISTORICO) sinais.push(`movimentado há ${dias} dias`);

  if (sinais.length) return { historico: false, motivo: sinais.join("; ") };
  return {
    historico: true,
    motivo: `somente nome e número de processo, sem movimento há mais de ${DIAS_PARA_HISTORICO} dias`,
  };
}

export function _mapear_lista(nome: string | null | undefined): RegraLista | null {
  if (!nome) return null;
  const chave = textos.chave_busca(nome);
  for (const [original, regra] of Object.entries(DEPARA_LISTAS)) {
    if (textos.chave_busca(original) === chave) return { ...regra };
  }
  const m = RE_CONCLUIDO_ANO.exec(nome.trim());
  if (m) {
    return { etapa: "CONCLUIDO", estado: "CONCLUIDO", situacao: "CONCLUIDO", ano_referencia: Number(m.groups!.ano) };
  }
  return null;
}

export function _e_cartao_de_processo(cartao: Json, nup: string | null, servidor: unknown): boolean {
  const nome = String(cartao.name || "").trim();
  if (RE_NAO_PROCESSO.test(nome)) return false;
  return Boolean(nup || servidor);
}

type Servidor = typeof tabela_servidor.$inferSelect;
type Processo = typeof tabela_processo.$inferSelect;

async function _casar_servidor(tx: Executor, nome: string | null | undefined): Promise<Servidor | null> {
  if (!nome) return null;
  const limpo = nome.replace(/\s*\d{1,3}\s*[-/]\s*\d{4}$/, "").trim();
  const alvo = textos.chave_busca(limpo);
  if (!alvo) return null;
  for (const servidor of await tx.select().from(tabela_servidor).orderBy(asc(tabela_servidor.id))) {
    if (textos.chave_busca(servidor.nome) === alvo) return servidor;
  }
  return null;
}

export async function carregar_staging(tx: Executor, dados: Json): Promise<[Json[], Json[]]> {
  const listas = new Map<string, string | undefined>();
  for (const l of dados.lists ?? []) listas.set(l.id, l.name);
  const cartoes: Json[] = dados.cards ?? [];
  for (const cartao of cartoes) {
    const card_id = cartao.id;
    if (!card_id) continue;
    const valores = {
      nome: cartao.name ?? null,
      descricao: cartao.desc ?? null,
      lista: listas.get(cartao.idList) ?? null,
      payload: cartao,
      parecer_candidato: parecer_candidato(cartao.name),
      laudo_candidato: laudo_candidato(((cartao.attachments || []) as Json[]).map((a) => a.name ?? "").join(" ")),
    };
    const [existente] = await tx.select({ id: stg_trello_cartao.id }).from(stg_trello_cartao).where(eq(stg_trello_cartao.card_id, card_id));
    if (existente) await tx.update(stg_trello_cartao).set(valores).where(eq(stg_trello_cartao.id, existente.id));
    else await tx.insert(stg_trello_cartao).values({ card_id, ...valores });
  }
  const acoes: Json[] = dados.actions ?? [];
  for (const acao of acoes) {
    const action_id = acao.id;
    if (!action_id) continue;
    const valores = {
      card_id: (acao.data?.card || {}).id ?? null,
      tipo: acao.type ?? null,
      data: acao.date ?? null,
      autor: (acao.memberCreator || {}).fullName ?? null,
      payload: acao,
    };
    const [existente] = await tx.select({ id: stg_trello_acao.id }).from(stg_trello_acao).where(eq(stg_trello_acao.action_id, action_id));
    if (existente) await tx.update(stg_trello_acao).set(valores).where(eq(stg_trello_acao.id, existente.id));
    else await tx.insert(stg_trello_acao).values({ action_id, ...valores });
  }
  return [cartoes, acoes];
}

/** `repr()` do Python para o nome da lista na mensagem. */
function repr(v: string | null | undefined): string {
  if (v === null || v === undefined) return "None";
  const aspas = v.includes("'") && !v.includes('"') ? '"' : "'";
  const s = aspas === "'" ? v.replaceAll("\\", "\\\\").replaceAll("'", "\\'") : v.replaceAll("\\", "\\\\");
  return `${aspas}${s}${aspas}`;
}

function nome_do_erro(erro: unknown): string {
  return erro instanceof Error ? erro.name || "Error" : "Error";
}

export async function importar(
  tx: Executor,
  dados: Json,
  usuario: UsuarioAtual,
  aplicar = true,
  buscar_anexo: BuscarAnexo | null = baixar_url,
): Promise<RelatorioTrello> {
  const [cartoes, acoes] = await carregar_staging(tx, dados);
  const relatorio = new RelatorioTrello();
  relatorio.cartoes = cartoes.length;

  const listas = new Map<string, string | undefined>();
  for (const l of dados.lists ?? []) listas.set(l.id, l.name);
  const tipos = new Map((await tx.select().from(tipo_processo)).map((t) => [t.codigo, t]));
  const etapas = new Map((await tx.select().from(fluxo_etapa)).map((e) => [e.codigo, e]));
  const por_card = new Map<string, Processo>();

  for (const cartao of cartoes) {
    const nome_lista = listas.get(cartao.idList);
    const regra = _mapear_lista(nome_lista);
    const ref: string = cartao.id || "?";
    if (regra === null) {
      relatorio.listas_desconhecidas.add(nome_lista || "(sem lista)");
      await _rejeitar(tx, relatorio, ref, `lista não mapeada: ${repr(nome_lista)}`, cartao);
      continue;
    }
    if (regra.ignorar) {
      // painel/anotação: fica registrado, mas não vira processo
      await _rejeitar(
        tx,
        relatorio,
        ref,
        `${MOTIVO_LISTA_IGNORADA}: a lista ${repr(nome_lista)} é painel de anotação, não etapa do fluxo`,
        cartao,
      );
      continue;
    }

    const nups = servico_nup.extrair(cartao.desc);
    const nup = nups[0] ?? null;
    const servidor = await _casar_servidor(tx, cartao.name);

    // relatório de órfãos: todo cartão sem NUP entra, tenha ou não virado
    // processo — inclusive os recusados por CARTAO_NAO_PROCESSO.
    if (nup === null) relatorio.orfaos_processo.push(cartao.name || ref);

    if (!_e_cartao_de_processo(cartao, nup, servidor)) {
      await _rejeitar(tx, relatorio, ref, MOTIVO_NAO_PROCESSO, cartao);
      continue;
    }

    if (!aplicar) {
      // Simulação: não grava, mas calcula tudo o que a carga faria.
      relatorio.processos += 1;
      if (regra.separar_backlog) {
        const classe = classificar_backlog(cartao);
        if (classe.historico) relatorio.backlog_historico += 1;
        else {
          relatorio.backlog_pendente += 1;
          relatorio.motivos_pendente.push({ cartao: cartao.name, motivo: classe.motivo });
        }
      }
      for (const anexo of (cartao.attachments || []) as Json[]) {
        const candidato = laudo_candidato(anexo.name);
        if (candidato) {
          relatorio.laudos_candidatos.push({ cartao: cartao.name, anexo: anexo.name, laudo_candidato: candidato });
        }
        // o ensaio TENTA buscar de verdade: contar sem verificar daria um
        // número otimista que a carga real desmentiria
        if (buscar_anexo === null) {
          relatorio.anexos_perdidos.push([anexo.name || "?", anexo.url || "sem URL"]);
          continue;
        }
        try {
          await buscar_anexo(anexo.url || "");
          relatorio.anexos += 1;
        } catch (erro) {
          relatorio.anexos_perdidos.push([anexo.name || "?", `${nome_do_erro(erro)}: ${(erro as Error).message}`]);
        }
      }
      const candidato_parecer = parecer_candidato(cartao.name);
      if (candidato_parecer) {
        relatorio.conflitos_numeracao.push({
          cartao: cartao.name,
          parecer_candidato: candidato_parecer,
          nup,
          observacao: "vínculo NÃO automático — conferir com a planilha",
        });
      }
      continue;
    }

    const processo = await _obter_processo(tx, cartao, nup, ref);
    const tipo = tipos.get(regra.tipo ?? "ADICIONAL_OCUPACIONAL") ?? tipos.get("ADICIONAL_OCUPACIONAL")!;
    const etapa = etapas.get(regra.etapa!)!;
    const p: Partial<Processo> = {
      tipo_processo_id: tipo.id,
      etapa_id: etapa.id,
      estado_tecnico: cartao.closed ? "ARQUIVADO" : regra.estado!,
      origem_repositorio: Boolean(regra.repositorio),
    };

    // Backlog: separa cadastro histórico de trabalho pendente. O pendente sobe
    // para a fila; o histórico fica no repositório, fora do kanban e fora dos
    // indicadores.
    if (regra.separar_backlog) {
      const classe = classificar_backlog(cartao);
      if (classe.historico) relatorio.backlog_historico += 1;
      else {
        relatorio.backlog_pendente += 1;
        relatorio.motivos_pendente.push({ cartao: cartao.name, motivo: classe.motivo });
        p.origem_repositorio = false;
        p.etapa_id = etapas.get("A_FAZER")!.id;
        p.estado_tecnico = "EM_TRIAGEM";
      }
    }
    p.servidor_id = servidor ? servidor.id : processo.servidor_id;
    if (!servidor && !nup) p.observacoes = cartao.name ?? null;
    if (regra.ano_referencia) p.ano_referencia = regra.ano_referencia;
    if (regra.situacao === "CONCLUIDO") {
      p.situacao = "CONCLUIDO";
      p.data_conclusao = _data(cartao.due) ?? datas_br.hoje();
    }
    if (cartao.due) p.prazo = _data(cartao.due);
    if (cartao.dueComplete && cartao.due) {
      p.data_conclusao = _data(cartao.due);
      p.situacao = "CONCLUIDO";
      p.estado_tecnico = "CONCLUIDO";
      p.etapa_id = etapas.get("CONCLUIDO")!.id;
    }
    for (const campo of (cartao.customFieldItems || []) as Json[]) {
      const valor = (campo.value || {}).text || "";
      if (textos.chave_busca(valor) === "done") p.pronto_para_emissao = true;
    }
    await tx.update(tabela_processo).set(p).where(eq(tabela_processo.id, processo.id));
    Object.assign(processo, p);

    await _importar_checklists(tx, processo, cartao);
    await _importar_anexos(tx, processo, cartao, usuario, relatorio, buscar_anexo);
    por_card.set(cartao.id, processo);
    relatorio.processos += 1;

    const candidato = parecer_candidato(cartao.name);
    if (candidato) {
      relatorio.conflitos_numeracao.push({
        cartao: cartao.name,
        parecer_candidato: candidato,
        nup,
        observacao: "vínculo NÃO automático — conferir com a planilha",
      });
    }
  }

  if (aplicar) {
    relatorio.eventos = await _importar_acoes(tx, acoes, por_card, usuario);
  } else {
    // quantas ações teriam virado histórico, se a carga fosse para valer
    const conhecidos = new Set(
      cartoes.filter((c) => _mapear_lista(listas.get(c.idList)) !== null).map((c) => c.id),
    );
    relatorio.eventos = acoes.filter((a) => conhecidos.has(((a.data || {}).card || {}).id)).length;
  }
  return relatorio;
}

async function _obter_processo(tx: Executor, cartao: Json, nup: string | null, ref: string): Promise<Processo> {
  let [processo] = await tx
    .select()
    .from(tabela_processo)
    .where(and(eq(tabela_processo.origem_migracao, ORIGEM), eq(tabela_processo.origem_ref, ref)));
  if (!processo && nup) [processo] = await tx.select().from(tabela_processo).where(eq(tabela_processo.nup, nup));
  if (!processo) {
    [processo] = await tx
      .insert(tabela_processo)
      .values({
        nup: nup || (await _nup_sintetico(tx, ref)),
        tipo_processo_id: 1,
        etapa_id: 1,
        estado_tecnico: "RECEBIDO",
        origem_migracao: ORIGEM,
        origem_ref: ref,
      })
      .returning();
    return processo!;
  }
  [processo] = await tx
    .update(tabela_processo)
    .set({ origem_migracao: ORIGEM, origem_ref: ref })
    .where(eq(tabela_processo.id, processo.id))
    .returning();
  void cartao;
  return processo!;
}

/**
 * Cartão de repositório sem NUP ainda precisa de chave única: gera um NUP com
 * sequencial derivado do id do cartão e DV calculado, marcado no relatório de
 * órfãos para o Fabrício preencher o número real. `BigInt` porque os dígitos
 * do id do Trello passam de 2^53 (o Python tem inteiro de precisão livre).
 */
async function _nup_sintetico(tx: Executor, ref: string): Promise<string> {
  const digitos = ref.replace(/\D/g, "") || "0";
  const semente = Number(BigInt(digitos) % 1_000_000n);
  for (let tentativa = 0; tentativa < 1000; tentativa++) {
    const sequencial = String((semente + tentativa) % 1_000_000).padStart(6, "0");
    const base = `23086${sequencial}1900`;
    const candidato = `23086.${sequencial}/1900-${nup_dv(base)}`;
    const [ja] = await tx.select({ id: tabela_processo.id }).from(tabela_processo).where(eq(tabela_processo.nup, candidato));
    if (!ja) return candidato;
  }
  throw new Error("não foi possível gerar NUP sintético");
}

/**
 * Baixa, deduplica por SHA-256 e guarda. O que não vier fica no relatório.
 * `buscar` é injetável para os testes e para o modo sem rede.
 */
async function _importar_anexos(
  tx: Executor,
  processo: Processo,
  cartao: Json,
  usuario: UsuarioAtual,
  relatorio: RelatorioTrello,
  buscar: BuscarAnexo | null,
): Promise<void> {
  for (const anexo of (cartao.attachments || []) as Json[]) {
    const url: string | undefined = anexo.url;
    const nome: string = anexo.name || (url || "anexo").split("/").pop();
    const ref = `${cartao.id}:${anexo.id || nome}`;

    const candidato = laudo_candidato(nome);
    if (candidato) relatorio.laudos_candidatos.push({ cartao: cartao.name, anexo: nome, laudo_candidato: candidato });

    if (buscar === null || !url) {
      relatorio.anexos_perdidos.push([nome, url || "sem URL"]);
      await _rejeitar(tx, relatorio, ref, "anexo não baixado (a URL do Trello expira) — baixar manualmente", {
        nome,
        url: url ?? null,
        cartao: cartao.id ?? null,
      });
      continue;
    }

    let conteudo: Uint8Array;
    try {
      conteudo = await buscar(url);
    } catch (erro) {
      relatorio.anexos_perdidos.push([nome, `${nome_do_erro(erro)}: ${(erro as Error).message}`]);
      await _rejeitar(tx, relatorio, ref, `falha ao baixar o anexo: ${nome_do_erro(erro)}`, {
        nome,
        url,
        cartao: cartao.id ?? null,
      });
      continue;
    }

    let resultado: anexos.ResultadoAnexo;
    try {
      resultado = await anexos.guardar(tx, {
        entidade: "processo",
        entidade_id: processo.id,
        nome_original: nome,
        conteudo,
        mime_type: _mime_por_extensao(nome),
        categoria: categoria_do_anexo(nome),
        usuario,
        processo_id: processo.id,
        numero_documento_sei: documento_sei_de_anexo(nome),
        assinado: textos.chave_busca(nome).includes("assinado"),
        origem_migracao: ORIGEM,
        origem_ref: ref,
      });
    } catch (erro) {
      // DESVIO: o teto de 4 MB do armazenamento da nuvem (ver o cabeçalho)
      if (!(erro instanceof anexos.AnexoGrandeDemais)) throw erro;
      relatorio.anexos_perdidos.push([nome, `AnexoGrandeDemais: ${erro.message}`]);
      await _rejeitar(tx, relatorio, ref, "anexo acima do limite de 4 MB da nuvem — reduzir ou dividir", {
        nome,
        url,
        cartao: cartao.id ?? null,
      });
      continue;
    }
    if (resultado.duplicado) relatorio.anexos_duplicados += 1;
    else relatorio.anexos += 1;
  }
}

async function _importar_checklists(tx: Executor, processo: Processo, cartao: Json): Promise<void> {
  let ordem = 0;
  for (const bloco of (cartao.checklists || []) as Json[]) {
    ordem += 1;
    const nome: string = bloco.name || `Checklist ${ordem}`;
    const [existente] = await tx
      .select({ id: checklist.id })
      .from(checklist)
      .where(and(eq(checklist.processo_id, processo.id), eq(checklist.nome, nome)));
    if (existente) continue;
    const [novo] = await tx.insert(checklist).values({ processo_id: processo.id, nome, ordem }).returning();
    let i = 0;
    for (const item of (bloco.checkItems || []) as Json[]) {
      i += 1;
      await tx.insert(checklist_item).values({
        checklist_id: novo!.id,
        descricao: item.name || "",
        concluido: item.state === "complete",
        ordem: i,
      });
    }
  }
}

async function _importar_acoes(
  tx: Executor,
  acoes: Json[],
  por_card: Map<string, Processo>,
  _usuario: UsuarioAtual,
): Promise<number> {
  let total = 0;
  for (const acao of acoes) {
    const card_id = ((acao.data || {}).card || {}).id;
    const processo = por_card.get(card_id);
    if (!processo) continue;
    const ref = acao.id ?? null;
    const [ja] = await tx
      .select({ id: historico_evento.id })
      .from(historico_evento)
      .where(and(eq(historico_evento.origem, "MIGRACAO_TRELLO"), eq(historico_evento.origem_ref, ref)));
    if (ja) continue;
    await auditoria.registrar(tx, {
      entidade: "processo",
      entidade_id: processo.id,
      processo_id: processo.id,
      tipo_evento: acao.type || "TRELLO",
      descricao: _descrever(acao),
      usuario: null,
      usuario_nome: (acao.memberCreator || {}).fullName || "Trello",
      ocorrido_em: _momento(acao.date),
      origem: "MIGRACAO_TRELLO",
      origem_ref: ref,
    });
    total += 1;
  }
  return total;
}

/** `json.dumps(obj, ensure_ascii=False)` do Python: com `, ` e `: `, chaves na ordem. */
function dumps_python(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "[" + v.map(dumps_python).join(", ") + "]";
  if (typeof v === "object") {
    return "{" + Object.entries(v as Json).map(([k, x]) => `${JSON.stringify(k)}: ${dumps_python(x)}`).join(", ") + "}";
  }
  return JSON.stringify(v);
}

function _descrever(acao: Json): string {
  const dados: Json = acao.data || {};
  if (acao.type === "updateCard" && "listBefore" in dados) {
    return `movido de ${(dados.listBefore || {}).name ?? "None"} para ${(dados.listAfter || {}).name ?? "None"}`;
  }
  if (acao.type === "commentCard") return dados.text ?? "";
  return [...dumps_python(dados)].slice(0, 400).join("");
}

/** A data como está escrita no ISO (o `.date()` do `fromisoformat` do Python). */
function _data(valor: unknown): string | null {
  const momento = _momento(valor);
  if (!momento) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(valor));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : momento.toISOString().slice(0, 10);
}

function _momento(valor: unknown): Date | null {
  if (!valor) return null;
  const texto = String(valor);
  if (!/^\d{4}-\d{2}-\d{2}/.test(texto)) return null;
  const d = new Date(texto);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function _rejeitar(tx: Executor, relatorio: RelatorioTrello, ref: string, motivo: string, payload: Json) {
  const [ja] = await tx
    .select({ id: migracao_rejeitada.id })
    .from(migracao_rejeitada)
    .where(and(eq(migracao_rejeitada.origem, ORIGEM), eq(migracao_rejeitada.ref, ref)));
  if (!ja) {
    await tx.insert(migracao_rejeitada).values({
      origem: ORIGEM,
      ref,
      motivo,
      payload,
      expurgar_apos: datas_br.somar_dias(datas_br.hoje(), 90),
    });
  }
  relatorio.rejeitados.push([ref, motivo]);
}
