import { useEffect, useState } from 'react'
import { api, type Eu } from './api'
import { Carregando, Recusa } from './componentes/Recusa'
import { useRota } from './roteador'
import { Balcao } from './telas/Balcao'
import { Chamada } from './telas/Chamada'
import { Ficha } from './telas/Ficha'
import { Inicio } from './telas/Inicio'
import { Pendencias } from './telas/Pendencias'

// A casca do app: cabeçalho com a marca, as abas embaixo (onde o polegar
// alcança) e a tela da rota. Quem decide o que a pessoa pode é `/api/v1/eu` —
// e de novo cada rota da API, que é onde a permissão vale.
export function App() {
  const [eu, setEu] = useState<Eu | null>(null)
  const [erro, setErro] = useState<unknown>(null)
  const [semRede, setSemRede] = useState(navigator.onLine === false)
  const rota = useRota()

  useEffect(() => {
    api.eu().then(setEu).catch(setErro)
    const liga = () => setSemRede(false)
    const desliga = () => setSemRede(true)
    window.addEventListener('online', liga)
    window.addEventListener('offline', desliga)
    return () => {
      window.removeEventListener('online', liga)
      window.removeEventListener('offline', desliga)
    }
  }, [])

  const podeEntregar = eu?.permissoes.includes('epi.entregar') ?? false
  const podeChamada = eu?.permissoes.includes('turma.avaliar') ?? false

  let tela: React.ReactNode = null
  if (eu) {
    if (rota.nome === 'balcao' && podeEntregar) tela = <Balcao />
    else if (rota.nome === 'chamada' && podeChamada) tela = <Chamada />
    else if (rota.nome === 'ficha' && rota.parametro) tela = <Ficha servidorId={Number(rota.parametro)} />
    else if (rota.nome === 'pendencias') tela = <Pendencias />
    else tela = <Inicio eu={eu} />
  }

  return (
    <div className="app-celular app-compilado">
      <header className="cabecalho-marca">
        <span className="nome">CSSO · app</span>
        {eu && <span className="discreto quem-esta">{eu.nome.split(' ')[0]}</span>}
        <a className="sair" href="/sair">
          sair
        </a>
      </header>
      {semRede && (
        <div className="aviso aviso-alerta sem-rede" role="status">
          <strong>Sem rede.</strong> Nada se consulta nem se grava até a conexão voltar — o que não chegou, não foi gravado.
        </div>
      )}
      <main className="conteudo celular" id="conteudo" tabIndex={-1}>
        <Recusa erro={erro} />
        {!eu && !erro && <Carregando o="o app" />}
        {tela}
      </main>
      <nav className="abas-celular" aria-label="O que fazer">
        <a href="#/" className={rota.nome === 'inicio' ? 'ativo' : ''} aria-current={rota.nome === 'inicio' ? 'page' : undefined}>
          Início
        </a>
        {podeEntregar && (
          <a href="#/balcao" className={rota.nome === 'balcao' ? 'ativo' : ''} aria-current={rota.nome === 'balcao' ? 'page' : undefined}>
            Balcão
          </a>
        )}
        {podeChamada && (
          <a href="#/chamada" className={rota.nome === 'chamada' ? 'ativo' : ''} aria-current={rota.nome === 'chamada' ? 'page' : undefined}>
            Chamada
          </a>
        )}
        <a href="#/pendencias" className={rota.nome === 'pendencias' ? 'ativo' : ''} aria-current={rota.nome === 'pendencias' ? 'page' : undefined}>
          Pendências
        </a>
      </nav>
    </div>
  )
}
