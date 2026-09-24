/**
 * Normalizações textuais do domínio. Porte de `app/servicos/textos.py`.
 *
 * Regra transversal: nomes de posto, unidade, cargo e portaria são gravados
 * byte a byte como aparecem no documento de origem. O sistema NUNCA normaliza
 * caixa nesses campos. As funções abaixo são de *apresentação* e de
 * *comparação*, nunca de gravação.
 */
import { createHash } from "node:crypto";
import { RegraViolada } from "../nucleo/erros.js";

// ---------------------------------------------------------------------
// UORG
// ---------------------------------------------------------------------
const RE_UORG = /^\s*(\d+)\s*-\s*(.+?)\s*$/s;

function cased(c: string): boolean {
  return c.toLowerCase() !== c.toUpperCase();
}

/**
 * O `str.title()` do Python, fielmente: letra que vem depois de letra "com
 * caixa" vai para minúscula; qualquer outra vai para maiúscula. É ingênuo de
 * propósito ("De" capitalizado, "D'Agua"): o assinado imprime assim (CA-03).
 */
export function title_python(texto: string): string {
  let saida = "";
  let anteriorCased = false;
  for (const c of texto) {
    if (cased(c)) {
      saida += anteriorCased ? c.toLowerCase() : c.toUpperCase();
      anteriorCased = true;
    } else {
      saida += c;
      anteriorCased = false;
    }
  }
  return saida;
}

/**
 * '250 - FACULDADE DE MEDICINA DE DIAMANTINA'
 *   -> '250 - Faculdade De Medicina De Diamantina'
 *
 * Title case ingênuo, com o 'De' capitalizado. O assinado imprime assim —
 * reproduzir exatamente, não "melhorar" (CA-03).
 */
export function uorg_formatado(bruto: string | null | undefined): string {
  if (!bruto) return "";
  return title_python(String(bruto));
}

/** Extrai o código do prefixo '^(\d+)\s*-'. */
export function codigo_uorg(bruto: string | null | undefined): string | null {
  if (!bruto) return null;
  const m = RE_UORG.exec(String(bruto));
  return m ? m[1]! : null;
}

export function nome_uorg(bruto: string | null | undefined): string | null {
  if (!bruto) return null;
  const m = RE_UORG.exec(String(bruto));
  return m ? m[2]! : String(bruto).trim();
}

// ---------------------------------------------------------------------
// Aspas tipográficas
// ---------------------------------------------------------------------
/**
 * Converte aspas retas em curvas, alternando abre/fecha.
 * Aplicado uma vez, na entrada do catálogo — nunca a cada render.
 */
export function aspas_curvas(texto: string | null | undefined): string {
  if (!texto) return "";
  let saida = "";
  let abrindo = true;
  for (const ch of String(texto)) {
    if (ch === '"') {
      saida += abrindo ? "“" : "”";
      abrindo = !abrindo;
    } else {
      saida += ch;
    }
  }
  return saida;
}

// ---------------------------------------------------------------------
// Comparação / busca
// ---------------------------------------------------------------------
export function sem_acento(texto: string | null | undefined): string {
  if (!texto) return "";
  return String(texto).normalize("NFD").replace(/\p{Mn}/gu, "");
}

/** Minúscula, sem acento, espaços colapsados — para casar nomes. */
export function chave_busca(texto: string | null | undefined): string {
  return sem_acento(texto).toLowerCase().replace(/\s+/gu, " ").trim();
}

/**
 * Onze dígitos seguidos só podem ser uma coisa nesta casa — e ela não existe.
 *
 * O SIAPE tem sete, o protocolo de EPI tem prefixo, o NUP tem pontuação e o
 * número de laudo também. Sobra o CPF, que o sistema NÃO armazena (RN-21).
 * Isto é detecção, não recusa; mas a detecção é uma só, aqui.
 */
export function parece_cpf(bruto: string | null | undefined): boolean {
  const digitos = [...(bruto ?? "")].filter((c) => /\p{Nd}/u.test(c));
  return digitos.length === 11;
}

/**
 * Forma canônica de comparação do CA-01: TODO espaço em branco (inclusive a
 * quebra) é colapsado num único espaço — compara conteúdo, não diagramação.
 */
export function normalizar_fluxo(texto: string): string {
  return normalizar_para_ouro(texto).replace(/\s+/gu, " ").trim();
}

/** Normalização do CA-01: NFC + colapso de espaços + strip por linha. */
export function normalizar_para_ouro(texto: string): string {
  let t = texto.normalize("NFC");
  t = t.replaceAll(" ", " ").replaceAll("\x07", "\n").replaceAll("\r\n", "\n");
  const linhas = t.split("\n").map((linha) => strip_python(linha.replace(/[ \t]+/g, " ")));
  return linhas.filter((l) => l).join("\n");
}

/** `str.strip()` do Python (espaço em branco Unicode). */
function strip_python(s: string): string {
  return s.replace(/^[\s\x1c-\x1f\x85]+|[\s\x1c-\x1f\x85]+$/gu, "");
}

// ---------------------------------------------------------------------
// Nome de arquivo
// ---------------------------------------------------------------------
/**
 * 'Marco Antonio' -> 'Marco_Antonio'; 'Antônio' -> 'Antonio'.
 * Só o NOME DO ARQUIVO é ASCII; o conteúdo do documento mantém acento.
 */
export function slug_ascii(texto: string | null | undefined): string {
  let base = sem_acento(texto ?? "");
  base = base.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return base.replace(/_+/g, "_");
}

/**
 * Parecer_Tecnico_08-2026_SEST_Talita — número com padding de 2 no arquivo,
 * sem padding no documento (nº 8/2026).
 */
export function nome_arquivo_parecer(
  numero: number,
  ano: number,
  sigla: string,
  servidor: string | null | undefined,
): string {
  const partes = ["Parecer_Tecnico", `${String(numero).padStart(2, "0")}-${ano}`, slug_ascii(sigla.split("/")[0])];
  if (servidor) partes.push(slug_ascii(servidor));
  return partes.filter((p) => p).join("_");
}

// ---------------------------------------------------------------------
// RN-21 — dado de saúde é proibido em campo de texto livre
//
// A lista abaixo é a regra. A única flexão permitida está em
// DISPENSAS_POR_CONTEXTO, logo adiante, e vale por contexto declarado — nunca
// por frase.
// ---------------------------------------------------------------------
export const TERMOS_PROIBIDOS: readonly string[] = [
  "cid-10",
  "cid 10",
  "diagnostico",
  "diagnóstico",
  "atestado medico",
  "atestado médico",
  "gestante",
  "gestacao",
  "gestação",
  "gravidez",
  "gravida",
  "grávida",
  "lactante",
  "lactacao",
  "lactação",
  "doenca",
  "doença",
  "enfermidade",
  "cpf",
];

// Contextos de aplicação da RN-21 (ver o Python para o argumento inteiro): no
// parecer de adicional nada de saúde tem o que fazer; em Acidentes a Lei
// 8.112/90, art. 212, nomeia a espécie "doença relacionada ao trabalho". A
// dispensa é do CONTEXTO, não de uma frase, e o default é o mais restritivo.
export const CONTEXTO_PADRAO = "padrao";

// Vale só nos campos narrativos de `acidente_ocorrencia` e
// `acidente_investigacao`. NÃO vale em `acidente_decisao_pericial.observacao`.
export const CONTEXTO_NEXO_OCUPACIONAL = "nexo_ocupacional";

const DISPENSAS_POR_CONTEXTO: Record<string, readonly string[]> = {
  [CONTEXTO_PADRAO]: [],
  [CONTEXTO_NEXO_OCUPACIONAL]: ["doenca", "doença"],
};

/** Termo de saúde/dado sensível encontrado em campo de texto livre. */
export class TextoProibido extends RegraViolada {}

/**
 * Chaves de busca dispensadas no contexto. Contexto desconhecido é erro de
 * programação, e falha alto: um typo não pode virar filtro silenciosamente
 * diferente do que o autor quis.
 */
function dispensas_do_contexto(contexto: string): Set<string> {
  if (!Object.hasOwn(DISPENSAS_POR_CONTEXTO, contexto)) {
    const conhecidos = Object.keys(DISPENSAS_POR_CONTEXTO).sort().join(", ");
    throw new Error(`contexto de RN-21 desconhecido: '${contexto}'. Conhecidos: ${conhecidos}.`);
  }
  return new Set(DISPENSAS_POR_CONTEXTO[contexto]!.map((t) => chave_busca(t)));
}

function escapar_regex(s: string): string {
  // sem o `-`: fora de classe ele é literal, e `\-` é escape inválido no modo `u`
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function termos_proibidos_em(texto: string | null | undefined, contexto: string = CONTEXTO_PADRAO): string[] {
  const dispensadas = dispensas_do_contexto(contexto);
  if (!texto) return [];
  const alvo = chave_busca(texto);
  const achados = new Set<string>();
  for (const termo of TERMOS_PROIBIDOS) {
    const chave = chave_busca(termo);
    if (dispensadas.has(chave)) continue;
    // `\b` do Python em str é Unicode; o do JS é só ASCII — daí os lookarounds
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapar_regex(chave)}(?![\\p{L}\\p{N}_])`, "u");
    if (re.test(alvo)) achados.add(termo);
  }
  return [...achados].sort();
}

/**
 * Recusa o texto com dado de saúde dentro. `campo` é o RÓTULO DA TELA, nunca
 * o nome da coluna. A recusa diz a SAÍDA: descrever o agente e o ambiente.
 */
export function exigir_texto_limpo<T extends string | null | undefined>(
  texto: T,
  campo = "texto",
  contexto: string = CONTEXTO_PADRAO,
): T {
  const achados = termos_proibidos_em(texto, contexto);
  if (achados.length) {
    throw new TextoProibido(
      `O campo ${campo} contém termo proibido (${achados.join(", ")}). ` +
        "Estado de saúde, gestação, CID e diagnóstico não podem ser " +
        "registrados (RN-21; LGPD art. 11). Descreva o agente nocivo e o " +
        "ambiente de trabalho, não a pessoa — é isso que fundamenta o " +
        "adicional, e o texto sem o termo vale igual.",
    );
  }
  return texto;
}

// ---------------------------------------------------------------------
// Identificador opaco por sessão (RN-19)
// ---------------------------------------------------------------------
/** SRV-7f3a — nunca máscara parcial da matrícula. */
export function identificador_opaco(servidor_id: number | null | undefined, semente: string): string {
  const h = createHash("sha256").update(`${semente}:${servidor_id ?? "None"}`, "utf8").digest("hex");
  return `SRV-${h.slice(0, 4)}`;
}
