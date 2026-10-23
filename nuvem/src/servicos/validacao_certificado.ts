/**
 * A validação pública por chave — a regra, sem a tela.
 * Porte de `app/servicos/validacao_certificado.py`.
 *
 * Todo certificado emitido imprime `{url_base}/validar/{chave}` no papel e no
 * QR; esta é a regra do que essa página responde.
 *
 * **1. A página não exibe o nome de quem se formou.** Quem só tem a chave não
 * ganha um nome de presente (enumeração). No lugar do nome sai o
 * `identificador_publico` e a **conferência por digitação**: um bit, não um nome.
 *
 * **2. Sem autenticação.** A página existe para quem NÃO tem conta.
 *
 * A higiene: limite por IP, resposta idêntica para chave inexistente /
 * malformada / com dígito errado, `noindex` e `no-store`, nenhuma listagem,
 * nenhuma busca por nome, nenhum link para baixar o documento.
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  certificado as tabela_certificado,
  inscricao as tabela_inscricao,
  turma as tabela_turma,
  unidade_uorg as tabela_unidade,
} from "../db/esquema/index.js";
import {
  ALFABETO_IDENTIFICADOR,
  Certificado as C,
  PADRAO_NUMERO_IMPRESSO,
  TAMANHO_SORTEIO_VALIDACAO,
} from "../dominio/treinamento.js";
import { ContextoCertificado, chave_valida, normalizar_chave } from "./certificado.js";
import * as datas_br from "./datas_br.js";
import { numero as numero_br } from "./presenca.js";
import * as textos from "./textos.js";

// =====================================================================
// Antienumeração: o limite por IP
// =====================================================================
// DESVIO: no Python o contador morava na memória do processo único, e isso era
// escolha (uma tabela faria toda consulta pública ESCREVER no SQLite). Na
// nuvem a memória é a da instância da função do Netlify: o limite continua
// valendo dentro de cada instância, mas instâncias paralelas e a reciclagem
// delas o afrouxam. A borda do Netlify (rate limiting) é o lugar de apertá-lo;
// ver DESVIOS.md.
export const JANELA_CURTA_S = 60;
export const LIMITE_CURTO = 10;
export const JANELA_LONGA_S = 3600;
export const LIMITE_LONGO = 100;

const _tentativas = new Map<string, number[]>();

/** Relógio monotônico em segundos (trocável nos testes, como o `_agora` do Python). */
export const relogio = { agora: (): number => performance.now() / 1000 };

/** Zera os contadores. Existe para o teste. */
export function limpar_limites(): void {
  _tentativas.clear();
}

/**
 * Registra a tentativa e diz se ela cabe no limite. Conta ANTES de olhar a
 * chave: contar só o que falha convidaria a varrer com chaves válidas.
 */
export function dentro_do_limite(ip: string | null | undefined): boolean {
  const chave = ip || "desconhecido";
  const agora = relogio.agora();
  let fila = _tentativas.get(chave);
  if (!fila) {
    fila = [];
    _tentativas.set(chave, fila);
  }
  while (fila.length && agora - fila[0]! > JANELA_LONGA_S) fila.shift();
  fila.push(agora);
  if (fila.length > LIMITE_LONGO) return false;
  const recentes = fila.filter((t) => agora - t <= JANELA_CURTA_S).length;
  return recentes <= LIMITE_CURTO;
}

// =====================================================================
// A resposta
// =====================================================================
/**
 * O que a página pública pode dizer. Sem nome, e sem caminho para o papel.
 * `encontrado=false` responde por três casos que a tela NÃO distingue.
 */
export interface Resposta {
  encontrado: boolean;
  chave: string;
  situacao: string;
  treinamento: string;
  norma: string;
  carga_horaria: string;
  /** `turma_data_fim` — o "Data de término" que o próprio .docx imprime */
  termino: string | null;
  vencimento: string | null;
  validade_meses: number;
  instrutores: string[];
  emissor: string;
  /** A sigla do setor que emitiu ("CSSO confirma"), ou "" no congelado sem ela. */
  setor_sigla: string;
  numero: string;
  identificador_participante: string;
  // o número do certificado que substituiu este (retificação), ou ""
  substituido_por: string;
}

function nao_encontrado(): Resposta {
  return {
    encontrado: false,
    chave: "",
    situacao: "",
    treinamento: "",
    norma: "",
    carga_horaria: "",
    termino: null,
    vencimento: null,
    validade_meses: 0,
    instrutores: [],
    emissor: "",
    setor_sigla: "",
    numero: "",
    identificador_participante: "",
    substituido_por: "",
  };
}

/** Nome e título do instrutor — quem ministra assina como profissional. */
function _nome_do_instrutor(dados: { nome?: string | null; titulo?: string | null }): string {
  const nome = (dados.nome ?? "").trim();
  const titulo = (dados.titulo ?? "").trim();
  return nome && titulo ? `${nome} — ${titulo}` : nome;
}

// =====================================================================
// A busca pela chave (22/10/2026: a antiga e a nova)
// =====================================================================
/**
 * A chave nova sem os traços: o número impresso (sigla 1–12 + código 2–10 +
 * ano + sequência de 4 a 6 algarismos) e os 5 sorteados. Sem os traços não há
 * como saber onde termina a sigla, e por isso a busca compara SEM traços dos
 * dois lados — e só aceita quando sobra exatamente um certificado.
 */
const _RE_COMPACTA_NOVA = new RegExp(`^[A-Z0-9]{3,22}\\d{8,10}[${ALFABETO_IDENTIFICADOR}]{${TAMANHO_SORTEIO_VALIDACAO}}$`);
const _RE_SO_NUMERO = new RegExp(`^(?:${PADRAO_NUMERO_IMPRESSO}|\\d{1,6}/\\d{4})$`);

/** Caixa alta, sem espaço, sem traço de espécie alguma, sem ponto e sem sublinhado. */
export function compactar_chave(bruta: string | null | undefined): string {
  return (bruta ?? "").replace(/[\s\-‐‑‒–—―−_.]/g, "").toUpperCase();
}

/**
 * Digitou SÓ o número impresso (`CSSO-NR35-2026-0001`, ou o antigo `27/2026`)?
 * O número é legível e se adivinha: ele não valida nada sozinho. A tela usa
 * isto para orientar ("use o código completo do QR ou do link") — e decide só
 * pelo FORMATO, sem tocar no banco: a orientação sai igual exista ou não o
 * certificado.
 */
export function so_o_numero(bruta: string | null | undefined): boolean {
  return _RE_SO_NUMERO.test(normalizar_chave(bruta));
}

type LinhaCertificado = typeof tabela_certificado.$inferSelect;

/**
 * A sigla do setor promotor da turma ("CSSO confirma"). O congelado guarda o
 * NOME do promotor, não a sigla; a sigla de hoje basta para a frase (o número
 * impresso, esse sim congelado, já traz a do dia da emissão).
 */
async function _sigla_do_promotor(tx: Executor, inscricao_id: number): Promise<string> {
  const [linha] = await tx
    .select({ sigla: tabela_unidade.sigla })
    .from(tabela_inscricao)
    .innerJoin(tabela_turma, eq(tabela_turma.id, tabela_inscricao.turma_id))
    .innerJoin(tabela_unidade, eq(tabela_unidade.id, tabela_turma.unidade_promotora_id))
    .where(eq(tabela_inscricao.id, inscricao_id));
  return (linha?.sigla ?? "").trim();
}

/**
 * O certificado da chave digitada, ou `null` — sem dizer por quê. A antiga tem
 * o dígito verificador conferido ANTES de o banco ser tocado; a nova, com os
 * traços, é procurada pela igualdade; sem eles, comparando sem traços.
 */
export async function localizar(tx: Executor, bruta: string | null | undefined): Promise<LinhaCertificado | null> {
  const chave = normalizar_chave(bruta);
  if (chave_valida(chave)) {
    const [certificado] = await tx.select().from(tabela_certificado).where(eq(tabela_certificado.chave_validacao, chave));
    if (certificado) return certificado;
  }
  const compacta = compactar_chave(bruta);
  if (!_RE_COMPACTA_NOVA.test(compacta)) return null;
  const achados = await tx
    .select()
    .from(tabela_certificado)
    .where(
      and(
        isNotNull(tabela_certificado.numero_impresso),
        sql`replace(${tabela_certificado.chave_validacao}, '-', '') = ${compacta}`,
      ),
    )
    .limit(2);
  // duas chaves que só diferem pelo lugar do traço: ambíguo é "não encontrado"
  return achados.length === 1 ? achados[0]! : null;
}

/**
 * A chave digitada vira resposta — ou a mesma negativa de sempre (inexistente,
 * malformada, dígito errado, só o número: tudo responde igual).
 */
export async function consultar(tx: Executor, bruta: string | null | undefined, hoje: string | null = null): Promise<Resposta> {
  const certificado = await localizar(tx, bruta);
  if (!certificado) return nao_encontrado();
  const chave = certificado.chave_validacao;

  // descongela pela MESMA função que a segunda via usa
  const contexto = ContextoCertificado.descongelar((certificado.contexto_congelado ?? {}) as Record<string, unknown>);
  const quando = hoje ?? datas_br.hoje();
  let substituido_por = "";
  if (certificado.substituido_por_id !== null) {
    const [novo] = await tx.select().from(tabela_certificado).where(eq(tabela_certificado.id, certificado.substituido_por_id));
    substituido_por = novo ? C.rotulo(novo) : "";
  }
  return {
    encontrado: true,
    chave,
    // estado, calculado agora — nunca congelado
    situacao: C.situacao_publica(certificado, quando),
    // `|| ""` em todo campo de texto: congelado incompleto não escreve "None"
    treinamento: contexto.treinamento_nome || "",
    norma: contexto.treinamento_norma || "",
    carga_horaria: numero_br(contexto.carga_horaria),
    termino: contexto.turma_data_fim,
    vencimento: certificado.data_vencimento,
    validade_meses: certificado.validade_meses_congelada,
    instrutores: contexto.instrutores.map(_nome_do_instrutor).filter((n) => n),
    // no Sistema SISA quem emite é o setor que PROMOVEU a turma; o setor da
    // configuração (o congelado `setor_*`) fica para a turma sem promotor
    emissor: contexto.turma_unidade_promotora || contexto.setor_nome || contexto.setor_sigla || "",
    setor_sigla: (await _sigla_do_promotor(tx, certificado.inscricao_id)) || contexto.setor_sigla || "",
    numero: C.rotulo(certificado),
    identificador_participante: contexto.participante_identificador || "",
    // só o número: a chave do substituto é do titular, e ela não se descobre por aqui
    substituido_por,
  };
}

// =====================================================================
// A conferência do nome — no lugar da exibição
// =====================================================================
// Partículas fora da comparação: recusar por um "de" transformaria a
// conferência num quiz de digitação.
const _PARTICULAS = new Set(["de", "da", "do", "das", "dos", "e", "del", "di", "van"]);

function _forma_de_comparar(nome: string | null | undefined): string {
  return textos
    .chave_busca(nome)
    .split(/\s+/)
    .filter((p) => p && !_PARTICULAS.has(p))
    .join(" ");
}

/**
 * `true` confere, `false` não confere, `null` não há o que conferir. Lê o nome
 * do CONGELADO, e não do cadastro de hoje.
 */
export async function confere_o_nome(
  tx: Executor,
  chave: string,
  digitado: string | null | undefined,
): Promise<boolean | null> {
  const limpo = (digitado ?? "").trim();
  if (!limpo) return null;
  const certificado = await localizar(tx, chave);
  if (!certificado) return null;
  const contexto = ContextoCertificado.descongelar((certificado.contexto_congelado ?? {}) as Record<string, unknown>);
  const esperado = _forma_de_comparar(contexto.participante_nome);
  return Boolean(esperado) && _forma_de_comparar(limpo) === esperado;
}
