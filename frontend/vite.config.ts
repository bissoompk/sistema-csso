// A configuração do front compilado — e as três decisões que ela carrega.
//
// 1. `base: '/estaticos/app/'` e `outDir: '../app/estaticos/app'`: o bundle
//    sai DENTRO da pasta de estáticos que o FastAPI já serve. Nenhum servidor
//    novo, nenhuma porta nova, nenhum CDN — é o `StaticFiles` de sempre, e a
//    CSP (`script-src 'self'`) o autoriza como autoriza o `csso.js`. Só o
//    `index.html` é servido por rota (`/app`), porque ele exige sessão.
// 2. `modulePreload.polyfill: false`: o polyfill entra como script embutido no
//    JS de entrada (não no HTML), então não conflita com a CSP; desligado só
//    porque os navegadores que o setor usa (Chrome 15x) não precisam dele, e
//    menos código é menos código.
// 3. O `proxy` do servidor de desenvolvimento manda `/api`, `/login` e
//    `/estaticos` para o ambiente de teste na 8766: em desenvolvimento a página
//    roda na 5173 com recarga a quente, e a API é a de verdade.
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/estaticos/app/',
  build: {
    outDir: '../app/estaticos/app',
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8766',
      '/login': 'http://127.0.0.1:8766',
      '/sair': 'http://127.0.0.1:8766',
      '/estaticos/css': 'http://127.0.0.1:8766',
      '/estaticos/fontes': 'http://127.0.0.1:8766',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/testes/preparar.ts'],
    globals: true,
  },
})
