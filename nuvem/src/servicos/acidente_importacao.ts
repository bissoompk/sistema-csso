/**
 * Migração da planilha do CAT/SP antigo (fatia F9 do módulo de acidentes, D5).
 *
 * Importa só o que a ROPA §4.3 permite: os fatos do evento, os envolvidos
 * (casados com o cadastro de servidores pelo SIAPE), as testemunhas, a análise
 * (MAPA) e o plano de ação, com o protocolo `CAT-AAAA-NNNN` ORIGINAL. **Nunca
 * chegam ao banco:** CPF, RG, data de nascimento (só serve para saber se o
 * acidentado era menor de idade, e some), sexo, endereço, telefones e e-mail do
 * acidentado, o endereço e o telefone das testemunhas, as URLs do Drive e as
 * anotações livres da SST. CPF que aparece no meio de um texto é trocado por
 * «[CPF removido]».
 *
 * Os PDFs de relatório e os anexos do Drive NÃO vêm: a CAT/SP antiga é prova, e
 * o PDF original se baixa à mão e se anexa ao caso.
 *
 * Cada ocorrência migrada nasce com a origem `MIGRACAO`, a CAT/SP versão 1
 * (origem `MIGRACAO`, contexto congelado com hash) e o estado que a planilha
 * dizia. Não abre pendência: o caso é histórico. A saúde que a planilha
 * declarava entra como DECLARADA (a confirmar), só no nível 1.
 *
 * **Idempotente.** Protocolo que já existe é pulado (com a análise e o plano
 * dele). Cada linha roda num ponto de salvamento: a linha com defeito é
 * recusada e relatada, e as demais entram. Corrigida a planilha, roda-se de
 * novo. O relatório só tem protocolo e códigos — nenhum nome, texto ou valor.
 */
import { eq, sql } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  acidentado as tabela_acidentado,
  acidente_acao,
  acidente_agente_causador,
  acidente_agente_doenca,
  acidente_cat_sp,
  acidente_comunicante,
  acidente_evento_linha,
  acidente_investigacao,
  acidente_ocorrencia,
  acidente_parte_corpo,
  acidente_saude,
  acidente_saude_parte,
  acidente_situacao_geradora,
  acidente_testemunha,
  servidor as tabela_servidor,
  unidade_uorg,
  usuario as tabela_usuario,
} from "../db/esquema/index.js";
import {
  CARACTERIZACAO,
  ESPECIES,
  LOCAIS_DE_TRANSITO,
  LOCAIS_TIPO,
  PADRAO_PROTOCOLO_CAT,
  PRIORIDADES,
  ROTULO_CONDICAO_ENVOLVIDO,
  ROTULO_ESPECIE,
  ROTULO_LOCAL_TIPO,
  ROTULO_PRIORIDADE,
  ROTULO_TIPO_ACAO,
  TIPOS_ACAO,
  prazo_de_comunicacao,
} from "../dominio/acidente.js";
import { ROTULO_ACIDENTE } from "../dominio/estados.js";
import { hash_do_contexto, type ContextoCatSp } from "./acidente_comunicacao.js";
import * as auditoria from "./auditoria.js";
import * as datas_br from "./datas_br.js";

export const ATOR_DA_MIGRACAO = "migração do CAT/SP antigo (linha de comando)";

export type Linha = Record<string, string>;

export interface Planilhas {
  comunicacoes: Linha[];
  analises: Linha[];
  plano: Linha[];
}

export interface Relatorio {
  importadas: string[];
  ja_existiam: string[];
  recusadas: { protocolo: string; motivo: string }[];
  /** só protocolo e código: nunca texto da planilha */
  avisos: { protocolo: string; aviso: string }[];
  investigacoes: number;
  acoes: number;
  cpf_removidos: number;
  /** análises e ações cujo protocolo não está entre as comunicações */
  orfas: number;
  maior_numero_por_ano: Record<string, number>;
}

// ---------------------------------------------------------------------
// CSV (RFC 4180: aspas, aspas duplas e quebra de linha dentro do campo)
// ---------------------------------------------------------------------
export function ler_csv(texto: string): Linha[] {
  const t = texto.replace(/^﻿/, "");
  const linhas: string[][] = [];
  let campo = "";
  let linha: string[] = [];
  let aspas = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (aspas) {
      if (c === '"') {
        if (t[i + 1] === '"') {
          campo += '"';
          i++;
        } else aspas = false;
      } else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === ",") {
      linha.push(campo);
      campo = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      linha.push(campo);
      campo = "";
      linhas.push(linha);
      linha = [];
    } else campo += c;
  }
  if (campo !== "" || linha.length) {
    linha.push(campo);
    linhas.push(linha);
  }
  const util = linhas.filter((l) => l.some((v) => v.trim() !== ""));
  const cabecalho = (util[0] ?? []).map((h) => h.trim());
  return util.slice(1).map((l) => Object.fromEntries(cabecalho.map((h, i) => [h, (l[i] ?? "").trim()])));
}

// ---------------------------------------------------------------------
// Limpeza de texto e conversões
// ---------------------------------------------------------------------
const RE_CPF = /(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)/g;
const NAO_INFORMADO = "Não informado na planilha antiga";

class Contexto {
  cpf_removidos = 0;
  avisos: string[] = [];
  aviso(codigo: string) {
    if (!this.avisos.includes(codigo)) this.avisos.push(codigo);
  }
  /** Texto sem CPF, com no máximo `maximo` caracteres; vazio vira null. */
  texto(valor: string | undefined, maximo: number, campo: string): string | null {
    let v = (valor ?? "").replace(/\r\n?/g, "\n").trim();
    if (!v) return null;
    const antes = v;
    v = v.replace(RE_CPF, "[CPF removido]");
    if (v !== antes) this.cpf_removidos += antes.match(RE_CPF)?.length ?? 1;
    if (v.length > maximo) {
      v = v.slice(0, maximo);
      this.aviso(`texto_cortado:${campo}`);
    }
    return v;
  }
}

function sim_nao(valor: string | undefined): string | null {
  const v = (valor ?? "").trim().toUpperCase();
  if (v === "SIM" || v === "S") return "SIM";
  if (v === "NÃO" || v === "NAO" || v === "N") return "NAO";
  return null;
}

function data_iso(valor: string | undefined): string | null {
  const v = (valor ?? "").trim().split(/[ T]/)[0] ?? "";
  return v ? datas_br.analisar(v) : null;
}

function hora(valor: string | undefined): string | null {
  const m = /^(\d{1,2}):(\d{2})/.exec((valor ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  if (h > 23 || Number(m[2]) > 59) return null;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

function momento(valor: string | undefined): Date | null {
  const v = (valor ?? "").trim();
  if (!v) return null;
  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2}))?/.exec(v);
  if (br) {
    // sem fuso na planilha: a hora é a de Brasília (UTC-3)
    return new Date(Date.UTC(Number(br[3]), Number(br[2]) - 1, Number(br[1]), Number(br[4] ?? 12) + 3, Number(br[5] ?? 0)));
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** «2 horas», «90 min», «01:30», «3» (horas): minutos desde o início da jornada, ou null. */
function minutos_de_jornada(valor: string | undefined): number | null {
  const v = (valor ?? "").trim().toLowerCase();
  if (!v) return null;
  let m = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /^(\d+(?:[.,]\d+)?)\s*(h|hora|horas|hs)?$/.exec(v);
  if (m) return Math.round(Number(m[1]!.replace(",", ".")) * 60);
  m = /^(\d+)\s*(min|minutos?)$/.exec(v);
  if (m) return Number(m[1]);
  return null;
}

function inverso(rotulos: Readonly<Record<string, string>>): Map<string, string> {
  return new Map(Object.entries(rotulos).map(([codigo, rotulo]) => [rotulo.toLowerCase(), codigo]));
}
const ESPECIE_DO_ROTULO = inverso(ROTULO_ESPECIE);
const LOCAL_DO_ROTULO = inverso(ROTULO_LOCAL_TIPO);
const CONDICAO_DO_ROTULO = inverso(ROTULO_CONDICAO_ENVOLVIDO);
const TIPO_ACAO_DO_ROTULO = inverso(ROTULO_TIPO_ACAO);
const PRIORIDADE_DO_ROTULO = inverso(ROTULO_PRIORIDADE);
const ESTADO_DO_ROTULO = inverso(ROTULO_ACIDENTE);
const ESTADO_DA_ACAO: Record<string, string> = {
  pendente: "PENDENTE",
  "em andamento": "EM_ANDAMENTO",
  concluída: "CONCLUIDA",
  concluida: "CONCLUIDA",
  cancelada: "CANCELADA",
};
// o legado chamava a investigação de «Em análise SST»
ESTADO_DO_ROTULO.set("em análise sst", "EM_INVESTIGACAO");
ESTADO_DO_ROTULO.set("encaminhada ao siass", "ENCAMINHADA_SIASS");

function da_lista(mapa: Map<string, string>, valor: string | undefined): string | null {
  return mapa.get((valor ?? "").trim().toLowerCase()) ?? null;
}

// ---------------------------------------------------------------------
// Catálogos (casados pelo texto do legado)
// ---------------------------------------------------------------------
interface Catalogos {
  agentes: Map<string, number>;
  doencas: Map<string, number>;
  situacoes: Map<string, number>;
  /** rótulos do legado, do mais longo ao mais curto: a lista de partes vem numa célula só, e os rótulos têm vírgula */
  partes: { legado: string; id: number }[];
}

const normalizar = (v: string) => v.trim().replace(/\s+/g, " ").toLowerCase();

async function carregar_catalogos(tx: Executor): Promise<Catalogos> {
  const mapa = async (t: typeof acidente_agente_causador | typeof acidente_agente_doenca | typeof acidente_situacao_geradora) => {
    const linhas = await tx.select({ id: t.id, legado: t.rotulo_legado }).from(t);
    return new Map(linhas.filter((l) => l.legado).map((l) => [normalizar(l.legado!), l.id]));
  };
  const partes = await tx.select({ id: acidente_parte_corpo.id, legado: acidente_parte_corpo.rotulo_legado }).from(acidente_parte_corpo);
  return {
    agentes: await mapa(acidente_agente_causador),
    doencas: await mapa(acidente_agente_doenca),
    situacoes: await mapa(acidente_situacao_geradora),
    partes: partes
      .filter((p) => p.legado)
      .map((p) => ({ legado: normalizar(p.legado!), id: p.id }))
      .sort((a, b) => b.legado.length - a.legado.length),
  };
}

function partes_do_texto(texto: string, partes: Catalogos["partes"]): { ids: number[]; sobrou: boolean } {
  let resto = normalizar(texto);
  const ids: number[] = [];
  for (const p of partes) {
    if (resto.includes(p.legado)) {
      ids.push(p.id);
      resto = resto.replace(p.legado, " ");
    }
  }
  return { ids, sobrou: resto.replace(/[\s,;|]+/g, "") !== "" };
}

// ---------------------------------------------------------------------
// Os envolvidos
// ---------------------------------------------------------------------
interface EnvolvidoLegado {
  nome: string;
  siape: string;
  condicao: string | null;
  lesao: string | null;
  afastamento: string | null;
  nascimento: string | null;
}

function envolvidos_da_linha(l: Linha): EnvolvidoLegado[] {
  let lista: Record<string, unknown>[] = [];
  const bruto = (l.ServidoresEnvolvidosJSON ?? "").trim();
  if (bruto) {
    try {
      const j: unknown = JSON.parse(bruto);
      if (Array.isArray(j)) lista = j.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null);
    } catch {
      lista = [];
    }
  }
  if (!lista.length) {
    lista = [
      {
        NomeServidor: l.NomeServidor,
        MatriculaSIAPE: l.MatriculaSIAPE,
        DataNascimento: l.DataNascimento,
        CondicaoNoAcidente: "",
      },
    ];
  }
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
  return lista
    .map((e) => ({
      nome: s(e.NomeServidor),
      siape: s(e.MatriculaSIAPE).replace(/\D/g, ""),
      condicao: da_lista(CONDICAO_DO_ROTULO, s(e.CondicaoNoAcidente)),
      lesao: sim_nao(s(e.HouveLesao)),
      afastamento: sim_nao(s(e.HouveAfastamentoIndividual)),
      nascimento: s(e.DataNascimento) || null,
    }))
    .filter((e) => e.nome || e.siape);
}

/** Menor de idade na data do acidente (a data de nascimento é lida aqui e descartada). */
function era_menor(nascimento: string | null, data_evento: string): boolean {
  const nasc = data_iso(nascimento ?? undefined);
  if (!nasc) return false;
  const [a, m, d] = nasc.split("-").map(Number) as [number, number, number];
  const maioridade = `${a + 18}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return data_evento < maioridade;
}

// ---------------------------------------------------------------------
// A importação
// ---------------------------------------------------------------------
export interface OpcoesImportacao {
  /** a conta que conduz a migração: autora do plano de ação e da CAT/SP migrada */
  ator_id: number;
}

class LinhaRecusada extends Error {}

export async function importar(tx: Executor, planilhas: Planilhas, opcoes: OpcoesImportacao): Promise<Relatorio> {
  const rel: Relatorio = {
    importadas: [],
    ja_existiam: [],
    recusadas: [],
    avisos: [],
    investigacoes: 0,
    acoes: 0,
    cpf_removidos: 0,
    orfas: 0,
    maior_numero_por_ano: {},
  };
  const catalogos = await carregar_catalogos(tx);
  const protocolos = new Set(planilhas.comunicacoes.map((l) => (l.Protocolo ?? "").trim()));
  const ids = new Map<string, number>();

  for (const linha of planilhas.comunicacoes) {
    const protocolo = (linha.Protocolo ?? "").trim();
    if (!new RegExp(`^${PADRAO_PROTOCOLO_CAT}$`).test(protocolo)) {
      rel.recusadas.push({ protocolo: protocolo || "(sem protocolo)", motivo: "protocolo fora do padrão CAT-AAAA-NNNN" });
      continue;
    }
    const [existente] = await tx
      .select({ id: acidente_ocorrencia.id })
      .from(acidente_ocorrencia)
      .where(eq(acidente_ocorrencia.protocolo, protocolo));
    if (existente) {
      rel.ja_existiam.push(protocolo);
      continue;
    }
    const ctx = new Contexto();
    try {
      const id = await tx.transaction((sp) => importar_comunicacao(sp, linha, protocolo, catalogos, ctx, opcoes));
      ids.set(protocolo, id);
      rel.importadas.push(protocolo);
      const ano = protocolo.slice(4, 8);
      const numero = Number(protocolo.slice(9));
      rel.maior_numero_por_ano[ano] = Math.max(rel.maior_numero_por_ano[ano] ?? 0, numero);
    } catch (erro) {
      const motivo =
        erro instanceof LinhaRecusada ? erro.message : `o banco recusou a linha (${(erro as { constraint_name?: string }).constraint_name ?? "erro"})`;
      rel.recusadas.push({ protocolo, motivo });
    }
    rel.cpf_removidos += ctx.cpf_removidos;
    for (const a of ctx.avisos) rel.avisos.push({ protocolo, aviso: a });
  }

  // análise (MAPA) e plano de ação: só dos casos importados nesta rodada
  for (const l of planilhas.analises) {
    const protocolo = (l.Protocolo ?? "").trim();
    if (!protocolos.has(protocolo)) rel.orfas += 1;
    const id = ids.get(protocolo);
    if (id === undefined) continue;
    const ctx = new Contexto();
    try {
      await tx.transaction((sp) => importar_analise(sp, id, l, ctx));
      rel.investigacoes += 1;
    } catch {
      rel.recusadas.push({ protocolo, motivo: "a análise (MAPA) foi recusada" });
    }
    rel.cpf_removidos += ctx.cpf_removidos;
    for (const a of ctx.avisos) rel.avisos.push({ protocolo, aviso: a });
  }
  const numeros = new Map<number, number>();
  for (const l of planilhas.plano) {
    const protocolo = (l.Protocolo ?? "").trim();
    if (!protocolos.has(protocolo)) rel.orfas += 1;
    const id = ids.get(protocolo);
    if (id === undefined) continue;
    const ctx = new Contexto();
    try {
      const numero = (numeros.get(id) ?? 0) + 1;
      await tx.transaction((sp) => importar_acao(sp, id, numero, l, ctx, opcoes));
      numeros.set(id, numero);
      rel.acoes += 1;
    } catch {
      rel.recusadas.push({ protocolo, motivo: "uma ação do plano foi recusada" });
    }
    rel.cpf_removidos += ctx.cpf_removidos;
    for (const a of ctx.avisos) rel.avisos.push({ protocolo, aviso: a });
  }

  // a sequência continua depois do maior número migrado de cada ano
  for (const [ano, maior] of Object.entries(rel.maior_numero_por_ano)) {
    await tx.execute(sql`
      INSERT INTO acidente_cat_sp_sequencia (ano, ultimo_numero) VALUES (${Number(ano)}, ${maior})
      ON CONFLICT (ano) DO UPDATE SET ultimo_numero = GREATEST(acidente_cat_sp_sequencia.ultimo_numero, ${maior})`);
  }
  return rel;
}

async function importar_comunicacao(
  tx: Executor,
  l: Linha,
  protocolo: string,
  cat: Catalogos,
  ctx: Contexto,
  opcoes: OpcoesImportacao,
): Promise<number> {
  const ano = Number(protocolo.slice(4, 8));
  const numero = Number(protocolo.slice(9));
  const data_evento = data_iso(l.DataAcidente);
  if (!data_evento) throw new LinhaRecusada("data do acidente ausente ou inválida");

  const especie = da_lista(ESPECIE_DO_ROTULO, l.TipoAcidente) ?? "OUTRO";
  if (!da_lista(ESPECIE_DO_ROTULO, l.TipoAcidente)) ctx.aviso("tipo_de_acidente_nao_reconhecido");
  if (!(ESPECIES as readonly string[]).includes(especie)) throw new LinhaRecusada("espécie inválida");
  const local_tipo = da_lista(LOCAL_DO_ROTULO, l.LocalTipo) ?? "OUTRO";
  if (!da_lista(LOCAL_DO_ROTULO, l.LocalTipo)) ctx.aviso("tipo_de_local_nao_reconhecido");
  if (!(LOCAIS_TIPO as readonly string[]).includes(local_tipo)) throw new LinhaRecusada("tipo de local inválido");
  if ((l.TipoCAT ?? "").trim().toLowerCase() === "reabertura") ctx.aviso("reabertura_ficou_como_inicial");

  const estado = da_lista(ESTADO_DO_ROTULO, l.Status) ?? "RECEBIDA";
  if (!da_lista(ESTADO_DO_ROTULO, l.Status)) ctx.aviso("status_nao_reconhecido_ficou_recebida");
  const criado_em = momento(l.CriadoEm) ?? new Date();
  const atualizado_em = momento(l.AtualizadoEm) ?? criado_em;

  // os catálogos: o texto do legado, ou nada (a escolha livre do legado não casa)
  const casar = (mapa: Map<string, number>, valor: string | undefined, nome: string): number | null => {
    const v = (valor ?? "").trim();
    if (!v) return null;
    const id = mapa.get(normalizar(v));
    if (id === undefined) ctx.aviso(`${nome}_nao_casou_com_a_lista`);
    return id ?? null;
  };
  const agente_causador_id = casar(cat.agentes, l.AgenteCausadorAcidente, "agente_causador");
  const agente_doenca_id = especie === "DOENCA_TRABALHO" ? casar(cat.doencas, l.AgenteCausadorDoenca, "agente_doenca") : null;
  const situacao_geradora_id = casar(cat.situacoes, l.SituacaoGeradora, "situacao_geradora");

  const de_transito = especie === "TRAJETO" || LOCAIS_DE_TRANSITO.has(local_tipo);
  const cnpj = (l.CNPJLocal ?? "").trim();
  const cnpj_valido = /^\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}$/.test(cnpj);
  if (cnpj && !cnpj_valido) ctx.aviso("cnpj_do_local_descartado");
  const uf = (l.UFLocal ?? "").trim().toUpperCase();
  const minutos = minutos_de_jornada(l.AposQuantasHorasTrabalho);
  if ((l.AposQuantasHorasTrabalho ?? "").trim() && minutos === null) ctx.aviso("tempo_de_jornada_nao_entendido");

  // os envolvidos (o cadastro de servidores, pelo SIAPE)
  const lista = envolvidos_da_linha(l);
  if (!lista.length) throw new LinhaRecusada("nenhum envolvido na linha");
  const vistos = new Set<number>();
  const envolvidos: {
    legado: EnvolvidoLegado;
    servidor: typeof tabela_servidor.$inferSelect | null;
    campus_id: number | null;
    menor: boolean;
  }[] = [];
  for (const e of lista) {
    let servidor: typeof tabela_servidor.$inferSelect | null = null;
    if (/^\d{7}$/.test(e.siape)) {
      [servidor] = await tx.select().from(tabela_servidor).where(eq(tabela_servidor.siape, e.siape));
    }
    if (servidor && vistos.has(servidor.id)) continue;
    if (servidor) vistos.add(servidor.id);
    else ctx.aviso("siape_nao_casou_com_o_cadastro");
    let campus_id: number | null = null;
    if (servidor?.unidade_uorg_id) {
      const [u] = await tx.select({ campus_id: unidade_uorg.campus_id }).from(unidade_uorg).where(eq(unidade_uorg.id, servidor.unidade_uorg_id));
      campus_id = u?.campus_id ?? null;
    }
    envolvidos.push({ legado: e, servidor, campus_id, menor: era_menor(e.nascimento, data_evento) });
  }
  const principal = envolvidos.find((e) => e.servidor && (e.legado.condicao ?? "ACIDENTADO") === "ACIDENTADO") ?? envolvidos.find((e) => e.servidor) ?? null;
  const restrita_sst = envolvidos.some((e) => e.menor);

  const fatos = {
    especie,
    data_evento,
    hora_evento: hora(l.HoraAcidente),
    minutos_apos_inicio_jornada: minutos,
    ultimo_dia_trabalho: data_iso(l.UltimoDiaTrabalho),
    local_tipo,
    local_especificacao: ctx.texto(l.EspecificacaoLocal, 400, "local") ?? NAO_INFORMADO,
    campus_id: principal?.campus_id ?? null,
    local_municipio: ctx.texto(l.MunicipioLocal, 80, "municipio"),
    local_uf: /^[A-Z]{2}$/.test(uf) ? uf : null,
    local_cnpj_contratada: cnpj_valido ? cnpj : null,
    transito_registro_policial: de_transito ? sim_nao(l.HouveRegistroPolicial) : null,
    transito_numero_bo: de_transito ? ctx.texto(l.NumeroBO, 40, "bo") : null,
    transito_vitima_terceiros: de_transito ? sim_nao(l.VitimaTerceiros) : null,
    agente_causador_id,
    agente_doenca_id,
    situacao_geradora_id,
  };
  const relato = {
    descricao: ctx.texto(l.DescricaoAcidente, 4000, "descricao") ?? NAO_INFORMADO,
    atividade_no_momento: ctx.texto(l.AtividadeNoMomento, 400, "atividade"),
  };
  // narrativo com termo de saúde: a ficha é do legado, mas a equipe precisa saber
  if (/\b(cid|diagn[óo]stico|laudo m[ée]dico)\b/i.test(`${relato.descricao} ${relato.atividade_no_momento ?? ""}`)) {
    ctx.aviso("relato_com_possivel_dado_de_saude_revisar");
  }

  const [oc] = await tx
    .insert(acidente_ocorrencia)
    .values({
      protocolo,
      ano,
      numero,
      estado: "RECEBIDA",
      tipo_cat: "INICIAL",
      origem: "MIGRACAO",
      ...fatos,
      servidor_id: principal?.servidor?.id ?? null,
      prazo_comunicacao: prazo_de_comunicacao(data_evento),
      restrita_sst,
      criado_por: null,
      criado_em,
    })
    .returning();
  const id = oc!.id;

  // envolvidos e saúde declarada (nível 1)
  const partes = l.ParteCorpoAtingida ? partes_do_texto(l.ParteCorpoAtingida, cat.partes) : { ids: [], sobrou: false };
  if (partes.sobrou) ctx.aviso("parte_do_corpo_nao_casou_com_a_lista");
  const atendimento = (l.UnidadeAtendimento ?? "").trim() || (l.DataAtendimento ?? "").trim() ? "SIM" : null;
  const congelados: Record<string, unknown>[] = [];
  const declaradas: ContextoCatSp["saude_declarada"] = [];
  for (const [i, e] of envolvidos.entries()) {
    const condicao = e.legado.condicao ?? (i === 0 ? "ACIDENTADO" : "OUTRO");
    const nome_externo = e.servidor ? null : (ctx.texto(e.legado.nome, 160, "nome_envolvido") ?? NAO_INFORMADO);
    const siape = e.servidor?.siape ?? (/^\d{7}$/.test(e.legado.siape) ? e.legado.siape : null);
    const [criado] = await tx
      .insert(tabela_acidentado)
      .values({
        ocorrencia_id: id,
        ordem: i + 1,
        vinculo: "SERVIDOR",
        servidor_id: e.servidor?.id ?? null,
        nome_externo,
        condicao,
        houve_lesao: e.legado.lesao,
        cargo_id: e.servidor?.cargo_id ?? null,
        funcao: e.servidor?.funcao ?? null,
        unidade_uorg_id: e.servidor?.unidade_uorg_id ?? null,
        campus_id: e.campus_id,
        siape,
        menor_de_idade: e.menor,
      })
      .returning({ id: tabela_acidentado.id });
    congelados.push({
      ordem: i + 1,
      vinculo: "SERVIDOR",
      servidor_id: e.servidor?.id ?? null,
      siape,
      nome: e.servidor?.nome ?? nome_externo,
      identificacao_externa: null,
      empresa_contratada: null,
      condicao,
      houve_lesao: e.legado.lesao,
      menor_de_idade: e.menor,
      contato_investigacao: null,
    });
    const e_principal = principal ? e === principal : i === 0;
    const saude = {
      partes_corpo_ids: e_principal ? partes.ids : [],
      houve_atendimento: e_principal ? atendimento : null,
      houve_afastamento: e.legado.afastamento ?? (e_principal ? sim_nao(l.HouveAfastamento) : null),
      houve_internacao: e_principal ? sim_nao(l.HouveInternacao) : null,
      houve_obito: e_principal ? sim_nao(l.HouveMorte) : null,
    };
    declaradas.push({ ordem: i + 1, origem: "DECLARADO_COMUNICANTE", ...saude });
    if (saude.partes_corpo_ids.length || saude.houve_atendimento || saude.houve_afastamento || saude.houve_internacao || saude.houve_obito) {
      const [s] = await tx
        .insert(acidente_saude)
        .values({
          acidentado_id: criado!.id,
          houve_atendimento: saude.houve_atendimento,
          houve_afastamento: saude.houve_afastamento,
          houve_internacao: saude.houve_internacao,
          houve_obito: saude.houve_obito,
          origem: "DECLARADO_COMUNICANTE",
          registrado_por: null,
        })
        .returning({ id: acidente_saude.id });
      for (const parte_corpo_id of saude.partes_corpo_ids) {
        await tx.insert(acidente_saude_parte).values({ saude_id: s!.id, parte_corpo_id });
      }
    }
  }

  // testemunhas: só o nome (telefone e endereço não vêm)
  const testemunhas: { nome: string; vinculo: string | null; contato: string | null }[] = [];
  for (const n of [l.Testemunha1Nome, l.Testemunha2Nome]) {
    const nome = ctx.texto(n, 160, "testemunha");
    if (nome) testemunhas.push({ nome, vinculo: null, contato: null });
  }
  for (const t of testemunhas) await tx.insert(acidente_testemunha).values({ ocorrencia_id: id, ...t });

  // quem comunicou na planilha antiga (a conta não existia)
  const email = (l.EmitenteEmail ?? "").trim();
  await tx.insert(acidente_comunicante).values({
    ocorrencia_id: id,
    usuario_id: null,
    nome: ctx.texto(l.EmitenteNome, 160, "emitente") ?? NAO_INFORMADO,
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 160 ? email : "nao-informado@migracao.invalid",
    vinculo: "OUTRO",
    declarou_veracidade_em: criado_em,
    ip: null,
  });

  const contexto: ContextoCatSp = {
    protocolo,
    versao: 1,
    origem_comunicacao: "MIGRACAO",
    fatos,
    relato,
    envolvidos: congelados,
    testemunhas,
    comunicante: { usuario_id: null, chefia_imediata: false },
    saude_declarada: declaradas,
    complementacoes: [],
  };
  await tx.insert(acidente_cat_sp).values({
    ocorrencia_id: id,
    versao: 1,
    contexto_congelado: contexto,
    hash_conteudo: hash_do_contexto(contexto),
    origem: "MIGRACAO",
    registrada_por: opcoes.ator_id,
  });

  // o estado que a planilha dizia, de uma vez (nenhuma transição a validar: é histórico)
  await tx
    .update(acidente_ocorrencia)
    .set({
      cat_sp_versao: 1,
      estado,
      ...(estado === "CONCLUIDA"
        ? { concluida_em: atualizado_em, conclusao_motivo: "Concluída antes da migração, na planilha antiga." }
        : {}),
      ...(estado === "CANCELADA"
        ? { cancelamento_motivo: "OUTRO", cancelamento_texto: "Cancelada antes da migração, na planilha antiga." }
        : {}),
    })
    .where(eq(acidente_ocorrencia.id, id));

  await auditoria.registrar(tx, {
    entidade: "acidente_ocorrencia",
    entidade_id: id,
    tipo_evento: auditoria.ACIDENTE_IMPORTADO,
    // sem nome nem texto: o protocolo, o estado e quantos envolvidos
    descricao: `Ocorrência ${protocolo} migrada da planilha antiga no estado ${estado}, com ${envolvidos.length} envolvido(s).`,
    usuario_nome: ATOR_DA_MIGRACAO,
  });
  return id;
}

const SECOES_DE_BARREIRA: [string, string][] = [
  ["BarreirasFisicas", "Barreiras físicas"],
  ["BarreirasFuncionais", "Barreiras funcionais"],
  ["BarreirasSimbolicas", "Barreiras simbólicas"],
  ["BarreirasAdministrativas", "Barreiras administrativas"],
  ["BarreirasAusentes", "Barreiras ausentes"],
];

async function importar_analise(tx: Executor, ocorrencia_id: number, l: Linha, ctx: Contexto): Promise<void> {
  const t = (campo: string, maximo = 8000) => ctx.texto(l[campo], maximo, campo);
  const analista = (l.Analista || l.AnalistaEmail || "").trim().toLowerCase();
  let responsavel_id: number | null = null;
  if (analista.includes("@")) {
    const [u] = await tx.select({ id: tabela_usuario.id }).from(tabela_usuario).where(eq(tabela_usuario.email, analista));
    responsavel_id = u?.id ?? null;
  }
  // as barreiras do legado são texto livre sem situação: ficam como estavam, rotuladas
  const barreiras = SECOES_DE_BARREIRA.map(([c, rotulo]) => {
    const v = t(c);
    return v ? `${rotulo}: ${v}` : null;
  }).filter((v): v is string => v !== null);
  const evidencias = [t("Evidencias"), ...barreiras].filter((v): v is string => v !== null).join("\n\n") || null;
  const caracterizacao = (l.CaracterizadoAcidenteServicoSST ?? "").trim().toLowerCase();
  const car = caracterizacao === "sim" ? "SIM" : caracterizacao === "não" || caracterizacao === "nao" ? "NAO" : caracterizacao.startsWith("inconcl") ? "INCONCLUSIVO" : null;
  if (car !== null && !(CARACTERIZACAO as readonly string[]).includes(car)) throw new LinhaRecusada("caracterização inválida");
  if ((l.NexoCausalPerito ?? "").trim()) ctx.aviso("nexo_causal_do_perito_nao_importado");

  await tx.insert(acidente_investigacao).values({
    ocorrencia_id,
    responsavel_id,
    equipe: t("EquipeAnalise"),
    objetivo: t("ObjetivoAnalise"),
    trabalho_habitual: t("TrabalhoHabitual"),
    prescrito_real: t("DiferencaPrescritoReal"),
    mudanca_individuo: t("MudancaIndividuo"),
    mudanca_tarefa: t("MudancaTarefa"),
    mudanca_material: t("MudancaMaterial"),
    mudanca_meio: t("MudancaMeioTrabalho"),
    relatos_campo: t("RelatosCampo"),
    evidencias_texto: evidencias,
    sintese: t("SinteseExplicativa"),
    ampliacao_conceitual: t("AmpliacaoConceitual"),
    ambiente_fator: sim_nao(l.AmbienteFatorAcidente),
    caracterizacao: car,
    requer_cat_siass: sim_nao(l.RequerAberturaCATSIASS),
    recomendacoes: t("RecomendacoesObservacoes"),
  });
  const linha_do_tempo = t("LinhaDoTempo");
  if (linha_do_tempo) {
    await tx.insert(acidente_evento_linha).values({ ocorrencia_id, momento: "Planilha antiga", descricao: linha_do_tempo, ordem: 1 });
  }
  for (const c of ["TranscricaoEntrevistas", "GravacoesURLs", "ChecklistCampoJSON", "RetificacaoRelatorio"]) {
    if ((l[c] ?? "").trim()) ctx.aviso(`${c}_nao_importado`);
  }
}

async function importar_acao(tx: Executor, ocorrencia_id: number, numero: number, l: Linha, ctx: Contexto, opcoes: OpcoesImportacao): Promise<void> {
  const acao = ctx.texto(l.Acao, 4000, "acao");
  if (!acao) throw new LinhaRecusada("ação sem texto");
  const tipo = da_lista(TIPO_ACAO_DO_ROTULO, l.TipoAcao) ?? "OUTRA";
  if (!(TIPOS_ACAO as readonly string[]).includes(tipo)) throw new LinhaRecusada("tipo de ação inválido");
  const prioridade = da_lista(PRIORIDADE_DO_ROTULO, l.Prioridade) ?? "MEDIA";
  if (!(PRIORIDADES as readonly string[]).includes(prioridade)) throw new LinhaRecusada("prioridade inválida");
  const estado = ESTADO_DA_ACAO[(l.Status ?? "").trim().toLowerCase()] ?? "PENDENTE";
  const atualizada = momento(l.AtualizadoEm) ?? new Date();
  await tx.insert(acidente_acao).values({
    ocorrencia_id,
    numero,
    achado: ctx.texto(l.Achado, 4000, "achado"),
    acao,
    tipo_acao: tipo,
    // o responsável do legado era texto livre: segue como texto
    responsavel_texto: ctx.texto(l.Responsavel, 160, "responsavel"),
    prazo: data_iso(l.Prazo),
    prioridade,
    estado,
    ...(estado === "CONCLUIDA" ? { concluida_em: atualizada, conclusao_texto: ctx.texto(l.Observacao, 4000, "observacao") } : {}),
    ...(estado === "CANCELADA" ? { cancelamento_motivo: "Cancelada antes da migração, na planilha antiga." } : {}),
    criada_por: opcoes.ator_id,
  });
}
