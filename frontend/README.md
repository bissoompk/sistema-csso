# O front compilado do CSSO (`/app`)

Fase 3 do plano de adesão (`PENDENCIAS.md`, "Amigável não é SPA"): um front
React + Vite + TypeScript que consome só a `/api/v1` e é servido pelo próprio
FastAPI em `/app`. Não é um segundo sistema — é a MESMA regra, chamada pela
API, desenhada de outro jeito.

## O que ele faz hoje

- **Início**: quem entrou, as pendências por escopo (contagem e fila) e as
  portas do trabalho em pé.
- **Balcão de EPI**: quem recebe → equipamento → lote → registrar, em quatro
  passos, com a recusa do serviço escrita no passo em que aconteceu.
- **Chamada**: turma em andamento, dia, horas, um nome por linha com
  presente/falta; a frequência muda ao lado do nome a cada toque.
- **Ficha de EPI** de um servidor, com vencimento de CA, troca devida e
  comprovante pendente já decididos pelo servidor.
- **Pendências**: a fila de `/pendencias`, com a âncora para o sistema completo.

## Como montar

`npm` só existe na máquina de quem desenvolve. Quem instala o sistema recebe a
pasta `app/estaticos/app/` já construída, e nada de Node.

```bash
cd frontend
npm install
npm run build      # tsc --noEmit + vite build -> ../app/estaticos/app/
npm test           # vitest (cliente da API e a tela do balcão)
```

Sem o bundle, `/app` responde 503 dizendo exatamente isto.

## Desenvolvimento com recarga a quente

```bash
# na raiz, o ambiente de teste (porta 8766)
.\INICIAR-TESTE.bat
# aqui
npm run dev        # http://127.0.0.1:5173/estaticos/app/  (proxy para /api, /login, /estaticos)
```

Entre antes pelo `/login` do ambiente de teste na mesma origem do proxy — a
sessão é o mesmo cookie.

## As decisões, e por que estão assim

- **`base: '/estaticos/app/'`**: os assets saem dentro da pasta de estáticos
  que o FastAPI já serve. Nenhuma porta nova, nenhum nginx, nenhum CDN. A CSP
  do sistema (`script-src 'self'`) autoriza o bundle como autoriza o
  `csso.js`; o `index.html` do Vite não tem script embutido, e há teste que
  reprova se um dia tiver.
- **Só o `index.html` passa por rota** (`app/rotas/aplicativo.py`), porque é
  ele que exige sessão. O bundle é público como todo estático — o que abre a
  porta é a página, e ela não abre sem o cookie do `/login`.
- **Sem react-router**: as telas são poucas e planas, e a âncora dá o botão de
  voltar e o link copiável de graça (`src/roteador.ts`, vinte linhas). Quando
  o app tiver telas aninhadas, troca-se num arquivo só.
- **A folha é a do sistema**: `csso.css` e `celular.css` vêm por `<link>`, e
  `app.css` só desenha o que não existe na tela de mesa. Nenhuma cor nova.
- **Dado pessoal não fica no navegador**: nada de `localStorage` com nome ou
  SIAPE; o service worker (o mesmo de `/celular`) guarda só a casca.
- **O cliente da API é um só** (`src/api.ts`): cabeçalho `X-Requested-With:
  fetch` em todo pedido (a guarda de CSRF do servidor), 401 vira ida ao login
  com a volta para cá, e toda recusa vira `RecusaDaApi` com `erro` e
  `motivos` — o formato único que o servidor devolve.

## O que a fase 3 responde

O front compilado rende para o trabalho em pé e custa o que se esperava: cada
tela é desenhada em TypeScript, e uma tela nova paga isso de novo. Ele faz
sentido como PRODUTO se a replicação em outras universidades for por serviço
central hospedado; para instalação em cada universidade, a tela de bolso
(`/celular`, sem build) e o sistema completo bastam. A decisão continua sendo
do dono, com a medição das seis tarefas de `entrada/ux/02_NAVEGACAO.md` §6.
