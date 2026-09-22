import { useEffect, useState } from 'react'
import { api, dataBr, type Pendencias as Dados } from '../api'
import { Carregando, Recusa } from '../componentes/Recusa'

// A fila de pendências de quem entrou, por escopo — a mesma de `/pendencias`,
// com a descrição já passada pela RN-19 no servidor. O link "onde" leva ao
// sistema completo: é lá que o trabalho se faz.
export function Pendencias() {
  const [dados, setDados] = useState<Dados | null>(null)
  const [erro, setErro] = useState<unknown>(null)

  useEffect(() => {
    api.pendencias().then(setDados).catch(setErro)
  }, [])

  return (
    <section>
      <h1>Pendências</h1>
      <Recusa erro={erro} />
      {!dados && !erro && <Carregando o="a fila" />}
      {dados && dados.itens.length === 0 && <p className="discreto">Nada pendente. Bom sinal.</p>}
      {dados && dados.itens.length > 0 && (
        <ul className="lista-toque pendencias">
          {dados.itens.map((p) => (
            <li key={p.id} className={'linha-ficha' + (p.atrasada ? ' atrasada' : '')}>
              <div className="quem">
                <span className="rotulo-tipo">{p.rotulo_tipo}</span>
                <strong>{p.descricao}</strong>
                <span className="discreto">
                  {p.prazo ? (p.atrasada ? `atrasada desde ${dataBr(p.prazo)}` : `até ${dataBr(p.prazo)}`) : 'sem prazo'}
                  {p.responsavel ? ` · ${p.responsavel}` : ' · sem dono'}
                </span>
              </div>
              <div className="marcas">
                {p.onde ? (
                  <a className="botao secundario compacto" href={p.onde}>
                    abrir
                  </a>
                ) : (
                  <span className="discreto">sem âncora</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
