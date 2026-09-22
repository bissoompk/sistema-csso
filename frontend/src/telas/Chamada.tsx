import { useEffect, useState } from 'react'
import { api, dataBr, hojeIso, type GradePresenca, type TurmaResumo } from '../api'
import { Carregando, Recusa } from '../componentes/Recusa'

// A chamada como folha do dia: turma, dia, horas — e um nome por linha com
// dois marcadores. Cada toque lança pelo serviço e a grade inteira volta,
// então a frequência ao lado do nome muda no mesmo gesto.
export function Chamada() {
  const [turmas, setTurmas] = useState<TurmaResumo[] | null>(null)
  const [turma, setTurma] = useState<TurmaResumo | null>(null)
  const [dia, setDia] = useState('')
  const [horas, setHoras] = useState('')
  const [motivo, setMotivo] = useState('')
  const [grade, setGrade] = useState<GradePresenca | null>(null)
  const [erro, setErro] = useState<unknown>(null)
  const [ocupado, setOcupado] = useState<number | null>(null)

  useEffect(() => {
    api.turmas().then(setTurmas).catch(setErro)
  }, [])

  function escolherTurma(id: string) {
    const t = turmas?.find((x) => String(x.id) === id) ?? null
    setTurma(t)
    setGrade(null)
    setErro(null)
    if (!t) return
    const hoje = hojeIso()
    setDia(t.dias.includes(hoje) ? hoje : t.dias[0])
    // turma de um dia: o dia É o curso inteiro, e as horas são a carga
    setHoras(t.dias.length === 1 ? t.carga_efetiva : '')
    api.grade(t.id).then(setGrade).catch(setErro)
  }

  function marcar(inscricaoId: number, presente: boolean) {
    if (!turma) return
    setErro(null)
    setOcupado(inscricaoId)
    api
      .lancarPresenca(turma.id, { inscricao_id: inscricaoId, data: dia, presente, horas, motivo })
      .then(setGrade)
      .catch(setErro)
      .finally(() => setOcupado(null))
  }

  return (
    <section>
      <h1>Chamada</h1>
      {!turmas && !erro && <Carregando o="as turmas" />}
      {turmas && (
        <div className="campo">
          <label htmlFor="turma">Turma em andamento</label>
          <select id="turma" value={turma?.id ?? ''} onChange={(e) => escolherTurma(e.target.value)}>
            <option value="">{turmas.length ? '— escolha —' : 'nenhuma turma em andamento no seu escopo'}</option>
            {turmas.map((t) => (
              <option key={t.id} value={t.id}>
                {t.codigo} · {t.treinamento} ({t.inscritos} inscritos)
              </option>
            ))}
          </select>
        </div>
      )}

      {turma && (
        <div className="linha-campos">
          <div className="campo">
            <label htmlFor="dia">Dia</label>
            <select id="dia" value={dia} onChange={(e) => setDia(e.target.value)}>
              {turma.dias.map((d) => (
                <option key={d} value={d}>
                  {dataBr(d)}
                </option>
              ))}
            </select>
          </div>
          <div className="campo">
            <label htmlFor="horas">Horas do dia</label>
            <input id="horas" inputMode="decimal" value={horas} onChange={(e) => setHoras(e.target.value)} placeholder="h" />
            <span className="dica">Vale para cada nome marcado abaixo.</span>
          </div>
        </div>
      )}

      {grade?.retificando && (
        <div className="aviso aviso-alerta">
          Turma fora de andamento: cada lançamento é retificação e exige motivo.
          <input value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="motivo da retificação" aria-label="Motivo da retificação" />
        </div>
      )}

      <Recusa erro={erro} />

      {grade && grade.linhas.length === 0 && (
        <p className="nada">Ninguém a avaliar: a turma não tem inscrição ativa.</p>
      )}
      {grade && grade.linhas.length > 0 && (
        <ul className="lista-toque chamada" aria-live="polite">
          {grade.linhas.map((linha) => {
            const lancado = linha.por_dia[dia]
            const classe = lancado ? (lancado.presente ? 'inscrito presente' : 'inscrito falta') : 'inscrito'
            return (
              <li key={linha.inscricao_id} className={classe}>
                <div className="quem">
                  <strong>{linha.participante}</strong>
                  <span className="discreto">
                    {linha.frequencia}% · {linha.horas}h · {linha.situacao}
                  </span>
                </div>
                <div className="marcas">
                  <button
                    type="button"
                    className={'marcador' + (lancado?.presente ? ' ativo' : '')}
                    disabled={ocupado === linha.inscricao_id}
                    onClick={() => marcar(linha.inscricao_id, true)}
                  >
                    presente
                  </button>
                  <button
                    type="button"
                    className={'marcador' + (lancado && !lancado.presente ? ' ativo' : '')}
                    disabled={ocupado === linha.inscricao_id}
                    onClick={() => marcar(linha.inscricao_id, false)}
                  >
                    falta
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
