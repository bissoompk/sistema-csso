import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './app.css'

const raiz = document.getElementById('raiz')
if (raiz) {
  createRoot(raiz).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

// O mesmo service worker da tela de bolso: guarda a casca, nunca o dado.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {
    /* sem worker o app continua igual */
  })
}
