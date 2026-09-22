// A recusa, escrita no lugar onde a pessoa está olhando — o mesmo desenho
// do tratador global de `base.html`: título em negrito, motivos em lista.
import { RecusaDaApi } from '../api'

export function Recusa({ erro }: { erro: unknown }) {
  if (!erro) return null
  const recusa = erro instanceof RecusaDaApi ? erro : null
  const titulo = recusa?.message ?? (erro instanceof Error ? erro.message : 'Não deu certo.')
  const motivos = recusa?.motivos ?? []
  return (
    <div className="aviso aviso-erro" role="alert">
      <strong>{titulo}</strong>
      {motivos.length > 0 && (
        <ul>
          {motivos.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function Carregando({ o }: { o: string }) {
  return (
    <p className="discreto carregando" aria-busy="true">
      Carregando {o}…
    </p>
  )
}

export function Vazio({ fato, saida }: { fato: string; saida: string }) {
  return (
    <div className="vazio">
      <strong>{fato}</strong>
      <span>{saida}</span>
    </div>
  )
}
