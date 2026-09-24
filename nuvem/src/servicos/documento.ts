/**
 * Geração do parecer técnico (e dos outros documentos) em .docx a partir do
 * modelo. Porte de `app/servicos/documento.py`.
 *
 * O parecer é um .docx de layout fixo com tabelas de células mescladas,
 * cabeçalho MEC/UFVJM com brasão e rodapé de duas colunas. Só o conteúdo
 * varia — o cabeçalho NUNCA é recriado por código.
 *
 * **O motor mudou, o modelo não.** O Python usava o docxtpl (Jinja2 dentro do
 * Word); aqui é o docxtemplater. Os modelos de `app/templates/*.docx` são
 * convertidos UMA vez por `ferramentas/converter-modelos-docx.ts` para
 * `modelos-docx/` (mesmo nome de arquivo), e o `manifesto.json` de lá guarda o
 * SHA-256 do modelo de ORIGEM — é ele que vai para `modelo_sha256`, para que o
 * parecer emitido na nuvem aponte a mesma versão de modelo que o Python
 * apontava. O que o docxtpl fazia depois do Jinja (quebra de linha, parágrafo
 * do RichText, imagem em linha) está em `docx_baixo_nivel.ts`.
 *
 * **Sem disco.** `renderizar_modelo` devolve os bytes; quando recebe
 * `destino`, grava no armazenamento (Supabase Storage / pasta local) com essa
 * chave — o `destino: Path` do Python.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";
import * as datas_br from "./datas_br.js";
import * as textos from "./textos.js";
import { obterArmazenamento } from "./armazenamento.js";
import {
  MARCA_IMAGEM_FIM,
  MARCA_IMAGEM_INICIO,
  MARCA_PARAGRAFO,
  embutir_imagens,
  extrair_texto_docx,
  partes_renderizaveis,
  preparar_imagem,
  resolver_listagem,
  type ImagemPronta,
} from "./docx_baixo_nivel.js";

export const MODELO_V1 = "modelo_parecer_v1.docx";
export const MODELO_V2 = "modelo_parecer_v2.docx";

export const CHAVES_RICHTEXT = [
  "posto_trabalho",
  "agente_nocivo",
  "fundamentacao_legal",
  "alteracao",
  "recomendacao_tecnica",
  "reavaliacao",
] as const;

/** RN-04 — a emissão lista o que falta, nunca falha em silêncio. */
export class DadosIncompletos extends Error {
  constructor(public faltantes: string[]) {
    super("Faltam dados obrigatorios: " + faltantes.join("; "));
  }
}

export class ExposicoesDivergentes extends Error {}

/** O `FileNotFoundError` do modelo ausente. */
export class ModeloNaoEncontrado extends Error {}

export function sha256_arquivo(conteudo: Uint8Array): string {
  return createHash("sha256").update(conteudo).digest("hex");
}

export function sha256_texto(texto: string): string {
  return createHash("sha256").update(texto, "utf8").digest("hex");
}

// ---------------------------------------------------------------------
// Onde moram os modelos convertidos
// ---------------------------------------------------------------------
/**
 * `modelos-docx/` — local em desenvolvimento, e junto do bundle na função do
 * Netlify (tem de estar em `included_files`, como `templates/`).
 */
export function pasta_modelos(): string {
  const candidatos = [
    process.env.CSSO_MODELOS_DOCX,
    path.resolve(process.cwd(), "modelos-docx"),
    path.resolve(process.cwd(), "nuvem/modelos-docx"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../modelos-docx"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../modelos-docx"),
  ].filter(Boolean) as string[];
  for (const c of candidatos) if (existsSync(path.join(c, MODELO_V1))) return c;
  return candidatos[0] ?? path.resolve(process.cwd(), "modelos-docx");
}

interface Manifesto {
  [arquivo: string]: { sha256_origem: string; sha256_convertido: string; marcadores: string[] };
}
let _manifesto: Manifesto | null = null;
function manifesto(): Manifesto {
  if (_manifesto) return _manifesto;
  const arquivo = path.join(pasta_modelos(), "manifesto.json");
  _manifesto = existsSync(arquivo) ? (JSON.parse(readFileSync(arquivo, "utf8")) as Manifesto) : {};
  return _manifesto;
}

/** O nome relativo do modelo (`pasta` é subpasta de `modelos-docx/`, ex. `certificados`). */
export function caminho_modelo(nome: string | null | undefined, pasta?: string | null): string {
  // só o NOME do arquivo é usado — `Path(...).name` na origem —, então a pasta
  // nunca vem de fora
  const arquivo = path.basename(nome || MODELO_V1);
  return pasta ? `${path.basename(pasta)}/${arquivo}` : arquivo;
}

// ---------------------------------------------------------------------
// RichText e imagem
// ---------------------------------------------------------------------
/**
 * O `RichText` do docxtpl, reduzido ao que o sistema usa: linhas separadas
 * por `\a` (parágrafo novo, com o mesmo pPr) dentro de uma célula.
 */
export class RichText {
  readonly partes: string[] = [];
  add(texto: string): this {
    this.partes.push(texto);
    return this;
  }
  /** O valor que atravessa o docxtemplater (o `\a` vira marcador). */
  paraModelo(): string {
    return this.partes.join("").replaceAll("\x07", MARCA_PARAGRAFO);
  }
  toString(): string {
    return this.partes.join("");
  }
}

/** Quebras de linha em célula: RichText com `\a` e `{{r chave }}`. */
function rich(valor: string | null | undefined): RichText | null {
  if (valor === null || valor === undefined) return null;
  const texto = String(valor).replaceAll("\r\n", "\n").replace(/\s+$/u, "");
  if (texto === "") return null;
  const rt = new RichText();
  texto.split("\n").forEach((linha, i) => {
    if (i) rt.add("\x07");
    rt.add(linha);
  });
  return rt;
}

/**
 * `rich` para os outros documentos do sistema (lista de presença,
 * comprovante de EPI, certificado).
 */
export function rich_multilinha(valor: string | null | undefined): RichText | null {
  return rich(valor);
}

/**
 * Uma imagem a embutir no documento, declarada sem depender do motor. No
 * Python era `caminho: Path`; aqui é a chave no armazenamento (ou os bytes).
 * Arquivo ausente vira string vazia, e não erro: rubrica que sumiu não pode
 * impedir a segunda via de um certificado que já circulou.
 */
export class ImagemEmLinha {
  readonly chave: string | null;
  readonly bytes: Uint8Array | null;
  readonly largura_mm: number | null;
  constructor(d: { chave?: string | null; bytes?: Uint8Array | null; largura_mm?: number | null }) {
    this.chave = d.chave ?? null;
    this.bytes = d.bytes ?? null;
    this.largura_mm = d.largura_mm ?? null;
    Object.freeze(this);
  }
  /** O `caminho.is_file()` do Python. */
  async existe(): Promise<boolean> {
    if (this.bytes) return true;
    if (!this.chave) return false;
    return obterArmazenamento().existe(this.chave);
  }
}

/**
 * O contexto como o docxtemplater o lê: RichText vira texto com marcador,
 * ImagemEmLinha vira marcador de imagem (ou "" quando o arquivo sumiu),
 * `null` vira "" (ver DESVIOS: o Jinja imprimiria "None").
 */
async function resolver_contexto(contexto: Record<string, unknown>, imagens: ImagemPronta[]): Promise<Record<string, unknown>> {
  const resolver = async (valor: unknown): Promise<unknown> => {
    if (valor instanceof RichText) return valor.paraModelo();
    if (valor instanceof ImagemEmLinha) {
      let bytes = valor.bytes;
      if (!bytes && valor.chave) {
        if (!(await obterArmazenamento().existe(valor.chave))) return "";
        bytes = await obterArmazenamento().ler(valor.chave);
      }
      if (!bytes) return "";
      imagens.push(preparar_imagem(bytes, valor.largura_mm));
      return `${MARCA_IMAGEM_INICIO}${imagens.length - 1}${MARCA_IMAGEM_FIM}`;
    }
    if (Array.isArray(valor)) return Promise.all(valor.map(resolver));
    if (valor && typeof valor === "object" && !(valor instanceof Date)) {
      const saida: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(valor)) saida[k] = await resolver(v);
      return saida;
    }
    if (valor === null || valor === undefined) return "";
    return valor;
  };
  return (await resolver(contexto)) as Record<string, unknown>;
}

export function primeira_maiuscula(texto: string | null | undefined): string {
  if (!texto) return "";
  const [p, ...resto] = [...texto];
  return p!.toUpperCase() + resto.join("");
}

// ---------------------------------------------------------------------
// Contexto
// ---------------------------------------------------------------------
export interface DadosContextoParecer {
  numero_parecer: number;
  ano: number;
  /** 'AAAA-MM-DD' */
  data_emissao: string;
  cidade: string;
  sigla_unidade_emissora: string;
  nome_extenso_emissor: string;
  endereco_emissor: string;
  telefone_emissor: string;
  laudo_de: string;
  unidade: string;
  postos: string[];
  uorg_bruto: string;
  tipo_laudo: string;
  numero_processo_sei: string;
  nome_servidor: string;
  matricula: string;
  cargo: string;
  funcao: string;
  laudo_siape: string;
  agentes_nocivos: string[];
  tipo_risco: string;
  percentual_aplicavel: string;
  portaria_localizacao: string;
  fundamentacao_legal: string;
  alteracao: string | null;
  recomendacao_tecnica: string;
  reavaliacao: string | null;
  pro_reitor: string;
  pro_reitor_cargo: string;
  tratamento_destinatario: string;
  assinante_nome: string;
  assinante_matricula: string;
  assinante_titulo: string;
  data_extenso_capitalizado?: boolean;
  avisos?: string[];
}

/** Tudo o que o modelo precisa. Montado a partir do banco ou dos testes. */
export class ContextoParecer implements DadosContextoParecer {
  numero_parecer!: number;
  ano!: number;
  data_emissao!: string;
  cidade!: string;
  sigla_unidade_emissora!: string;
  nome_extenso_emissor!: string;
  endereco_emissor!: string;
  telefone_emissor!: string;
  laudo_de!: string;
  unidade!: string;
  postos!: string[];
  uorg_bruto!: string;
  tipo_laudo!: string;
  numero_processo_sei!: string;
  nome_servidor!: string;
  matricula!: string;
  cargo!: string;
  funcao!: string;
  laudo_siape!: string;
  agentes_nocivos!: string[];
  tipo_risco!: string;
  percentual_aplicavel!: string;
  portaria_localizacao!: string;
  fundamentacao_legal!: string;
  alteracao!: string | null;
  recomendacao_tecnica!: string;
  reavaliacao!: string | null;
  pro_reitor!: string;
  pro_reitor_cargo!: string;
  tratamento_destinatario!: string;
  assinante_nome!: string;
  assinante_matricula!: string;
  assinante_titulo!: string;
  data_extenso_capitalizado = false;
  avisos: string[] = [];

  constructor(d: DadosContextoParecer) {
    Object.assign(this, d);
    this.data_extenso_capitalizado = d.data_extenso_capitalizado ?? false;
    this.avisos = d.avisos ?? [];
  }

  // ---- congelamento (RN-15) ---------------------------------------
  static readonly CAMPOS_CONGELADOS = [
    "numero_parecer", "ano", "data_emissao", "cidade", "sigla_unidade_emissora",
    "nome_extenso_emissor", "endereco_emissor", "telefone_emissor", "laudo_de",
    "unidade", "postos", "uorg_bruto", "tipo_laudo", "numero_processo_sei",
    "nome_servidor", "matricula", "cargo", "funcao", "laudo_siape",
    "agentes_nocivos", "tipo_risco", "percentual_aplicavel",
    "portaria_localizacao", "fundamentacao_legal", "alteracao",
    "recomendacao_tecnica", "reavaliacao", "pro_reitor", "pro_reitor_cargo",
    "tratamento_destinatario", "assinante_nome", "assinante_matricula",
    "assinante_titulo", "data_extenso_capitalizado",
  ] as const;

  /** Tudo o que o documento renderiza, pronto para guardar no parecer. */
  congelar(): Record<string, unknown> {
    const dados: Record<string, unknown> = {};
    for (const campo of ContextoParecer.CAMPOS_CONGELADOS) {
      const v = this[campo];
      dados[campo] = Array.isArray(v) ? [...v] : v;
    }
    // a data já é 'AAAA-MM-DD' (o `isoformat()` do Python)
    dados.data_emissao = datas_br.comoData(this.data_emissao);
    return dados;
  }

  static descongelar(dados: Record<string, unknown>): ContextoParecer {
    const valores: Record<string, unknown> = {};
    for (const k of ContextoParecer.CAMPOS_CONGELADOS) {
      if (!(k in dados)) throw new Error(`campo congelado ausente: ${k}`); // o KeyError do Python
      valores[k] = dados[k];
    }
    valores.data_emissao = datas_br.comoData(valores.data_emissao);
    return new ContextoParecer(valores as unknown as DadosContextoParecer);
  }

  obrigatorios_faltantes(): string[] {
    const exigidos: [keyof DadosContextoParecer, string][] = [
      ["nome_servidor", "nome do servidor"],
      ["matricula", "matricula SIAPE"],
      ["unidade", "unidade / UORG"],
      ["numero_processo_sei", "numero do processo (NUP)"],
      ["laudo_siape", "laudo tecnico"],
      ["percentual_aplicavel", "percentual aplicavel"],
      ["portaria_localizacao", "portaria de localizacao"],
      ["recomendacao_tecnica", "recomendacao"],
      ["assinante_nome", "signatario"],
      ["pro_reitor", "autoridade destinataria"],
      ["tipo_risco", "tipo de risco"],
      ["fundamentacao_legal", "fundamentacao legal"],
    ];
    const faltantes = exigidos.filter(([campo]) => !this[campo]).map(([, rotulo]) => rotulo);
    if (!this.agentes_nocivos?.length) faltantes.push("agente nocivo");
    if (!this.postos?.length) faltantes.push("posto de trabalho");
    return faltantes;
  }

  como_dicionario(): Record<string, unknown> {
    const data_txt = this.data_extenso_capitalizado
      ? datas_br.por_extenso_capitalizado(this.data_emissao)
      : datas_br.por_extenso(this.data_emissao);
    return {
      numero_parecer: String(this.numero_parecer),
      ano: String(this.ano),
      data_extenso: data_txt,
      cidade: this.cidade,
      sigla_unidade_emissora: this.sigla_unidade_emissora,
      nome_extenso_emissor: this.nome_extenso_emissor,
      endereco_emissor: this.endereco_emissor,
      telefone_emissor: this.telefone_emissor,
      laudo_de: this.laudo_de,
      unidade: primeira_maiuscula(this.unidade),
      posto_trabalho: rich(this.postos.join("\n")),
      uorg_formatado: textos.uorg_formatado(this.uorg_bruto),
      tipo_laudo: this.tipo_laudo,
      numero_processo_sei: this.numero_processo_sei,
      nome_servidor: this.nome_servidor,
      matricula: this.matricula,
      cargo: this.cargo,
      funcao: this.funcao || "",
      laudo_siape: this.laudo_siape,
      agente_nocivo: rich(this.agentes_nocivos.join("\n")),
      tipo_risco: this.tipo_risco,
      percentual_aplicavel: this.percentual_aplicavel,
      portaria_localizacao: this.portaria_localizacao,
      fundamentacao_legal: rich(this.fundamentacao_legal),
      alteracao: rich(this.alteracao),
      recomendacao_tecnica: rich(this.recomendacao_tecnica),
      reavaliacao: rich(this.reavaliacao),
      pro_reitor: this.pro_reitor,
      pro_reitor_cargo: this.pro_reitor_cargo,
      tratamento_destinatario: this.tratamento_destinatario,
      assinante_nome: this.assinante_nome,
      assinante_matricula: this.assinante_matricula,
      assinante_titulo: this.assinante_titulo,
      // artefato de mala direta que sobrou no rodapé: sempre vazio
      data_solicitacao_sest_rodape: "",
    };
  }
}

// ---------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------
export interface DocumentoRenderizado {
  /** o .docx pronto */
  bytes: Uint8Array;
  /** a chave no armazenamento, quando `destino` foi pedido (o `destino` do Python) */
  arquivo: string | null;
  modelo_arquivo: string;
  modelo_sha256: string;
  hash_conteudo: string;
}

/** Os bytes do modelo convertido e o SHA-256 que o identifica. */
export function carregar_modelo(
  modelo: string | null | undefined,
  opcoes: { pasta?: string | null; dica?: string } = {},
): { bytes: Uint8Array; arquivo: string; sha256: string } {
  const relativo = caminho_modelo(modelo, opcoes.pasta);
  const absoluto = path.join(pasta_modelos(), relativo);
  if (!existsSync(absoluto)) {
    throw new ModeloNaoEncontrado(
      `modelo ${path.basename(relativo)} nao encontrado em ${path.dirname(absoluto)}.` +
        (opcoes.dica ? ` ${opcoes.dica}` : ""),
    );
  }
  const bytes = new Uint8Array(readFileSync(absoluto));
  // o SHA-256 do modelo de ORIGEM (docxtpl), o mesmo que o Python registrava
  const sha256 = manifesto()[relativo]?.sha256_origem ?? sha256_arquivo(bytes);
  return { bytes, arquivo: path.basename(relativo), sha256 };
}

/**
 * Rende um .docx de `modelos-docx/` e devolve as impressões digitais.
 *
 * É o único lugar do sistema que abre um modelo e gera um documento: a lista
 * de presença e o certificado passam por aqui — dois mecanismos de documento
 * seriam dois lugares para o hash de integridade divergir.
 */
export async function renderizar_modelo(
  modelo: string | null | undefined,
  contexto: Record<string, unknown>,
  opcoes: { destino?: string | null; dica?: string; pasta?: string | null } = {},
): Promise<DocumentoRenderizado> {
  const origem = carregar_modelo(modelo, opcoes);
  const bytes = await renderizar_bytes(origem.bytes, contexto);
  if (opcoes.destino) {
    await obterArmazenamento().gravar(
      opcoes.destino,
      bytes,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  }
  return {
    bytes,
    arquivo: opcoes.destino ?? null,
    modelo_arquivo: origem.arquivo,
    modelo_sha256: origem.sha256,
    hash_conteudo: sha256_texto(extrair_texto(bytes)),
  };
}

/** O render em si, sobre os bytes de um modelo JÁ convertido. */
export async function renderizar_bytes(modelo: Uint8Array, contexto: Record<string, unknown>): Promise<Uint8Array> {
  const imagens: ImagemPronta[] = [];
  const dados = await resolver_contexto(contexto, imagens);
  const zip = new PizZip(modelo);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    // variável ausente sai vazia, como o `Undefined` do Jinja
    nullGetter: () => "",
  });
  doc.render(dados);
  const saida = doc.getZip() as PizZip;
  for (const parte of partes_renderizaveis(saida)) {
    const xml = saida.file(parte)!.asText();
    const resolvido = resolver_listagem(xml);
    if (resolvido !== xml) saida.file(parte, resolvido);
    embutir_imagens(saida, parte, imagens);
  }
  return saida.generate({ type: "uint8array", compression: "DEFLATE" });
}

export async function renderizar(
  contexto: ContextoParecer,
  destino: string | null = null,
  modelo: string | null = null,
  validar = true,
): Promise<DocumentoRenderizado> {
  if (validar) {
    const faltantes = contexto.obrigatorios_faltantes();
    if (faltantes.length) throw new DadosIncompletos(faltantes);
  }
  return renderizar_modelo(modelo, contexto.como_dicionario(), {
    destino,
    dica: "Rode ferramentas/converter-modelos-docx.ts.",
  });
}

// ---------------------------------------------------------------------
// Extração de texto (CA-01)
// ---------------------------------------------------------------------
/** Corpo (parágrafos + células) + header + footer, nesta ordem. */
export function extrair_texto(docx: Uint8Array): string {
  return extrair_texto_docx(docx);
}

export function texto_normalizado(docx: Uint8Array): string {
  return textos.normalizar_para_ouro(extrair_texto(docx));
}

// ---------------------------------------------------------------------
// Nomes de arquivo
// ---------------------------------------------------------------------
/** A chave do documento no armazenamento: `documentos/<ano>/<nome>.<ext>`. */
export function caminho_saida(
  numero: number,
  ano: number,
  sigla: string,
  servidor: string | null | undefined,
  extensao = "docx",
): string {
  return `documentos/${ano}/${textos.nome_arquivo_parecer(numero, ano, sigla, servidor)}.${extensao}`;
}
