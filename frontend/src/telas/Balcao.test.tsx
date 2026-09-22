// O balcão, do lado de fora: os quatro passos na ordem, a recusa no lugar
// certo e a série ("registrar outra") voltando ao começo.
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Balcao } from './Balcao'

type Rota = { metodo: string; url: string; corpo?: unknown }

function apiFalsa(respostas: Record<string, (rota: Rota) => { status: number; corpo: unknown }>) {
  const chamadas: Rota[] = []
  const fetchFalso = vi.fn(async (url: string, opcoes?: RequestInit) => {
    const rota = { metodo: opcoes?.method ?? 'GET', url, corpo: opcoes?.body ? JSON.parse(String(opcoes.body)) : undefined }
    chamadas.push(rota)
    const chave = Object.keys(respostas).find((c) => url.startsWith(c)) ?? ''
    const r = respostas[chave]?.(rota) ?? { status: 404, corpo: { erro: 'sem resposta falsa para ' + url } }
    return { ok: r.status < 300, status: r.status, json: async () => r.corpo } as Response
  })
  vi.stubGlobal('fetch', fetchFalso)
  return chamadas
}

const ITENS = [
  { id: 5, nome: 'Bota de segurança', unidade_medida: 'PAR', quantidade_padrao: 1, quantidade_maxima: null, regra_de_quantidade: 'sem máximo', tamanhos: ['40', '42'], exige_ca: false, numero_ca: null, validade_ca: null },
]
const LOTES = [{ entrada_id: 9, rotulo: 'Lote L-1 · CA 123 · 4 em estoque', saldo: 4, impedimento: '', pode_sair: true, tamanho: null, numero_ca: '123', validade_ca: null }]

describe('o balcão', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('percorre quem recebe → equipamento → detalhes → feito, e volta ao começo', async () => {
    const chamadas = apiFalsa({
      '/api/v1/epis/itens/5/lotes': () => ({ status: 200, corpo: LOTES }),
      '/api/v1/epis/itens': () => ({ status: 200, corpo: ITENS }),
      '/api/v1/epis/servidores': () => ({ status: 200, corpo: [{ id: 3, rotulo: 'Marco · SIAPE 1110654', nominal: true }] }),
      '/api/v1/epis/entregas': () => ({
        status: 201,
        corpo: { registro_id: 42, servidor_id: 3, ficha: '/epis/fichas/3', comprovante: '/epis/fichas/registros/42/comprovante', mensagem: 'Entrega registrada (registro 42).' },
      }),
    })
    render(<Balcao />)

    fireEvent.change(screen.getByLabelText('Quem recebe'), { target: { value: 'Marco' } })
    const quem = await screen.findByRole('button', { name: 'Marco · SIAPE 1110654' })
    fireEvent.click(quem)
    expect(screen.getByText('Recebe: Marco · SIAPE 1110654')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Equipamento'), { target: { value: '5' } })
    await screen.findByLabelText('Lote')
    expect(screen.getByLabelText('Quantidade')).toHaveValue('1')
    expect(screen.getByRole('option', { name: /Lote L-1/ })).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Lote'), { target: { value: '9' } })
    fireEvent.click(screen.getByRole('button', { name: 'Registrar entrega' }))
    await screen.findByText('Entrega registrada (registro 42).')
    expect(screen.getByRole('link', { name: 'Comprovante' })).toHaveAttribute('href', '/epis/fichas/registros/42/comprovante')

    const envio = chamadas.find((c) => c.url === '/api/v1/epis/entregas')
    expect(envio?.corpo).toMatchObject({ servidor_id: 3, item_id: 5, quantidade: 1, entrada_id: 9 })

    fireEvent.click(screen.getByRole('button', { name: 'Registrar outra entrega' }))
    expect(screen.getByLabelText('Quem recebe')).toHaveValue('')
  })

  it('a recusa do servidor aparece no passo dos detalhes, com os motivos', async () => {
    apiFalsa({
      '/api/v1/epis/itens/5/lotes': () => ({ status: 200, corpo: [] }),
      '/api/v1/epis/itens': () => ({ status: 200, corpo: ITENS }),
      '/api/v1/epis/servidores': () => ({ status: 200, corpo: [{ id: 3, rotulo: 'SRV-a1b2', nominal: false }] }),
      '/api/v1/epis/entregas': () => ({ status: 422, corpo: { erro: 'A entrega foi recusada.', motivos: ['o CA de referência está vencido'] } }),
    })
    render(<Balcao />)
    fireEvent.change(screen.getByLabelText('Quem recebe'), { target: { value: '1110654' } })
    fireEvent.click(await screen.findByRole('button', { name: 'SRV-a1b2' }))
    fireEvent.change(screen.getByLabelText('Equipamento'), { target: { value: '5' } })
    await screen.findByLabelText('Lote')
    fireEvent.click(screen.getByRole('button', { name: 'Registrar entrega' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('A entrega foi recusada.'))
    expect(screen.getByRole('alert')).toHaveTextContent('o CA de referência está vencido')
    // e o passo não avançou: o botão continua lá para a segunda tentativa
    expect(screen.getByRole('button', { name: 'Registrar entrega' })).toBeEnabled()
  })
})
