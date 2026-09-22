import { useEffect, useState } from 'react'
import { api, dataBr, type Ficha as FichaDados } from '../api'
import { Carregando, Recusa, Vazio } from '../componentes/Recusa'

// A ficha de EPI de um servidor — a mesma linha do tempo de `/epis/fichas/{id}`,
// já decidida pelo servidor (RN-19 no nome, vencimento e troca calculados lá).
export function Ficha({ servidorId }: { servidorId: number }) {
  const [ficha, setFicha] = useState<FichaDados | null>(null)
  const [erro, setErro] = useState<unknown>(null)

  useEffect(() => {
    setFicha(null)
    setErro(null)
    api.ficha(servidorId).then(setFicha).catch(setErro)
  }, [servidorId])

  return (
    <section>
      <h1>Ficha de EPI</h1>
      <Recusa erro={erro} />
      {!ficha && !erro && <Carregando o="a ficha" />}
      {ficha && (
        <>
          <p className="sub">
            {ficha.servidor}
            {!ficha.nominal && <span className="discreto"> · identificação suprimida (RN-19)</span>}
          </p>
          {ficha.linhas.length === 0 ? (
            <Vazio
              fato="Nenhum EPI registrado para esta pessoa."
              saida="A ficha nasce da primeira entrega, e é ela que prova que o equipamento foi entregue."
            />
          ) : (
            <ul className="lista-toque ficha">
              {ficha.linhas.map((l) => (
                <li key={l.registro_id} className={'linha-ficha' + (l.estornado ? ' estornada' : '')}>
                  <div className="quem">
                    <strong>
                      {l.quantidade} × {l.epi}
                      {l.tamanho ? ` · tam. ${l.tamanho}` : ''}
                    </strong>
                    <span className="discreto">
                      {l.tipo.toLowerCase()} em {dataBr(l.data)}
                      {l.numero_ca ? ` · CA ${l.numero_ca}` : ''}
                      {l.previsao_troca ? ` · troca ${dataBr(l.previsao_troca)}` : ''}
                    </span>
                  </div>
                  <div className="marcas">
                    {l.estornado && <span className="pilula neutra">estornada</span>}
                    {l.ca_vencido && <span className="pilula erro">CA vencido</span>}
                    {l.troca_vencida && <span className="pilula alerta">troca devida</span>}
                    {l.sem_comprovante && !l.estornado && <span className="pilula alerta">sem comprovante</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="discreto">
            <a href={`/epis/fichas/${ficha.servidor_id}`}>Abrir no sistema completo</a>
          </p>
        </>
      )}
    </section>
  )
}
