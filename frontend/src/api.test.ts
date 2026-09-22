// O cliente da API — o contrato que quebra sem ninguém ver.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, dataBr, RecusaDaApi, semSessao } from './api'

function responder(status: number, corpo: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(corpo),
  } as unknown as Response)
}

describe('o cliente de /api/v1', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('manda o cabeçalho de fetch em todo pedido, e JSON nos envios', async () => {
    const fetchFalso = responder(201, { registro_id: 7 })
    vi.stubGlobal('fetch', fetchFalso)
    await api.registrarEntrega({ servidor_id: 1, item_id: 2, quantidade: 1 })
    const [url, opcoes] = fetchFalso.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/v1/epis/entregas')
    expect(opcoes.method).toBe('POST')
    const cabecalhos = opcoes.headers as Record<string, string>
    expect(cabecalhos['X-Requested-With']).toBe('fetch')
    expect(cabecalhos['Content-Type']).toBe('application/json')
    expect(JSON.parse(String(opcoes.body))).toEqual({ servidor_id: 1, item_id: 2, quantidade: 1 })
    expect(opcoes.credentials).toBe('same-origin')
  })

  it('transforma a recusa do servidor em RecusaDaApi com erro e motivos', async () => {
    vi.stubGlobal('fetch', responder(422, { erro: 'A entrega foi recusada.', motivos: ['CA vencido'] }))
    await expect(api.itens()).rejects.toMatchObject({
      name: 'RecusaDaApi',
      status: 422,
      message: 'A entrega foi recusada.',
      motivos: ['CA vencido'],
    })
  })

  it('sem corpo legível a recusa ainda tem status e frase', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.reject(new Error('x')) }))
    await expect(api.eu()).rejects.toBeInstanceOf(RecusaDaApi)
    await expect(api.eu()).rejects.toMatchObject({ status: 500, message: 'Erro 500' })
  })

  it('401 é sessão acabada: vai para o login com a volta para o app', async () => {
    const ir = vi.spyOn(semSessao, 'redirecionar').mockImplementation(() => {})
    vi.stubGlobal('fetch', responder(401, { erro: 'Sessão ausente' }))
    const pendente = api.eu()
    await new Promise((r) => setTimeout(r, 0))
    expect(ir).toHaveBeenCalledTimes(1)
    void pendente // nunca resolve, de propósito: a página está indo embora
    ir.mockRestore()
  })

  it('codifica o termo da busca de quem recebe', async () => {
    const fetchFalso = responder(200, [])
    vi.stubGlobal('fetch', fetchFalso)
    await api.servidores('Ana & Cia')
    expect((fetchFalso.mock.calls[0] as [string])[0]).toBe('/api/v1/epis/servidores?q=Ana%20%26%20Cia')
  })
})

describe('dataBr', () => {
  it('escreve a data como o setor lê', () => {
    expect(dataBr('2026-09-06')).toBe('06/09/2026')
    expect(dataBr(null)).toBe('—')
  })
})
