// O cliente de /api/v1 — um só, para as telas não reinventarem o erro.
//
// Três regras, as mesmas do `celular.js`:
// - todo pedido leva `X-Requested-With: fetch` (a guarda de CSRF do servidor
//   exige nos POSTs; mandar sempre é mais barato que lembrar);
// - 401 é sessão acabada: a única saída honesta é o login, com a volta para cá;
// - toda recusa vira `RecusaDaApi` com `erro` e `motivos`, no formato que o
//   servidor devolve em todos os caminhos (permissão, forma, regra).

export class RecusaDaApi extends Error {
  status: number
  motivos: string[]

  constructor(status: number, erro: string, motivos: string[] = []) {
    super(erro)
    this.name = 'RecusaDaApi'
    this.status = status
    this.motivos = motivos
  }
}

export type Eu = {
  id: number
  nome: string
  login: string
  perfis: string[]
  permissoes: string[]
  servidor_id: number | null
  versao: string
}

export type ServidorResumo = { id: number; rotulo: string; nominal: boolean }

export type ItemResumo = {
  id: number
  nome: string
  unidade_medida: string
  quantidade_padrao: number
  quantidade_maxima: number | null
  regra_de_quantidade: string
  tamanhos: string[]
  exige_ca: boolean
  numero_ca: string | null
  validade_ca: string | null
}

export type LoteResumo = {
  entrada_id: number
  rotulo: string
  saldo: number
  impedimento: string
  pode_sair: boolean
  tamanho: string | null
  numero_ca: string | null
  validade_ca: string | null
}

export type NovaEntrega = {
  servidor_id: number
  item_id: number
  quantidade: number
  entrada_id?: number | null
  tamanho?: string
  data_evento?: string | null
  observacao?: string
  justificativa_excecao?: string
}

export type EntregaRegistrada = {
  registro_id: number
  servidor_id: number
  ficha: string
  comprovante: string
  mensagem: string
}

export type LinhaFicha = {
  registro_id: number
  tipo: string
  data: string
  epi: string
  quantidade: number
  tamanho: string | null
  numero_ca: string | null
  validade_ca: string | null
  lote: string | null
  previsao_troca: string | null
  estornado: boolean
  sem_comprovante: boolean
  ca_vencido: boolean
  troca_vencida: boolean
}

export type Ficha = { servidor_id: number; servidor: string; nominal: boolean; linhas: LinhaFicha[] }

export type TurmaResumo = {
  id: number
  codigo: string
  treinamento: string
  situacao: string
  data_inicio: string
  data_fim: string
  dias: string[]
  carga_efetiva: string
  inscritos: number
}

export type PresencaDia = { presente: boolean; horas: string }

export type LinhaPresenca = {
  inscricao_id: number
  participante: string
  nominal: boolean
  por_dia: Record<string, PresencaDia>
  horas: string
  frequencia: string
  aprovado: boolean
  situacao: string
}

export type GradePresenca = {
  turma_id: number
  codigo: string
  dias: string[]
  carga_efetiva: string
  retificando: boolean
  linhas: LinhaPresenca[]
}

export type NovaPresenca = {
  inscricao_id: number
  data: string
  presente: boolean
  horas?: string
  justificativa?: string
  motivo?: string
}

export type PendenciaResumo = {
  id: number
  tipo: string
  rotulo_tipo: string
  descricao: string
  prazo: string | null
  atrasada: boolean
  responsavel: string | null
  onde: string | null
}

export type Pendencias = { abertas: number; atrasadas: number; itens: PendenciaResumo[] }

// Para onde ir quando a sessão acaba. Sobrescrevível nos testes.
export const semSessao = {
  redirecionar(): void {
    window.location.assign('/login?proximo=%2Fapp&motivo=sessao')
  },
}

async function pedir<T>(metodo: string, caminho: string, corpo?: unknown): Promise<T> {
  const opcoes: RequestInit = {
    method: metodo,
    headers: { Accept: 'application/json', 'X-Requested-With': 'fetch' },
    credentials: 'same-origin',
  }
  if (corpo !== undefined) {
    ;(opcoes.headers as Record<string, string>)['Content-Type'] = 'application/json'
    opcoes.body = JSON.stringify(corpo)
  }
  const resposta = await fetch('/api/v1' + caminho, opcoes)
  if (resposta.status === 401) {
    semSessao.redirecionar()
    return new Promise<T>(() => {})
  }
  let dados: unknown = {}
  try {
    dados = await resposta.json()
  } catch {
    dados = {}
  }
  if (!resposta.ok) {
    const d = (dados ?? {}) as { erro?: string; motivos?: string[] }
    throw new RecusaDaApi(resposta.status, d.erro ?? `Erro ${resposta.status}`, d.motivos ?? [])
  }
  return dados as T
}

export const api = {
  eu: () => pedir<Eu>('GET', '/eu'),
  pendencias: () => pedir<Pendencias>('GET', '/pendencias'),
  servidores: (q: string) => pedir<ServidorResumo[]>('GET', '/epis/servidores?q=' + encodeURIComponent(q)),
  itens: () => pedir<ItemResumo[]>('GET', '/epis/itens'),
  lotes: (itemId: number) => pedir<LoteResumo[]>('GET', `/epis/itens/${itemId}/lotes`),
  registrarEntrega: (corpo: NovaEntrega) => pedir<EntregaRegistrada>('POST', '/epis/entregas', corpo),
  ficha: (servidorId: number) => pedir<Ficha>('GET', `/epis/fichas/${servidorId}`),
  turmas: (situacao = 'EM_ANDAMENTO') => pedir<TurmaResumo[]>('GET', '/turmas?situacao=' + situacao),
  grade: (turmaId: number) => pedir<GradePresenca>('GET', `/turmas/${turmaId}/presencas`),
  lancarPresenca: (turmaId: number, corpo: NovaPresenca) =>
    pedir<GradePresenca>('POST', `/turmas/${turmaId}/presencas`, corpo),
}

// dd/mm/aaaa a partir do ISO — a forma que o setor lê
export function dataBr(iso: string | null | undefined): string {
  if (!iso) return '—'
  const [a, m, d] = iso.slice(0, 10).split('-')
  return `${d}/${m}/${a}`
}

export function hojeIso(): string {
  const hoje = new Date()
  const mes = String(hoje.getMonth() + 1).padStart(2, '0')
  const dia = String(hoje.getDate()).padStart(2, '0')
  return `${hoje.getFullYear()}-${mes}-${dia}`
}
