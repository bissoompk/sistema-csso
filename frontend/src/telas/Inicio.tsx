import { useEffect, useState } from 'react'
import { api, type Eu, type Pendencias } from '../api'
import { Carregando, Recusa, Vazio } from '../componentes/Recusa'

// A tela de entrada responde "o que eu faço agora?", e não "como vai um
// módulo": as pendências de quem entrou, por escopo, e as portas do trabalho
// em pé. É o painel transversal que a auditoria de navegação (M-1) pediu.
export function Inicio({ eu }: { eu: Eu }) {
  const [pendencias, setPendencias] = useState<Pendencias | null>(null)
  const [erro, setErro] = useState<unknown>(null)

  const podeEntregar = eu.permissoes.includes('epi.entregar')
  const podeChamada = eu.permissoes.includes('turma.avaliar')

  useEffect(() => {
    api.pendencias().then(setPendencias).catch(setErro)
  }, [])

  return (
    <section>
      <h1>Olá, {eu.nome.split(' ')[0]}</h1>
      <p className="sub">Duas coisas que se fazem em pé, longe da mesa — e o que espera por você.</p>

      {!podeEntregar && !podeChamada && (
        <Vazio
          fato="Este app ainda não tem trabalho para você."
          saida="Ele serve a quem entrega EPI no balcão (epi.entregar) e a quem lança presença de turma (turma.avaliar). O resto do sistema continua no endereço de sempre."
        />
      )}

      <div className="cartoes-inicio">
        {podeEntregar && (
          <a className="cartao-inicio" href="#/balcao">
            <strong>Balcão de EPI</strong>
            <span>quem recebe → equipamento → lote → registrar</span>
          </a>
        )}
        {podeChamada && (
          <a className="cartao-inicio" href="#/chamada">
            <strong>Chamada</strong>
            <span>a folha de presença de um dia, nome a nome</span>
          </a>
        )}
        {eu.servidor_id !== null && (
          <a className="cartao-inicio" href={`#/ficha/${eu.servidor_id}`}>
            <strong>Minha ficha de EPI</strong>
            <span>o que foi entregue a você, e quando troca</span>
          </a>
        )}
      </div>

      <h2>Pendências</h2>
      <Recusa erro={erro} />
      {!pendencias && !erro && <Carregando o="as pendências" />}
      {pendencias && pendencias.abertas === 0 && (
        <p className="discreto">Nada pendente. Bom sinal.</p>
      )}
      {pendencias && pendencias.abertas > 0 && (
        <p>
          <strong>{pendencias.abertas}</strong> aberta(s)
          {pendencias.atrasadas > 0 && (
            <>
              , <strong className="erro">{pendencias.atrasadas}</strong> atrasada(s)
            </>
          )}
          {' · '}
          <a href="#/pendencias">ver a fila</a>
        </p>
      )}

      <p className="discreto rodape-app">
        Versão {eu.versao} · <a href="/inicio">sistema completo</a> · <a href="/sair">sair</a>
      </p>
    </section>
  )
}
