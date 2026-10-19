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

// Fora do parecer e do laudo — demanda, pedido de EPI, observação e comentário
// do processo — o termo de saúde é AVISO, e não recusa: "servidora gestante
// solicita afastamento de área insalubre" é o caso de rotina, e o texto sem a
// palavra não diz o que se pede. Quem escreve confirma que a menção é
// necessária, e a confirmação vai para a trilha. CPF e CID continuam recusados
// em todo contexto (`TERMOS_SEMPRE_PROIBIDOS`).
export const CONTEXTO_AVISO_SAUDE = "aviso_saude";

/** Identificador e código de doença: nem com confirmação. */
export const TERMOS_SEMPRE_PROIBIDOS: readonly string[] = ["cid-10", "cid 10", "cpf"];

const DISPENSAS_POR_CONTEXTO: Record<string, readonly string[]> = {
  [CONTEXTO_PADRAO]: [],
  [CONTEXTO_NEXO_OCUPACIONAL]: ["doenca", "doença"],
  [CONTEXTO_AVISO_SAUDE]: [],
};

/** Termo de saúde/dado sensível encontrado em campo de texto livre. */
export class TextoProibido extends RegraViolada {}

/**
 * Termo de saúde num campo onde ele é aviso: a tela devolve o formulário com a
 * caixa "confirmo que a menção é necessária". Herda de `TextoProibido` de
 * propósito — toda rota que já devolvia a recusa continua devolvendo.
 */
export class MencaoDeSaude extends TextoProibido {
  constructor(
    mensagem: string,
    public termos: string[],
  ) {
    super(mensagem);
  }
}

/** Os termos de saúde (os confirmáveis) que o texto traz. */
export function termos_de_saude_em(texto: string | null | undefined): string[] {
  const duros = new Set(TERMOS_SEMPRE_PROIBIDOS);
  return termos_proibidos_em(texto).filter((t) => !duros.has(t));
}

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
  mencao_confirmada = false,
): T {
  let achados = termos_proibidos_em(texto, contexto);
  if (contexto === CONTEXTO_AVISO_SAUDE && achados.length) {
    const duros = achados.filter((t) => TERMOS_SEMPRE_PROIBIDOS.includes(t));
    if (!duros.length) {
      if (mencao_confirmada) return texto;
      throw new MencaoDeSaude(
        `O campo ${campo} menciona dado de saúde (${achados.join(", ")}). ` +
          "Escreva só o necessário para o pedido — sem diagnóstico, CID ou " +
          "detalhe clínico (LGPD art. 11) — e marque “confirmo que a menção é " +
          "necessária” para gravar. A confirmação fica registrada na auditoria.",
        achados,
      );
    }
    achados = duros;
  }
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

// ---------------------------------------------------------------------
// CPF digitado em campo livre (revisão de privacidade, 25/09/2026)
// ---------------------------------------------------------------------
/**
 * O que fica no lugar do CPF. Nenhum dígito: o sistema não guarda CPF (RN-21;
 * ROPA §4.5), nem parcial — a máscara `***.456.789-**` do Portal da
 * Transparência guarda seis dígitos para desempatar homônimo publicado, e aqui
 * não há o que desempatar. O ROPA §6 já recusa máscara parcial de matrícula;
 * de CPF, com mais razão.
 */
export const CPF_MASCARADO = "***.***.***-**";

// 123.456.789-09 (e as variações sem um dos separadores). Os olhares em volta
// impedem casar dentro de número maior (NUP, chave de NF-e, CNPJ) e dentro de
// palavra — um SHA-256 em hexadecimal tem, de vez em quando, onze dígitos
// seguidos que "conferem", e hash não pode mudar um byte.
const RE_CPF = /(?<![\p{L}\p{N}_./-])(\d{3})(\.?)(\d{3})(\.?)(\d{3})(-?)(\d{2})(?![\p{L}\p{N}_])/gu;

/** Os dois dígitos verificadores do CPF conferem. */
export function cpf_valido(onze: string): boolean {
  if (!/^\d{11}$/.test(onze) || /^(\d)\1{10}$/.test(onze)) return false;
  const d = [...onze].map(Number);
  for (const n of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += d[i]! * (n + 1 - i);
    const dv = ((soma * 10) % 11) % 10;
    if (dv !== d[n]) return false;
  }
  return true;
}

/**
 * Troca todo CPF de dentro do texto por `CPF_MASCARADO`.
 *
 * - Com a pontuação inteira (`123.456.789-09`), mascara sempre, com dígito
 *   verificador certo ou não: a forma é inconfundível, e CPF digitado errado
 *   continua sendo CPF de alguém.
 * - Sem a pontuação inteira (`12345678909`, `123456789-09`), só quando os
 *   dígitos verificadores conferem — onze dígitos seguidos também são telefone
 *   com DDD, e a conferência erra 1 vez em 100 em vez de sempre.
 *
 * Por que mascarar em vez de recusar (a RN-21 do Python RECUSA a palavra
 * "cpf"): a recusa precisa de tela que devolva o formulário, e isso existe só
 * nos campos que a RN-21 já filtra. Esta proteção vale na ENTRADA de todo
 * formulário, de toda chamada da API e de toda importação, inclusive nos campos
 * que nunca tiveram filtro (observações, motivos, justificativas, nomes de
 * arquivo) — e ali a única saída que não perde o resto do texto é mascarar.
 * O Python não detectava o NÚMERO em lugar nenhum; ver DESVIOS.md.
 */
export function mascarar_cpf(texto: string): string {
  if (texto.length < 11) return texto;
  return texto.replace(RE_CPF, (inteiro, a, p1, b, p2, c, h, dv) => {
    const formatado = p1 === "." && p2 === "." && h === "-";
    return formatado || cpf_valido(`${a}${b}${c}${dv}`) ? CPF_MASCARADO : inteiro;
  });
}

/** `mascarar_cpf` em toda string de uma estrutura (corpo JSON, quadro do Trello). */
export function mascarar_cpf_em<T>(valor: T): T {
  if (typeof valor === "string") return mascarar_cpf(valor) as T;
  if (Array.isArray(valor)) return valor.map((v) => mascarar_cpf_em(v)) as T;
  if (valor && typeof valor === "object" && Object.getPrototypeOf(valor) === Object.prototype) {
    const saida: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(valor as Record<string, unknown>)) saida[k] = mascarar_cpf_em(v);
    return saida as T;
  }
  return valor;
}
