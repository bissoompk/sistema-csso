/**
 * Certificado: o de-para entre o marcador do .docx e o dado do sistema, e o
 * contexto congelado de que a segunda via é reimpressa.
 * Porte de `app/servicos/certificado.py`.
 *
 * - **Código** é `CAMPOS_CERTIFICADO`, aqui: cada campo precisa de alguém que
 *   saiba onde buscar o dado, e isso é função, não linha de tabela.
 * - **Dado** é a tabela `certificado_modelo_tag`: qual marcador do .docx recebe
 *   qual campo é editável na tela, sem deploy.
 *
 * **A função `obter` lê do `ContextoCertificado`, e de mais nada.** Não recebe
 * executor, não consulta o banco — é o que faz a RN-15 valer: reimprimir chama
 * exatamente o mesmo código sobre o contexto descongelado.
 *
 * O que este módulo NÃO faz: emitir, anular e validar (`emissao_certificado.ts`).
 */
import { randomInt } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  ALFABETO_IDENTIFICADOR,
  PADRAO_CHAVE_VALIDACAO,
  PREFIXO_CHAVE,
  TAMANHO_SORTEIO_CHAVE,
} from "../dominio/treinamento.js";
import * as anexos from "./anexos.js";
import * as datas_br from "./datas_br.js";
import * as documento from "./documento.js";
import { numero as numero_br } from "./presenca.js";

/** Subpasta de `modelos-docx/` — o `app/templates/certificados/` do Python. */
export const DIR_MODELOS_CERTIFICADO = "certificados";

// a rubrica sai impressa; 35 mm é a largura típica de uma assinatura digitalizada
export const LARGURA_RUBRICA_MM = 35.0;

export const SEM_VENCIMENTO = "não expira";

const _ALFABETO_CHAVE = ALFABETO_IDENTIFICADOR;
const _RE_CHAVE = new RegExp(`^(?:${PADRAO_CHAVE_VALIDACAO})$`);

/** Nunca chutar a chave: campo fora do vocabulário é erro, não aviso. */
export class CampoDesconhecido extends Error {
  constructor(public codigo: string) {
    super(`Campo de certificado desconhecido: ${codigo}`);
  }
}

// =====================================================================
// Chave de validação (§5 do desenho)
// =====================================================================
/**
 * Um caractere do alfabeto, mod 30 sobre os 14 caracteres significativos (ano
 * + os 10 sorteados), com peso pela posição: transposição de dois caracteres é
 * o erro de quem copia do papel. `ord` do Python = code point.
 */
export function digito_verificador(significativos: string): string {
  let soma = 0;
  [...significativos].forEach((c, posicao) => {
    soma += (posicao + 1) * c.codePointAt(0)!;
  });
  return _ALFABETO_CHAVE[soma % _ALFABETO_CHAVE.length]!;
}

/** `CSSO-2026-K7QMX-3FTB9-H` a partir do ano e dos 10 caracteres sorteados. */
export function montar_chave(ano: number, sorteio: string): string {
  if (sorteio.length !== TAMANHO_SORTEIO_CHAVE) {
    throw new RangeError(`o sorteio da chave tem ${TAMANHO_SORTEIO_CHAVE} caracteres, nao ${sorteio.length}`);
  }
  const a = String(ano).padStart(4, "0");
  return `${PREFIXO_CHAVE}-${a}-${sorteio.slice(0, 5)}-${sorteio.slice(5)}-${digito_verificador(`${a}${sorteio}`)}`;
}

/** Dez caracteres de sorteio criptográfico — ~49 bits. */
export function gerar_chave(ano: number): string {
  let sorteio = "";
  for (let i = 0; i < TAMANHO_SORTEIO_CHAVE; i++) sorteio += _ALFABETO_CHAVE[randomInt(_ALFABETO_CHAVE.length)];
  return montar_chave(ano, sorteio);
}

/** Caixa alta e sem espaço. Não "conserta" caractere ambíguo. */
export function normalizar_chave(bruta: string | null | undefined): string {
  return (bruta ?? "").replace(/\s+/g, "").toUpperCase();
}

/** Formato E dígito verificador, sem tocar no banco. */
export function chave_valida(chave: string | null | undefined): boolean {
  const limpa = normalizar_chave(chave);
  if (!_RE_CHAVE.test(limpa)) return false;
  const [, ano, bloco1, bloco2, digito] = limpa.split("-");
  return digito_verificador(`${ano}${bloco1}${bloco2}`) === digito;
}

// =====================================================================
// O contexto congelado (RN-15 — §4 do desenho)
// =====================================================================
/** 'de 03 a 05 de março de 2026' — e só a data quando a turma dura um dia. */
function _periodo_extenso(inicio: string, fim: string): string {
  if (inicio === fim) return datas_br.por_extenso(inicio);
  const [a1, m1, d1] = datas_br.partes(inicio);
  const [a2, m2, d2] = datas_br.partes(fim);
  if (a1 === a2 && m1 === m2) {
    const mes = datas_br.MESES_ACENTUADOS[m1 - 1];
    return `de ${String(d1).padStart(2, "0")} a ${String(d2).padStart(2, "0")} de ${mes} de ${a1}`;
  }
  return `de ${datas_br.por_extenso(inicio)} a ${datas_br.por_extenso(fim)}`;
}

export interface InstrutorCongelado {
  nome?: string | null;
  titulo?: string | null;
  conselho?: string | null;
  registro?: string | null;
  rubrica_sha256?: string | null;
}

function _linha_do_instrutor(instrutor: InstrutorCongelado): string {
  const partes = [instrutor.nome || ""];
  if (instrutor.titulo) partes.push(instrutor.titulo);
  const registro = instrutor.registro || "";
  if (registro) partes.push(registro);
  return partes.filter((p) => p).join(" — ");
}

/** Os campos de `ContextoCertificado`. Datas 'AAAA-MM-DD'; decimais como texto. */
export interface DadosContextoCertificado {
  participante_nome: string;
  participante_identificador: string;
  participante_vinculo: string;
  participante_organizacao: string;
  participante_siape: string;
  participante_lotacao: string;
  treinamento_nome: string;
  treinamento_norma: string;
  treinamento_conteudo: string;
  validade_meses: number;
  turma_codigo: string;
  turma_data_inicio: string;
  turma_data_fim: string;
  carga_horaria: string;
  turma_local: string;
  turma_unidade_promotora: string;
  turma_campus: string;
  data_base_vencimento: string;
  nota_final: string | null;
  frequencia_percentual: string | null;
  nota_minima: string | null;
  frequencia_minima: string | null;
  instrutores: InstrutorCongelado[];
  numero: number;
  ano: number;
  data_emissao: string;
  chave_validacao: string;
  data_vencimento: string | null;
  url_validacao: string;
  setor_sigla: string;
  setor_nome: string;
  setor_endereco: string;
  cidade: string;
  modelo_id: number | null;
  modelo_arquivo: string;
  modelo_sha256: string | null;
  modelo_versao: number;
  mapa_tags: Record<string, string>;
  tags_obrigatorias?: readonly string[];
  avisos?: string[];
}

const CAMPOS_CONGELADOS = [
  "participante_nome", "participante_identificador", "participante_vinculo",
  "participante_organizacao", "participante_siape", "participante_lotacao",
  "treinamento_nome", "treinamento_norma", "treinamento_conteudo",
  "validade_meses", "turma_codigo", "turma_data_inicio", "turma_data_fim",
  "carga_horaria", "turma_local", "turma_unidade_promotora", "turma_campus",
  "data_base_vencimento", "nota_final", "frequencia_percentual",
  "nota_minima", "frequencia_minima", "instrutores", "numero", "ano",
  "data_emissao", "chave_validacao", "data_vencimento", "url_validacao",
  "setor_sigla", "setor_nome", "setor_endereco", "cidade", "modelo_id",
  "modelo_arquivo", "modelo_sha256", "modelo_versao", "mapa_tags",
  "tags_obrigatorias",
] as const;

const _DATAS = ["turma_data_inicio", "turma_data_fim", "data_base_vencimento", "data_emissao", "data_vencimento"] as const;
const _DECIMAIS = ["carga_horaria", "nota_final", "frequencia_percentual", "nota_minima", "frequencia_minima"] as const;

/**
 * Tudo o que o certificado renderiza, e nada mais. O que ficou **fora** ficou de
 * propósito: `situacao` e "está vencido hoje?" são estado, calculados na hora.
 */
export class ContextoCertificado implements DadosContextoCertificado {
  participante_nome!: string;
  participante_identificador!: string;
  participante_vinculo!: string;
  participante_organizacao!: string;
  participante_siape!: string;
  participante_lotacao!: string;
  treinamento_nome!: string;
  treinamento_norma!: string;
  treinamento_conteudo!: string;
  validade_meses!: number;
  turma_codigo!: string;
  turma_data_inicio!: string;
  turma_data_fim!: string;
  carga_horaria!: string;
  turma_local!: string;
  turma_unidade_promotora!: string;
  turma_campus!: string;
  data_base_vencimento!: string;
  nota_final!: string | null;
  frequencia_percentual!: string | null;
  nota_minima!: string | null;
  frequencia_minima!: string | null;
  instrutores!: InstrutorCongelado[];
  numero!: number;
  ano!: number;
  data_emissao!: string;
  chave_validacao!: string;
  data_vencimento!: string | null;
  url_validacao!: string;
  setor_sigla!: string;
  setor_nome!: string;
  setor_endereco!: string;
  cidade!: string;
  modelo_id!: number | null;
  modelo_arquivo!: string;
  modelo_sha256!: string | null;
  modelo_versao!: number;
  mapa_tags!: Record<string, string>;
  tags_obrigatorias: readonly string[] = [];
  avisos: string[] = [];

  static readonly CAMPOS_CONGELADOS = CAMPOS_CONGELADOS;

  constructor(d: DadosContextoCertificado) {
    Object.assign(this, d);
    this.tags_obrigatorias = [...(d.tags_obrigatorias ?? [])];
    this.avisos = [...(d.avisos ?? [])];
  }

  // ---- congelamento (RN-15) ---------------------------------------
  /**
   * Tudo o que o documento renderiza, pronto para guardar no certificado.
   * Data já é ISO e decimal já é texto: o que sai de `descongelar` tem o MESMO
   * tipo do que entrou.
   */
  congelar(): Record<string, unknown> {
    const dados: Record<string, unknown> = {};
    for (const campo of CAMPOS_CONGELADOS) {
      const v = (this as unknown as Record<string, unknown>)[campo];
      dados[campo] = v === undefined ? null : v;
    }
    for (const campo of _DATAS) dados[campo] = dados[campo] ? datas_br.comoData(dados[campo]) : null;
    for (const campo of _DECIMAIS) dados[campo] = dados[campo] !== null ? String(dados[campo]) : null;
    dados.instrutores = this.instrutores.map((i) => ({ ...i }));
    dados.mapa_tags = { ...this.mapa_tags };
    dados.tags_obrigatorias = [...this.tags_obrigatorias];
    return dados;
  }

  static descongelar(dados: Record<string, unknown>): ContextoCertificado {
    const valores: Record<string, unknown> = {};
    for (const campo of CAMPOS_CONGELADOS) valores[campo] = dados[campo] ?? null;
    for (const campo of _DATAS) valores[campo] = valores[campo] ? datas_br.comoData(valores[campo]) : null;
    for (const campo of _DECIMAIS) valores[campo] = valores[campo] !== null ? String(valores[campo]) : null;
    valores.tags_obrigatorias = [...((valores.tags_obrigatorias as string[] | null) ?? [])];
    valores.mapa_tags = { ...((valores.mapa_tags as Record<string, string> | null) ?? {}) };
    valores.instrutores = [...((valores.instrutores as InstrutorCongelado[] | null) ?? [])];
    return new ContextoCertificado(valores as unknown as DadosContextoCertificado);
  }

  // ---- leitura ----------------------------------------------------
  get rotulo(): string {
    return `${this.numero}/${this.ano}`;
  }

  /** O primeiro instrutor que assina (`assinante_*` é singular no vocabulário). */
  get assinante(): InstrutorCongelado {
    return this.instrutores[0] ?? {};
  }

  /**
   * `{marcador: valor}` — a montagem do contexto do modelo. O mapa vem do
   * CONGELADO (`this.mapa_tags`), nunca do modelo de hoje.
   */
  como_dicionario(): Record<string, unknown> {
    const saida: Record<string, unknown> = {};
    for (const [marcador, campo] of Object.entries(this.mapa_tags)) {
      saida[marcador] = CAMPOS_CERTIFICADO[exigir_campo(campo)]!.obter(this);
    }
    return saida;
  }

  /** Os marcadores `obrigatorio` que sairiam vazios no papel. */
  async obrigatorios_faltantes(): Promise<string[]> {
    const faltam: string[] = [];
    for (const marcador of this.tags_obrigatorias) {
      const campo = Object.hasOwn(this.mapa_tags, marcador) ? this.mapa_tags[marcador] : undefined;
      if (campo === undefined || !Object.hasOwn(CAMPOS_CERTIFICADO, campo)) {
        faltam.push(`${marcador} (campo desconhecido)`);
        continue;
      }
      if (!(await _tem_valor(CAMPOS_CERTIFICADO[campo]!.obter(this)))) {
        faltam.push(`${marcador} (${CAMPOS_CERTIFICADO[campo]!.rotulo})`);
      }
    }
    return faltam;
  }
}

async function _tem_valor(valor: unknown): Promise<boolean> {
  // imagem que não existe no armazenamento renderiza vazio: para o papel, é o
  // mesmo que não ter valor nenhum
  if (valor instanceof documento.ImagemEmLinha) return valor.existe();
  if (valor === null || valor === undefined) return false;
  if (typeof valor === "string") return Boolean(valor.trim());
  if (valor instanceof documento.RichText) return Boolean(String(valor).trim());
  return true;
}

// =====================================================================
// O vocabulário fechado
// =====================================================================
export interface CampoCertificado {
  rotulo: string;
  exemplo: string;
  grupo: string;
  obter: (c: ContextoCertificado) => unknown;
}

function _c(grupo: string, rotulo: string, exemplo: string, obter: (c: ContextoCertificado) => unknown): CampoCertificado {
  return Object.freeze({ rotulo, exemplo, grupo, obter });
}

/** Quebra de linha dentro de célula do .docx. Vazio vira "" e não null. */
function _rich(texto: string): unknown {
  return documento.rich_multilinha(texto) ?? "";
}

function _data(valor: string | null): string {
  return valor ? datas_br.numerica(valor) : "";
}

function _caminho_rubrica(sha256: string | null | undefined): unknown {
  if (!sha256) return "";
  return new documento.ImagemEmLinha({
    chave: anexos.chave_no_armazenamento(anexos.chave_do_blob(sha256)),
    largura_mm: LARGURA_RUBRICA_MM,
  });
}

// A ordem é a de leitura do documento, e é ela que a tela do modelo usa nos
// grupos do seletor.
export const CAMPOS_CERTIFICADO: Readonly<Record<string, CampoCertificado>> = Object.freeze({
  participante_nome: _c("Participante", "Nome do participante", "Maria Aparecida de Souza", (c) => c.participante_nome),
  participante_identificador: _c("Participante", "Identificador público", "PTC-7F3K9Q2M", (c) => c.participante_identificador),
  participante_vinculo: _c("Participante", "Vínculo", "Servidor", (c) => c.participante_vinculo),
  participante_organizacao: _c("Participante", "Organização de origem", "UFVJM", (c) => c.participante_organizacao),
  participante_siape: _c("Participante", "SIAPE (só servidor)", "1110654", (c) => c.participante_siape),
  participante_lotacao: _c(
    "Participante",
    "Lotação na data da turma",
    "Faculdade de Medicina de Diamantina",
    (c) => c.participante_lotacao,
  ),
  treinamento_nome: _c("Treinamento", "Nome do treinamento", "Trabalho em Altura (NR-35)", (c) => c.treinamento_nome),
  // a carga da TURMA, não a do catálogo: o certificado diz o que aconteceu
  treinamento_carga_horaria: _c("Treinamento", "Carga horária", "8 horas", (c) => `${numero_br(c.carga_horaria)} horas`),
  treinamento_conteudo: _c("Treinamento", "Conteúdo programático", "um tópico por linha", (c) =>
    _rich(c.treinamento_conteudo),
  ),
  treinamento_norma: _c("Treinamento", "Norma de referência", "NR-35", (c) => c.treinamento_norma),
  turma_data_inicio: _c("Turma", "Data de início", "03/03/2026", (c) => _data(c.turma_data_inicio)),
  turma_data_fim: _c("Turma", "Data de término", "05/03/2026", (c) => _data(c.turma_data_fim)),
  turma_periodo_extenso: _c("Turma", "Período por extenso", "de 03 a 05 de março de 2026", (c) =>
    _periodo_extenso(c.turma_data_inicio, c.turma_data_fim),
  ),
  turma_local: _c("Turma", "Local", "Auditório do Campus JK", (c) => c.turma_local),
  turma_unidade_promotora: _c(
    "Turma",
    "Unidade promotora",
    "Coordenadoria de Segurança e Saúde Ocupacional",
    (c) => c.turma_unidade_promotora,
  ),
  turma_instrutores: _c("Turma", "Instrutores", "um por linha", (c) =>
    _rich(c.instrutores.map(_linha_do_instrutor).join("\n")),
  ),
  certificado_numero: _c("Documento", "Número", "27", (c) => String(c.numero)),
  certificado_ano: _c("Documento", "Ano", "2026", (c) => String(c.ano)),
  certificado_rotulo: _c("Documento", "Número/ano", "27/2026", (c) => c.rotulo),
  certificado_data_emissao: _c("Documento", "Data de emissão", "12/03/2026", (c) => _data(c.data_emissao)),
  certificado_data_extenso: _c("Documento", "Data por extenso", "12 de março de 2026", (c) =>
    datas_br.por_extenso(c.data_emissao),
  ),
  certificado_chave: _c("Documento", "Chave de validação", "CSSO-2026-K7QMX-3FTB9-H", (c) => c.chave_validacao),
  // A IMAGEM do QR chega com a fatia 5 no Python; até lá o marcador rende vazio
  // em vez de imprimir a URL crua (estouraria o layout). Não marque esta tag
  // como obrigatória.
  certificado_qrcode: _c("Documento", "QR Code da validação", "imagem — chega na fatia 5", () => ""),
  certificado_url_validacao: _c(
    "Documento",
    "Endereço da validação",
    "https://.../validar/CSSO-2026-…",
    (c) => c.url_validacao,
  ),
  certificado_data_vencimento: _c(
    "Documento",
    "Vencimento",
    "12/03/2028 ou “não expira”",
    (c) => _data(c.data_vencimento) || SEM_VENCIMENTO,
  ),
  nota_final: _c("Resultado", "Nota final", "9,5", (c) => (c.nota_final !== null ? numero_br(c.nota_final) : "")),
  frequencia_percentual: _c("Resultado", "Frequência", "100%", (c) =>
    c.frequencia_percentual !== null ? `${numero_br(c.frequencia_percentual)}%` : "",
  ),
  assinante_nome: _c("Assinatura", "Nome do assinante", "Fabrício Raimundi Andrade", (c) => c.assinante.nome ?? ""),
  assinante_titulo: _c("Assinatura", "Título do assinante", "Eng. Seg. do Trabalho", (c) =>
    [c.assinante.titulo, c.assinante.registro].filter((p) => p).join(" — "),
  ),
  assinante_rubrica: _c("Assinatura", "Imagem da rubrica", "imagem do anexo", (c) =>
    _caminho_rubrica(c.assinante.rubrica_sha256),
  ),
  setor_emissor_nome: _c(
    "Emissor",
    "Nome extenso do setor",
    "Coordenadoria de Segurança e Saúde Ocupacional",
    (c) => c.setor_nome,
  ),
  setor_emissor_sigla: _c("Emissor", "Sigla composta", "CSSO/Sisa", (c) => c.setor_sigla),
  cidade: _c("Emissor", "Cidade", "Diamantina", (c) => c.cidade),
});

/** Agrupa o vocabulário para o seletor da tela do modelo: `[[grupo, [[codigo, campo]...]]...]`. */
export function campos_por_grupo(): [string, [string, CampoCertificado][]][] {
  const grupos = new Map<string, [string, CampoCertificado][]>();
  for (const [codigo, campo] of Object.entries(CAMPOS_CERTIFICADO)) {
    if (!grupos.has(campo.grupo)) grupos.set(campo.grupo, []);
    grupos.get(campo.grupo)!.push([codigo, campo]);
  }
  return [...grupos.entries()];
}

export function exigir_campo(codigo: string): string {
  if (!Object.hasOwn(CAMPOS_CERTIFICADO, codigo)) throw new CampoDesconhecido(codigo);
  return codigo;
}

// =====================================================================
// O arquivo do modelo
// =====================================================================
/**
 * O modelo mora em `modelos-docx/certificados/` (convertido de
 * `app/templates/certificados/`). Só o NOME, nunca um caminho: `../` aqui
 * deixaria a tela de modelos ler qualquer arquivo.
 */
export function caminho_modelo(arquivo: string): string {
  return path.join(documento.pasta_modelos(), DIR_MODELOS_CERTIFICADO, path.basename(arquivo));
}

function _manifesto(): Record<string, { sha256_origem: string; marcadores: string[] }> {
  const arquivo = path.join(documento.pasta_modelos(), "manifesto.json");
  return existsSync(arquivo) ? JSON.parse(readFileSync(arquivo, "utf8")) : {};
}

function _entrada_do_manifesto(arquivo: string) {
  return _manifesto()[`${DIR_MODELOS_CERTIFICADO}/${path.basename(arquivo)}`] ?? null;
}

/**
 * O SHA-256 do modelo de ORIGEM (o `.docx` que o setor edita), lido do
 * manifesto da conversão — o mesmo número que o Python gravava.
 */
export function sha256_do_modelo(arquivo: string): string | null {
  if (!existsSync(caminho_modelo(arquivo))) return null;
  const entrada = _entrada_do_manifesto(arquivo);
  if (entrada) return entrada.sha256_origem;
  return documento.sha256_arquivo(new Uint8Array(readFileSync(caminho_modelo(arquivo))));
}

/**
 * Os `{{ marcadores }}` que o .docx realmente tem, ou `null` quando o arquivo
 * não existe. DESVIO: lidos do `manifesto.json` da conversão (o docxtpl não
 * existe aqui); modelo que não passou por `ferramentas/converter-modelos-docx.ts`
 * aparece como "arquivo ausente".
 */
export function marcadores_do_arquivo(arquivo: string): Set<string> | null {
  if (!existsSync(caminho_modelo(arquivo))) return null;
  const entrada = _entrada_do_manifesto(arquivo);
  return entrada ? new Set(entrada.marcadores) : null;
}

/** O confronto entre o .docx e o dicionário de tags. */
export class ConferenciaDoModelo {
  constructor(
    readonly arquivo_encontrado: boolean,
    readonly marcadores: readonly string[] = [],
    readonly sem_mapa: readonly string[] = [],
    readonly sem_marcador: readonly string[] = [],
  ) {}
  get ok(): boolean {
    return this.arquivo_encontrado && this.sem_mapa.length === 0;
  }
}

const ordenar = (xs: Iterable<string>) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

export function conferir_modelo(arquivo: string, mapa: Record<string, string>): ConferenciaDoModelo {
  const marcadores = marcadores_do_arquivo(arquivo);
  if (marcadores === null) return new ConferenciaDoModelo(false);
  const chaves = new Set(Object.keys(mapa));
  return new ConferenciaDoModelo(
    true,
    ordenar(marcadores),
    ordenar([...marcadores].filter((m) => !chaves.has(m))),
    ordenar([...chaves].filter((m) => !marcadores.has(m))),
  );
}

// =====================================================================
// Render
// =====================================================================
/**
 * Rende o .docx do certificado a partir do contexto (congelado ou não), pelo
 * único lugar do sistema que abre um modelo (`documento.renderizar_modelo`).
 * `destino` é a chave no armazenamento.
 */
export function renderizar(contexto: ContextoCertificado, destino: string | null) {
  return documento.renderizar_modelo(contexto.modelo_arquivo, contexto.como_dicionario(), {
    destino,
    pasta: DIR_MODELOS_CERTIFICADO,
    dica:
      "Cadastre o .docx em app/templates/certificados/, rode " +
      "ferramentas/converter-modelos-docx.ts e confira o dicionário de tags em /treinamentos/modelos.",
  });
}
