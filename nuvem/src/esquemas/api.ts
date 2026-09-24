/**
 * Os contratos da API JSON (`/api/v1`) — o que entra e o que sai.
 * Porte de `app/esquemas/api.py`.
 *
 * O Pydantic fazia aqui o que `Form("")` faz nas telas: recusa o que não tem
 * forma antes de o serviço rodar, e a recusa de forma (422) vem no formato de
 * `Erro`, igual à recusa de regra — quem consome a API lê UM formato de erro.
 *
 * Sem Pydantic, a conferência de forma é um punhado de leitores (`ler`) com o
 * modo "lax" dele: inteiro aceita `5` e `"5"`, booleano aceita `true`/`"true"`/
 * `1`, data aceita `AAAA-MM-DD`. As mensagens de cada motivo são as do Pydantic
 * v2 (`campo: Field required`), para o cliente que já as mostra não mudar.
 *
 * Regra da casa que vale igual aqui: **o serviço é a autoridade**. Nenhum
 * esquema repete regra de negócio; eles só dizem o tipo de cada campo.
 */
import { RecusaDaApi } from "../nucleo/erros.js";

// =====================================================================
// Saída (as formas que as rotas devolvem)
// =====================================================================
export interface Erro {
  erro: string;
  motivos: string[];
}

export interface Eu {
  id: number;
  nome: string;
  login: string;
  perfis: string[];
  permissoes: string[];
  servidor_id: number | null;
  versao: string;
}

/** Uma linha do seletor de quem recebe — já passada pela RN-19. */
export interface ServidorResumo {
  id: number;
  rotulo: string;
  nominal: boolean;
}

export interface ItemResumo {
  id: number;
  nome: string;
  unidade_medida: string;
  quantidade_padrao: number;
  quantidade_maxima: number | null;
  regra_de_quantidade: string;
  tamanhos: string[];
  exige_ca: boolean;
  numero_ca: string | null;
  validade_ca: string | null;
}

export interface LoteResumo {
  entrada_id: number;
  rotulo: string;
  saldo: number;
  impedimento: string;
  pode_sair: boolean;
  tamanho: string | null;
  numero_ca: string | null;
  validade_ca: string | null;
}

export interface EntregaRegistrada {
  registro_id: number;
  servidor_id: number;
  ficha: string;
  comprovante: string;
  mensagem: string;
}

export interface LinhaFicha {
  registro_id: number;
  tipo: string;
  data: string;
  epi: string;
  quantidade: number;
  tamanho: string | null;
  numero_ca: string | null;
  validade_ca: string | null;
  lote: string | null;
  previsao_troca: string | null;
  estornado: boolean;
  sem_comprovante: boolean;
  ca_vencido: boolean;
  troca_vencida: boolean;
}

export interface Ficha {
  servidor_id: number;
  servidor: string;
  nominal: boolean;
  linhas: LinhaFicha[];
}

export interface TurmaResumo {
  id: number;
  codigo: string;
  treinamento: string;
  situacao: string;
  data_inicio: string;
  data_fim: string;
  dias: string[];
  carga_efetiva: string;
  inscritos: number;
}

export interface PresencaDia {
  presente: boolean;
  horas: string;
}

export interface LinhaPresenca {
  inscricao_id: number;
  participante: string;
  nominal: boolean;
  por_dia: Record<string, PresencaDia>;
  horas: string;
  frequencia: string;
  aprovado: boolean;
  situacao: string;
}

export interface GradePresenca {
  turma_id: number;
  codigo: string;
  dias: string[];
  carga_efetiva: string;
  retificando: boolean;
  linhas: LinhaPresenca[];
}

/** Uma linha da fila — a descrição já passada pela RN-19 no servidor. */
export interface PendenciaResumo {
  id: number;
  tipo: string;
  rotulo_tipo: string;
  descricao: string;
  prazo: string | null;
  atrasada: boolean;
  responsavel: string | null;
  onde: string | null;
}

export interface Pendencias {
  abertas: number;
  atrasadas: number;
  itens: PendenciaResumo[];
}

// =====================================================================
// Entrada (o corpo dos POSTs)
// =====================================================================
export interface NovaEntrega {
  servidor_id: number;
  item_id: number;
  quantidade: number;
  entrada_id: number | null;
  tamanho: string;
  data_evento: string | null;
  observacao: string;
  justificativa_excecao: string;
}

export interface NovaPresenca {
  inscricao_id: number;
  data: string;
  presente: boolean;
  horas: string;
  justificativa: string;
  motivo: string;
}

/** A frase de toda recusa de forma — a mesma do tratador do `principal.py`. */
export const FORMA_INESPERADA = "O envio não tem a forma esperada.";

type Leitor<T> = (valor: unknown) => T;
/** Um campo recusado: a mensagem do Pydantic. */
class Recusa extends Error {}

const ausente = Symbol("ausente");

function inteiro(valor: unknown): number {
  if (typeof valor === "number" && Number.isInteger(valor)) return valor;
  if (typeof valor === "string" && /^\s*[-+]?\d+\s*$/.test(valor)) return Number(valor.trim());
  if (typeof valor === "boolean") return valor ? 1 : 0;
  if (typeof valor === "number") throw new Recusa("Input should be a valid integer, got a number with a fractional part");
  if (typeof valor === "string") throw new Recusa("Input should be a valid integer, unable to parse string as an integer");
  throw new Recusa("Input should be a valid integer");
}

function texto(valor: unknown): string {
  if (typeof valor === "string") return valor;
  throw new Recusa("Input should be a valid string");
}

const VERDADEIROS = new Set(["true", "1", "yes", "y", "on", "t"]);
const FALSOS = new Set(["false", "0", "no", "n", "off", "f"]);
function booleano(valor: unknown): boolean {
  if (typeof valor === "boolean") return valor;
  if (valor === 0 || valor === 1) return valor === 1;
  if (typeof valor === "string") {
    const v = valor.trim().toLowerCase();
    if (VERDADEIROS.has(v)) return true;
    if (FALSOS.has(v)) return false;
  }
  throw new Recusa("Input should be a valid boolean");
}

function data(valor: unknown): string {
  if (typeof valor === "string" && /^\d{4}-\d{2}-\d{2}$/.test(valor)) {
    const [a, m, d] = valor.split("-").map(Number) as [number, number, number];
    const dia = new Date(Date.UTC(a, m - 1, d));
    if (dia.getUTCFullYear() === a && dia.getUTCMonth() === m - 1 && dia.getUTCDate() === d) return valor;
    throw new Recusa("Input should be a valid date or datetime, day value is outside expected range");
  }
  throw new Recusa("Input should be a valid date or datetime, input is too short");
}

function opcional<T>(leitor: Leitor<T>): Leitor<T | null> {
  return (valor) => (valor === null ? null : leitor(valor));
}

function maior_que_zero(leitor: Leitor<number>): Leitor<number> {
  return (valor) => {
    const n = leitor(valor);
    if (!(n > 0)) throw new Recusa("Input should be greater than 0");
    return n;
  };
}

/** `[leitor, padrão]` — sem padrão (`ausente`) o campo é obrigatório. */
type Campo = readonly [Leitor<unknown>, unknown];

function ler<T>(corpo: unknown, campos: Record<string, Campo>): T {
  const motivos: string[] = [];
  if (corpo === null || typeof corpo !== "object" || Array.isArray(corpo)) {
    throw new RecusaDaApi(422, FORMA_INESPERADA, ["corpo: Input should be a valid dictionary or object to extract fields from"]);
  }
  const bruto = corpo as Record<string, unknown>;
  const saida: Record<string, unknown> = {};
  for (const [nome, [leitor, padrao]] of Object.entries(campos)) {
    if (!(nome in bruto) || bruto[nome] === undefined) {
      if (padrao === ausente) motivos.push(`${nome}: Field required`);
      else saida[nome] = padrao;
      continue;
    }
    try {
      saida[nome] = leitor(bruto[nome]);
    } catch (erro) {
      if (!(erro instanceof Recusa)) throw erro;
      motivos.push(`${nome}: ${erro.message}`);
    }
  }
  if (motivos.length) throw new RecusaDaApi(422, FORMA_INESPERADA, motivos);
  return saida as T;
}

export function nova_entrega(corpo: unknown): NovaEntrega {
  return ler<NovaEntrega>(corpo, {
    servidor_id: [inteiro, ausente],
    item_id: [inteiro, ausente],
    quantidade: [maior_que_zero(inteiro), ausente],
    entrada_id: [opcional(inteiro), null],
    tamanho: [texto, ""],
    data_evento: [opcional(data), null],
    observacao: [texto, ""],
    justificativa_excecao: [texto, ""],
  });
}

export function nova_presenca(corpo: unknown): NovaPresenca {
  return ler<NovaPresenca>(corpo, {
    inscricao_id: [inteiro, ausente],
    data: [data, ausente],
    presente: [booleano, true],
    horas: [texto, ""],
    justificativa: [texto, ""],
    motivo: [texto, ""],
  });
}

/**
 * O corpo em JSON, ou a recusa de forma. JSON quebrado era o `json_invalid` do
 * Pydantic, no mesmo formato de `Erro`.
 */
export async function corpo_json(requisicao: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await requisicao.json();
  } catch {
    throw new RecusaDaApi(422, FORMA_INESPERADA, ["corpo: JSON decode error"]);
  }
}
