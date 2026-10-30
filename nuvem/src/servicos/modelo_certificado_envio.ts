/**
 * NUVEM: o modelo de certificado enviado pela tela (não existe no Python, onde
 * o .docx ia para `app/templates/certificados/` pela mão de quem programa).
 *
 * O .docx chega como o setor o escreveu no Word, com marcadores em dois
 * formatos:
 *
 * - `{{ nome_do_aluno }}` — o formato do sistema (o do manual);
 * - `«NOME COMPLETO DO PARTICIPANTE»` — texto livre entre aspas angulares,
 *   como nos modelos que o setor já usava para preencher à mão.
 *
 * O Word parte um mesmo marcador em vários `<w:r>` (corretor ortográfico,
 * formatação, histórico de edição); a leitura junta o texto do parágrafo antes
 * de procurar. A conversão grava um .docx com `{marcador}` (a sintaxe do
 * docxtemplater, a mesma dos modelos embutidos), e é ESSE arquivo que vai para
 * o armazenamento e que a emissão abre.
 *
 * **Nome de cada «»: uma ocorrência, um marcador.** O mesmo texto pode
 * significar coisas diferentes no mesmo documento («000.000.000-00» é o CPF do
 * participante e, linhas abaixo, o do responsável; «DD/MM/AAAA» é o início e o
 * fim). Então cada ocorrência vira um marcador próprio: a primeira leva o nome
 * do texto (`dd_mm_aaaa`), as seguintes ganham `_2`, `_3`… na ordem do
 * documento — o mesmo vale para textos diferentes que dariam o mesmo nome
 * («cidade» e «Cidade»). A tela mostra um trecho do texto ao redor de cada um
 * para o usuário saber qual é qual. `{{ x }}` repetido continua sendo um
 * marcador só: ali o nome foi escolhido de propósito.
 */
import PizZip from "pizzip";
import type { ArquivoEnviado, MarcadorDoModelo } from "../dominio/treinamento.js";
import { RegraViolada } from "../nucleo/erros.js";
import * as anexos from "./anexos.js";
import { partes_renderizaveis } from "./docx_baixo_nivel.js";
import { slug_ascii, sem_acento } from "./textos.js";

/**
 * O mesmo teto do anexo (4 MB): a função do Netlify recebe no máximo 6 MB de
 * corpo, ≈4,5 MB de binário depois da codificação do multipart.
 */
export const LIMITE_BYTES = anexos.LIMITE_BYTES;
// o .docx descompactado: acima disso é bomba de zip, não certificado
const LIMITE_DESCOMPACTADO = 60 * 1024 * 1024;
// o nome do marcador cabe em `certificado_modelo_tag.marcador` (60) com folga para o sufixo
const TAMANHO_NOME = 40;
const CONTEXTO = 60;

export const TIPO_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Recusa com mensagem para quem não programa. */
export class ModeloInvalido extends RegraViolada {}

export interface DocxConvertido {
  bytes: Uint8Array;
  marcadores: MarcadorDoModelo[];
}

// =====================================================================
// Leitura do XML: o texto de cada `<w:t>`, com os parágrafos separados
// =====================================================================
interface Pedaco {
  // posição do texto do <w:t> no XML (sem as marcas)
  ini_xml: number;
  fim_xml: number;
  abertura_ini: number;
  abertura: string;
  texto: string;
  // posição do texto no texto corrido da parte
  pos: number;
}

const ENTIDADES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodificar(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e: string) => {
    if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(Number(e.slice(1)));
    return ENTIDADES[e] ?? m;
  });
}

function codificar(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * O texto corrido da parte: parágrafo vira `\n` e tabulação/quebra vira
 * espaço — nenhum dos dois pertence a um `<w:t>`, então marcador que atravessa
 * parágrafo não é marcador.
 */
function ler_parte(xml: string): { pedacos: Pedaco[]; texto: string } {
  const pedacos: Pedaco[] = [];
  let texto = "";
  const re = /(<w:t(?:\s[^>]*)?>)([^<]*)<\/w:t>|<w:p(?:\s[^>]*)?\/?>|<\/w:p>|<w:(?:tab|br|cr)\b[^>]*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (m[1] !== undefined) {
      const t = decodificar(m[2]!);
      const ini = m.index + m[1].length;
      pedacos.push({ ini_xml: ini, fim_xml: ini + m[2]!.length, abertura_ini: m.index, abertura: m[1], texto: t, pos: texto.length });
      texto += t;
    } else if (m[0].startsWith("<w:p") || m[0] === "</w:p>") {
      if (!texto.endsWith("\n")) texto += "\n";
    } else {
      texto += " ";
    }
  }
  return { pedacos, texto };
}

interface Achado {
  ini: number;
  fim: number;
  tipo: "livre" | "sistema";
  conteudo: string;
}

function achar(texto: string): Achado[] {
  const achados: Achado[] = [];
  const re = /«([^«»\n]{1,200})»|\{\{([^{}\n]{0,200})\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto))) {
    if (m[1] !== undefined) achados.push({ ini: m.index, fim: m.index + m[0].length, tipo: "livre", conteudo: m[1] });
    else achados.push({ ini: m.index, fim: m.index + m[0].length, tipo: "sistema", conteudo: m[2]! });
  }
  return achados;
}

/** Troca cada achado pelo seu `{marcador}`: o texto vai inteiro para o primeiro `<w:t>`. */
function reescrever(xml: string, pedacos: Pedaco[], trocas: { ini: number; fim: number; por: string }[]): string {
  // edições por pedaço, em coordenadas do próprio pedaço
  const edicoes = new Map<number, { ini: number; fim: number; por: string }[]>();
  const anotar = (i: number, e: { ini: number; fim: number; por: string }) => {
    if (!edicoes.has(i)) edicoes.set(i, []);
    edicoes.get(i)!.push(e);
  };
  for (const troca of trocas) {
    let primeiro = true;
    pedacos.forEach((p, i) => {
      const p_fim = p.pos + p.texto.length;
      if (p_fim <= troca.ini || p.pos >= troca.fim) return;
      const ini = Math.max(troca.ini, p.pos) - p.pos;
      const fim = Math.min(troca.fim, p_fim) - p.pos;
      anotar(i, { ini, fim, por: primeiro ? troca.por : "" });
      primeiro = false;
    });
  }
  let saida = "";
  let cursor = 0;
  pedacos.forEach((p, i) => {
    const lista = edicoes.get(i);
    if (!lista) return;
    let novo = "";
    let c = 0;
    for (const e of lista.sort((a, b) => a.ini - b.ini)) {
      novo += p.texto.slice(c, e.ini) + e.por;
      c = e.fim;
    }
    novo += p.texto.slice(c);
    // o texto mexido pode começar ou acabar em espaço: o Word só o guarda com `preserve`
    saida += xml.slice(cursor, p.abertura_ini) + '<w:t xml:space="preserve">' + codificar(novo);
    cursor = p.fim_xml;
  });
  return saida + xml.slice(cursor);
}

function trecho(texto: string, ini: number, fim: number): [string, string] {
  const limpar = (s: string) =>
    s
      .replace(/\s*\n\s*/g, " / ")
      .replace(/[ \t]+/g, " ")
      .replace(/^[\s/]+|[\s/]+$/g, "");
  const a0 = Math.max(0, ini - CONTEXTO);
  const d1 = Math.min(texto.length, fim + CONTEXTO);
  let antes = limpar(texto.slice(a0, ini));
  let depois = limpar(texto.slice(fim, d1));
  if (a0 > 0 && antes) antes = "…" + antes;
  if (d1 < texto.length && depois) depois = depois + "…";
  return [antes, depois];
}

/** `«NOME COMPLETO»` -> `nome_completo`; nunca vazio, nunca começando por dígito. */
export function nome_do_marcador(rotulo: string): string {
  let base = slug_ascii(rotulo).toLowerCase();
  if (!base) base = "campo";
  if (/^\d/.test(base)) base = `campo_${base}`;
  return base.slice(0, TAMANHO_NOME).replace(/_+$/, "");
}

const NOME_SISTEMA = /^[A-Za-z_][A-Za-z0-9_]*$/;

// o documento primeiro, depois cabeçalhos e rodapés: é a "ordem do documento" das ocorrências
function ordem_das_partes(zip: PizZip): string[] {
  const peso = (n: string) => (n === "word/document.xml" ? 0 : n.includes("header") ? 1 : n.includes("footer") ? 2 : 3);
  return partes_renderizaveis(zip).sort((a, b) => peso(a) - peso(b) || (a < b ? -1 : 1));
}

// =====================================================================
// O arquivo enviado
// =====================================================================
/** Abre o .docx, ou recusa dizendo por quê. */
export function abrir_docx(bytes: Uint8Array): PizZip {
  if (!bytes.length) throw new ModeloInvalido("O arquivo está vazio.");
  if (bytes.length > LIMITE_BYTES) {
    throw new ModeloInvalido(
      `O arquivo tem ${(bytes.length / 1024 / 1024).toFixed(1).replace(".", ",")} MB e o limite é ` +
        `${LIMITE_BYTES / 1024 / 1024} MB. Diminua as imagens no Word (Arquivo › Compactar imagens) e envie de novo.`,
    );
  }
  let zip: PizZip;
  try {
    zip = new PizZip(bytes);
  } catch {
    throw new ModeloInvalido("O arquivo não é um documento do Word (.docx). Abra-o no Word e use “Salvar como” › Documento do Word (.docx).");
  }
  if (!zip.files["word/document.xml"] || !zip.files["[Content_Types].xml"]) {
    throw new ModeloInvalido("O arquivo não é um documento do Word (.docx). Abra-o no Word e use “Salvar como” › Documento do Word (.docx).");
  }
  const tipos = zip.files["[Content_Types].xml"]!.asText();
  if (/macroEnabled|vbaProject/i.test(tipos)) {
    throw new ModeloInvalido("O documento tem macros (.docm). Salve como Documento do Word (.docx), sem macros, e envie de novo.");
  }
  let total = 0;
  for (const f of Object.values(zip.files)) {
    total += (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
  }
  if (total > LIMITE_DESCOMPACTADO) throw new ModeloInvalido("O documento é grande demais para ser um modelo de certificado.");
  return zip;
}

/**
 * Lê os marcadores e devolve o .docx com `{marcador}` no lugar de cada um.
 * Recusa (com o trecho) o que a emissão não conseguiria preencher.
 */
export function converter_docx_enviado(bytes: Uint8Array): DocxConvertido {
  const zip = abrir_docx(bytes);
  const partes = ordem_das_partes(zip).map((nome) => {
    const xml = zip.file(nome)!.asText();
    return { nome, xml, ...ler_parte(xml) };
  });

  for (const p of partes) {
    if (/\{%|%\}/.test(p.texto)) {
      throw new ModeloInvalido(
        "O documento usa comandos entre {% e %}, que o envio pela tela não aceita. " +
          "Use só marcadores como {{ nome }} ou «texto».",
      );
    }
  }

  // os nomes do sistema ({{ x }}) ficam reservados antes de dar nome aos «»
  const usados = new Set<string>();
  for (const p of partes) {
    for (const a of achar(p.texto)) {
      if (a.tipo === "sistema" && NOME_SISTEMA.test(a.conteudo.trim())) usados.add(a.conteudo.trim());
    }
  }

  const marcadores: MarcadorDoModelo[] = [];
  const vistos_sistema = new Set<string>();
  const contagem = new Map<string, number>();
  for (const p of partes) {
    const trocas: { ini: number; fim: number; por: string }[] = [];
    for (const a of achar(p.texto)) {
      const [antes, depois] = trecho(p.texto, a.ini, a.fim);
      if (a.tipo === "sistema") {
        const nome = a.conteudo.trim();
        if (!NOME_SISTEMA.test(nome)) {
          throw new ModeloInvalido(
            `O marcador “{{${a.conteudo}}}” não é um nome válido: use letras sem acento, números e “_”, ` +
              "começando por letra (ex.: {{ nome_do_participante }}), ou escreva o texto entre « e ».",
          );
        }
        trocas.push({ ini: a.ini, fim: a.fim, por: `{${nome}}` });
        if (!vistos_sistema.has(nome)) {
          vistos_sistema.add(nome);
          marcadores.push({ marcador: nome, rotulo: nome, antes, depois, ocorrencia: 1 });
        }
        continue;
      }
      const rotulo = a.conteudo.replace(/\s+/g, " ").trim();
      const base = nome_do_marcador(rotulo);
      let n = contagem.get(base) ?? 0;
      let nome: string;
      do {
        n += 1;
        nome = n === 1 ? base : `${base}_${n}`;
      } while (usados.has(nome));
      contagem.set(base, n);
      usados.add(nome);
      trocas.push({ ini: a.ini, fim: a.fim, por: `{${nome}}` });
      marcadores.push({ marcador: nome, rotulo: rotulo || a.conteudo, antes, depois, ocorrencia: n });
    }
    if (trocas.length) {
      const novo = reescrever(p.xml, p.pedacos, trocas);
      zip.file(p.nome, novo);
      p.xml = novo;
    }
  }

  // o que sobrou de chave no texto seria lido como marcador pelo motor do documento
  const nomes = new Set(marcadores.map((m) => m.marcador));
  for (const p of partes) {
    const { texto } = ler_parte(p.xml);
    const resto = texto.replace(/\{([A-Za-z_]\w*)\}/g, (m, n: string) => (nomes.has(n) ? "" : m));
    const solta = /[{}]/.exec(resto);
    if (solta) {
      const [antes, depois] = trecho(resto, solta.index, solta.index + 1);
      throw new ModeloInvalido(
        `O texto do documento tem uma chave “${solta[0]}” fora de um marcador, perto de “${antes} ${solta[0]} ${depois}”. ` +
          "Troque-a por parênteses no Word, ou escreva o marcador inteiro, como {{ nome }} ou «texto».",
      );
    }
  }

  if (!marcadores.length) {
    throw new ModeloInvalido(
      "Não achei nenhum marcador no documento. Escreva, no lugar de cada dado, o texto entre « e » " +
        "(ex.: «NOME DO PARTICIPANTE») ou o nome entre chaves duplas (ex.: {{ participante_nome }}).",
    );
  }

  return { bytes: zip.generate({ type: "uint8array", compression: "DEFLATE" }), marcadores };
}

/** O que vai para `certificado_modelo.arquivo_enviado`, e os bytes a gravar. */
export function preparar_envio(bytes: Uint8Array): { convertido: Uint8Array; enviado: ArquivoEnviado; sha256_origem: string } {
  const { bytes: convertido, marcadores } = converter_docx_enviado(bytes);
  return {
    convertido,
    sha256_origem: anexos.digerir(bytes),
    enviado: { sha256_convertido: anexos.digerir(convertido), tamanho: bytes.length, marcadores },
  };
}

/** O nome que aparece na tela: só o nome, sem pasta, até 120 caracteres. */
export function nome_do_arquivo(nome: string | null | undefined): string {
  const base = (nome ?? "").split(/[\\/]/).pop()!.replace(/[\x00-\x1f]/g, "").trim() || "modelo.docx";
  if (base.length <= 120) return base;
  return base.slice(0, 115) + ".docx";
}

/**
 * Onde o .docx convertido mora: o MESMO endereçamento do blob de anexo
 * (`anexos/ab/abc...`), para entrar no backup e na restauração junto com os
 * anexos (`backup._chaves_de_arquivo`). Endereçado pelo conteúdo, não colide.
 */
export function chave_no_armazenamento(sha256_convertido: string): string {
  return anexos.chave_no_armazenamento(anexos.chave_do_blob(sha256_convertido));
}

// =====================================================================
// Sugestão de campo
// =====================================================================
export interface CampoSugerivel {
  rotulo: string;
}

const PALAVRAS_VAZIAS = new Set([
  "de", "do", "da", "dos", "das", "o", "a", "os", "as", "e", "em", "no", "na", "nos", "nas", "com",
  "por", "para", "pelo", "pela", "ou", "um", "uma", "completo", "completa", "ao", "que", "qual", "houve",
]);

function normalizar(s: string): string {
  return sem_acento(s).toLowerCase();
}

function palavras(s: string): string[] {
  return normalizar(s)
    .split(/[^a-z0-9]+/)
    .filter((p) => p.length >= 2 && !PALAVRAS_VAZIAS.has(p));
}

/** O primeiro código do vocabulário que passa no teste (ou null). */
function primeiro(campos: Readonly<Record<string, CampoSugerivel>>, teste: (codigo: string) => boolean): string | null {
  return Object.keys(campos).find(teste) ?? null;
}

/**
 * O campo que provavelmente alimenta o marcador, ou null. Três passos, do mais
 * certo ao mais solto:
 *
 * 1. o nome do marcador é um código do vocabulário, ou está em `mapa_sugerido`
 *    (o dicionário do layout padrão) — com ou sem o `_2`;
 * 2. regras pelo texto do marcador e, para os que nada dizem («___ %»,
 *    «000.000.000-00»), pelo texto logo antes dele; datas repetidas seguem a
 *    ocorrência (1ª = início, 2ª = fim);
 * 3. semelhança de palavras com o rótulo e o código de cada campo — é o que faz
 *    um campo novo do vocabulário ganhar sugestão sem mexer aqui.
 */
/** O primeiro dos campos que o vocabulário tem (o vocabulário cresce; a regra não quebra). */
function _o_que_houver(campos: Readonly<Record<string, unknown>>, ...codigos: string[]): string | null {
  return codigos.find((c) => Object.hasOwn(campos, c)) ?? null;
}

export function sugerir_campo(
  m: Pick<MarcadorDoModelo, "marcador" | "rotulo" | "antes" | "ocorrencia"> & { depois?: string },
  campos: Readonly<Record<string, CampoSugerivel>>,
  mapa_sugerido: Readonly<Record<string, string>> = {},
): string | null {
  const existe = (c: string | null | undefined): string | null => (c && Object.hasOwn(campos, c) ? c : null);
  const sem_sufixo = m.marcador.replace(/_\d+$/, "");
  // «Campus X, «cidade»» e «Cidade», «DD» de «mês» (a data de expedição): a
  // cidade do campus da turma, não a do setor emissor; vem antes do nome igual
  // ao código, que daria a cidade do setor
  const da_data = /^\s*,?\s*(«\s*dd\s*»|\d{1,2}|_+)\s+de\b/.test(normalizar(m.depois ?? ""));
  if (/cidade|municipio/.test(normalizar(m.rotulo)) && (da_data || /campus[^.]{0,60}$/.test(normalizar(m.antes)))) {
    const do_campus = _o_que_houver(campos, "turma_campus_cidade");
    if (do_campus) return do_campus;
  }
  for (const nome of [m.marcador, sem_sufixo]) {
    const direto = existe(nome) ?? existe(mapa_sugerido[nome]);
    if (direto) return direto;
  }

  const r = normalizar(m.rotulo).replace(/\s+/g, " ").trim();
  const antes = normalizar(m.antes);
  const tem = (...xs: string[]) => xs.some((x) => r.includes(x));
  const n = m.ocorrencia;

  // o que vem logo antes decide quando o próprio texto não diz nada
  const ultima = (...xs: string[]) => Math.max(...xs.map((x) => antes.lastIndexOf(x)));
  if (/^[_\s]*%[_\s]*$|^[_\s]+%$/.test(r) || (r.includes("%") && !/[a-z]/.test(r))) {
    const f = ultima("frequ");
    const nota = ultima("nota", "aproveitamento", "media");
    if (f >= 0 || nota >= 0) return existe(f > nota ? "frequencia_percentual" : _o_que_houver(campos, "nota_final_percentual", "nota_final"));
  }
  const parece_cpf = /^[0\s.\-x]+$/.test(r) && r.replace(/\D/g, "").length === 11;
  if (tem("cpf") || parece_cpf) {
    const de_quem = n === 1 && !/responsavel|instrutor|ministrante/.test(antes.slice(-80))
      ? (c: string) => c.includes("cpf") && c.startsWith("participante")
      : (c: string) => c.includes("cpf") && /assinante|instrutor/.test(c);
    return primeiro(campos, de_quem);
  }

  const regras: [boolean, string | null][] = [
    [tem("nome") && tem("participante", "aluno", "servidor", "cursista", "concluinte"), "participante_nome"],
    // o "responsável pela formação" é o instrutor principal; sem esses campos, o assinante
    [tem("responsavel", "instrutor", "ministrante") && tem("nome"), _o_que_houver(campos, "instrutor_nome", "assinante_nome")],
    [r === "dd/mm/aaaa" || r === "dd/mm/aa" || r === "data", n === 1 ? "turma_data_inicio" : n === 2 ? "turma_data_fim" : null],
    [tem("data de inicio", "inicio"), "turma_data_inicio"],
    [tem("data de termino", "data final", "termino"), "turma_data_fim"],
    [r === "dd" || r === "dia", "certificado_dia"],
    [r === "mes" || r === "mes por extenso", "certificado_mes_extenso"],
    [r === "aaaa" || r === "ano", "certificado_ano"],
    // «nº» logo depois de um hífen é o fim de um código montado em pedaços
    // ("CSSO-BRIG-«AAAA»-«nº»"): a sequência do número impresso, não a interna
    [/^n[ºo°.]?$|^numero$|^no\.?$/.test(r), /-\s*$/.test(antes) ? "certificado_sequencia" : "certificado_numero"],
    [tem("cidade", "municipio"), "cidade"],
    // o texto já diz "Campus" logo antes: só o nome, sem repetir a palavra
    [tem("campus") && /campus\s*$/.test(antes), _o_que_houver(campos, "turma_campus_curto", "turma_campus")],
    [tem("campus"), "turma_campus"],
    // «link de validação», «endereço da validação»: o endereço que abre /validar
    [tem("validacao", "validar", "verificacao", "verificar") && tem("endereco", "link", "url", "site"), "certificado_url_validacao"],
    [tem("endereco", "local do curso", "local de realizacao"), "turma_local"],
    [tem("tecnico", "engenheir", "cargo", "titulo", "formacao profissional") && !tem("credenciamento", "registro"), _o_que_houver(campos, "instrutor_titulo", "assinante_titulo")],
    [tem("credenciamento", "registro no conselho", "registro crea", "registro profissional"), _o_que_houver(campos, "instrutor_registro")],
    [tem("carga horaria", "horas"), "treinamento_carga_horaria"],
    [tem("descricao do evento", "descricao da turma", "descricao do curso", "sobre o evento"), _o_que_houver(campos, "turma_descricao")],
    [tem("conteudo"), "treinamento_conteudo"],
    [tem("periodo"), "turma_periodo_extenso"],
    [tem("chave", "codigo de validacao", "codigo de verificacao", "codigo verificacao"), "certificado_chave"],
    [tem("qr"), "certificado_qrcode"],
    [tem("vencimento", "validade"), "certificado_data_vencimento"],
    [tem("frequencia"), "frequencia_percentual"],
    [tem("nota"), "nota_final"],
    [tem("rubrica", "assinatura"), "assinante_rubrica"],
    [tem("siape"), "participante_siape"],
    [tem("lotacao"), "participante_lotacao"],
    [tem("curso", "treinamento") && tem("nome"), "treinamento_nome"],
  ];
  for (const [vale, campo] of regras) if (vale) return existe(campo);

  // semelhança de palavras: metade das palavras do marcador no rótulo ou no código do campo
  const minhas = [...new Set(palavras(`${m.rotulo} ${m.marcador.replace(/_\d+$/, "")}`))];
  if (!minhas.length) return null;
  let melhor: string | null = null;
  let nota_melhor = 0;
  for (const [codigo, campo] of Object.entries(campos)) {
    const delas = new Set(palavras(`${campo.rotulo} ${codigo}`));
    const comuns = minhas.filter((p) => delas.has(p) && p.length >= 3).length;
    const nota = comuns / minhas.length;
    if (comuns && nota > nota_melhor) {
      nota_melhor = nota;
      melhor = codigo;
    }
  }
  return nota_melhor >= 0.5 ? melhor : null;
}
