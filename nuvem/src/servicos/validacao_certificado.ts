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
import { eq } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import { certificado as tabela_certificado } from "../db/esquema/index.js";
import { Certificado as C } from "../dominio/treinamento.js";
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
  numero: string;
  identificador_participante: string;
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
    numero: "",
    identificador_participante: "",
  };
}

/** Nome e título do instrutor — quem ministra assina como profissional. */
function _nome_do_instrutor(dados: { nome?: string | null; titulo?: string | null }): string {
  const nome = (dados.nome ?? "").trim();
  const titulo = (dados.titulo ?? "").trim();
  return nome && titulo ? `${nome} — ${titulo}` : nome;
}

/**
 * A chave digitada vira resposta — ou a mesma negativa de sempre. O dígito
 * verificador é conferido ANTES de o banco ser tocado.
 */
export async function consultar(tx: Executor, bruta: string | null | undefined, hoje: string | null = null): Promise<Resposta> {
  const chave = normalizar_chave(bruta);
  if (!chave_valida(chave)) return nao_encontrado();
  const [certificado] = await tx.select().from(tabela_certificado).where(eq(tabela_certificado.chave_validacao, chave));
  if (!certificado) return nao_encontrado();

  // descongela pela MESMA função que a segunda via usa
  const contexto = ContextoCertificado.descongelar((certificado.contexto_congelado ?? {}) as Record<string, unknown>);
  const quando = hoje ?? datas_br.hoje();
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
    emissor: contexto.setor_nome || contexto.setor_sigla || "",
    numero: C.rotulo(certificado),
    identificador_participante: contexto.participante_identificador || "",
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
  const [certificado] = await tx
    .select()
    .from(tabela_certificado)
    .where(eq(tabela_certificado.chave_validacao, normalizar_chave(chave)));
  if (!certificado) return null;
  const contexto = ContextoCertificado.descongelar((certificado.contexto_congelado ?? {}) as Record<string, unknown>);
  const esperado = _forma_de_comparar(contexto.participante_nome);
  return Boolean(esperado) && _forma_de_comparar(limpo) === esperado;
}
