// Um roteador por âncora, de vinte linhas — e por que não é o react-router.
//
// As telas do app são poucas e planas (`#/`, `#/balcao`, `#/chamada`,
// `#/ficha/12`, `#/pendencias`), e o que se precisa delas é o que a âncora já
// dá de graça: o botão de voltar do navegador, o link que se copia, e a
// página servida por UMA rota do servidor (`/app`) sem reescrita de caminho.
// O react-router traria isso e mais 40 KB para resolver problemas que este
// app não tem. Quando tiver, troca-se aqui, num arquivo só.
import { useEffect, useState } from 'react'

export type Rota = { nome: string; parametro: string | null }

function ler(): Rota {
  const partes = window.location.hash.replace(/^#\/?/, '').split('/')
  return { nome: partes[0] || 'inicio', parametro: partes[1] ?? null }
}

export function useRota(): Rota {
  const [rota, setRota] = useState<Rota>(ler)
  useEffect(() => {
    const ao = () => setRota(ler())
    window.addEventListener('hashchange', ao)
    return () => window.removeEventListener('hashchange', ao)
  }, [])
  return rota
}

export function irPara(caminho: string): void {
  window.location.hash = '#/' + caminho.replace(/^\/+/, '')
}
