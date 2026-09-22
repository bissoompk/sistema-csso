import { useEffect, useRef, useState } from 'react'
import {
  api,
  hojeIso,
  type EntregaRegistrada,
  type ItemResumo,
  type LoteResumo,
  type ServidorResumo,
} from '../api'
import { Recusa } from '../componentes/Recusa'

// O balcão em quatro passos — o mesmo desenho de `/celular`, agora como
// componente: quem recebe, equipamento, detalhes, feito. A regra continua toda
// no servidor; o que este componente decide é só a ORDEM em que se pergunta.
type Passo = 'servidor' | 'item' | 'detalhes' | 'feito'

export function Balcao() {
  const [passo, setPasso] = useState<Passo>('servidor')
  const [busca, setBusca] = useState('')
  const [servidores, setServidores] = useState<ServidorResumo[]>([])
  const [servidor, setServidor] = useState<ServidorResumo | null>(null)
  const [itens, setItens] = useState<ItemResumo[]>([])
  const [item, setItem] = useState<ItemResumo | null>(null)
  const [lotes, setLotes] = useState<LoteResumo[]>([])
  const [entradaId, setEntradaId] = useState('')
  const [quantidade, setQuantidade] = useState('1')
  const [tamanho, setTamanho] = useState('')
  const [data, setData] = useState(hojeIso())
  const [justificativa, setJustificativa] = useState('')
  const [erro, setErro] = useState<unknown>(null)
  const [enviando, setEnviando] = useState(false)
  const [feito, setFeito] = useState<EntregaRegistrada | null>(null)
  const temporizador = useRef<number | null>(null)

  useEffect(() => {
    api.itens().then(setItens).catch(setErro)
  }, [])

  // a busca espera a pessoa parar de digitar: 250 ms, como no balcão de mesa
  useEffect(() => {
    if (temporizador.current) window.clearTimeout(temporizador.current)
    const termo = busca.trim()
    if (termo.length < 2) {
      setServidores([])
      return
    }
    temporizador.current = window.setTimeout(() => {
      api.servidores(termo).then(setServidores).catch(setErro)
    }, 250)
  }, [busca])

  function escolherServidor(sv: ServidorResumo) {
    setServidor(sv)
    setPasso('item')
  }

  function escolherItem(id: string) {
    const escolhido = itens.find((i) => String(i.id) === id) ?? null
    setItem(escolhido)
    setEntradaId('')
    setTamanho('')
    if (!escolhido) return
    setQuantidade(String(escolhido.quantidade_padrao))
    api
      .lotes(escolhido.id)
      .then((lista) => {
        setLotes(lista)
        setPasso('detalhes')
      })
      .catch(setErro)
  }

  function registrar() {
    if (!servidor || !item) return
    setErro(null)
    setEnviando(true)
    api
      .registrarEntrega({
        servidor_id: servidor.id,
        item_id: item.id,
        quantidade: Number(quantidade || 0),
        entrada_id: entradaId ? Number(entradaId) : null,
        tamanho,
        data_evento: data || null,
        justificativa_excecao: justificativa,
      })
      .then((r) => {
        setFeito(r)
        setPasso('feito')
      })
      .catch(setErro)
      .finally(() => setEnviando(false))
  }

  function outra() {
    setServidor(null)
    setItem(null)
    setBusca('')
    setServidores([])
    setFeito(null)
    setErro(null)
    setPasso('servidor')
  }

  return (
    <section>
      <h1>Balcão de EPI</h1>
      <ol className="passos-celular">
        {passo === 'servidor' && (
          <li className="atual">
            <label htmlFor="busca">Quem recebe</label>
            <input
              id="busca"
              type="search"
              autoComplete="off"
              placeholder="SIAPE ou nome"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              aria-describedby="busca-dica"
            />
            <span className="dica" id="busca-dica">
              O SIAPE acha sempre; o nome, só para quem pode ler nomes (RN-19).
            </span>
            <ul className="lista-toque" aria-live="polite">
              {busca.trim().length >= 2 && servidores.length === 0 && (
                <li className="nada">Nada encontrado para “{busca.trim()}”.</li>
              )}
              {servidores.map((sv) => (
                <li key={sv.id}>
                  <button
                    type="button"
                    className="toque"
                    onClick={() => escolherServidor(sv)}
                    title={sv.nominal ? undefined : 'identificação suprimida (RN-19)'}
                  >
                    {sv.rotulo}
                  </button>
                </li>
              ))}
            </ul>
          </li>
        )}

        {(passo === 'item' || passo === 'detalhes') && servidor && (
          <li className={passo === 'item' ? 'atual' : ''}>
            <p className="escolhido">Recebe: {servidor.rotulo}</p>
            <label htmlFor="item">Equipamento</label>
            <select id="item" value={item?.id ?? ''} onChange={(e) => escolherItem(e.target.value)}>
              <option value="">— escolha —</option>
              {itens.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.nome}
                </option>
              ))}
            </select>
          </li>
        )}

        {passo === 'detalhes' && item && (
          <li className="atual">
            <div className="campo">
              <label htmlFor="lote">Lote</label>
              <select id="lote" value={entradaId} onChange={(e) => setEntradaId(e.target.value)}>
                <option value="">Sem lote — entrega de balcão</option>
                {lotes.map((l) => (
                  <option key={l.entrada_id} value={l.entrada_id} disabled={!l.pode_sair}>
                    {l.rotulo}
                    {l.impedimento ? ` — INDISPONÍVEL: ${l.impedimento}` : l.saldo <= 0 ? ' — sem saldo' : ''}
                  </option>
                ))}
              </select>
              <span className="dica">
                {lotes.length
                  ? 'O CA que bloqueia a entrega é o do lote, não o do catálogo.'
                  : 'Nenhum lote cadastrado: sem lote, o CA conferido é o do catálogo.'}
              </span>
            </div>
            <div className="linha-campos">
              <div className="campo">
                <label htmlFor="quantidade">Quantidade</label>
                <input
                  id="quantidade"
                  inputMode="numeric"
                  value={quantidade}
                  onChange={(e) => setQuantidade(e.target.value)}
                  aria-describedby="quantidade-dica"
                />
                <span className="dica" id="quantidade-dica">
                  Padrão: {item.quantidade_padrao} {item.unidade_medida.toLowerCase()}. Máximo:{' '}
                  {item.regra_de_quantidade}.
                </span>
              </div>
              <div className="campo">
                <label htmlFor="tamanho">Tamanho</label>
                {item.tamanhos.length ? (
                  <select id="tamanho" value={tamanho} onChange={(e) => setTamanho(e.target.value)}>
                    <option value="">—</option>
                    {item.tamanhos.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input id="tamanho" value={tamanho} onChange={(e) => setTamanho(e.target.value)} placeholder="não se aplica" />
                )}
              </div>
            </div>
            <div className="campo">
              <label htmlFor="data">Data da entrega</label>
              <input id="data" type="date" value={data} max={hojeIso()} onChange={(e) => setData(e.target.value)} />
              <span className="dica">Não aceita data futura: a ficha registra o que aconteceu.</span>
            </div>
            {item.quantidade_maxima !== null && (
              <div className="campo">
                <label htmlFor="justificativa">Justificativa da exceção ao máximo</label>
                <textarea
                  id="justificativa"
                  rows={2}
                  value={justificativa}
                  onChange={(e) => setJustificativa(e.target.value)}
                  placeholder="Só preencha se o máximo já tiver sido atingido."
                />
              </div>
            )}
            <div className="acoes">
              <button type="button" className="largo" onClick={registrar} disabled={enviando}>
                {enviando ? 'Registrando…' : 'Registrar entrega'}
              </button>
            </div>
            <Recusa erro={erro} />
          </li>
        )}

        {passo === 'feito' && feito && (
          <li className="atual">
            <div className="aviso aviso-ok" role="status">
              {feito.mensagem}
            </div>
            <div className="acoes">
              <a className="botao secundario" href={feito.comprovante} target="_blank" rel="noopener">
                Comprovante
              </a>
              <a className="botao secundario" href={`#/ficha/${feito.servidor_id}`}>
                Ficha
              </a>
              <button type="button" className="largo" onClick={outra}>
                Registrar outra entrega
              </button>
            </div>
          </li>
        )}
      </ol>
      {passo !== 'detalhes' && <Recusa erro={erro} />}
    </section>
  )
}
