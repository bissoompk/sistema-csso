/* =====================================================================
   sw.js — o service worker da tela de bolso. Guarda a CASCA, nunca o DADO.

   O que ele faz: quando a rede cai, `/celular` abre mesmo assim e diz "sem
   rede" com as próprias palavras, em vez do dinossauro do navegador. Para
   isso guarda as folhas, a fonte, os ícones e os scripts — arquivos estáticos,
   iguais para todo mundo.

   O que ele NÃO faz, de propósito: não guarda resposta nenhuma de `/api/`.
   A lista de quem recebe EPI e a folha de chamada nomeiam gente, e cache em
   disco de celular compartilhado é exatamente onde dado pessoal não pode ficar
   (ROPA §6). Pedido à API sem rede falha, e a página diz que falhou.

   E NÃO GUARDA A PÁGINA `/celular`. Ela estava na casca até a v2, e ela não é
   casca: o servidor a desenha com o nome de quem entrou ("Olá, Adelaide") e com
   o que essa pessoa pode fazer. Guardada, ela ficava no disco do aparelho depois
   do "sair" — num celular de balcão, que passa de mão em mão, o próximo a abrir
   via o nome e o vínculo do anterior. No lugar dela, sem rede, sai a página
   `SEM_REDE` aqui de baixo, montada pelo próprio worker: não tem nome, não tem
   permissão, não tem dado — só o aviso e o caminho de volta. Ela usa as folhas
   guardadas, e nenhum script nem estilo embutido (a mesma regra da CSP do
   sistema, mesmo onde a CSP não chega).

   Rede primeiro, cache depois: o arquivo novo de uma versão nova chega na
   abertura seguinte; o cache só fala quando a rede não fala. O nome do cache
   carrega a versão para o cache velho ser apagado na ativação — e a v3 existe
   para isso: a ativação apaga o `csso-celular-v2`, que é o que ainda guardava a
   página com o nome. A v4 entra com a identidade da Sisa: o tema novo e o
   símbolo do cabeçalho (`marca-sisa.png`) na casca, e a ativação apaga a v3.
   ===================================================================== */
var VERSAO = 'csso-celular-v4';
var CASCA = [
  '/estaticos/css/csso.css',
  '/estaticos/css/tema.css',
  '/estaticos/css/celular.css',
  '/estaticos/fontes/inter-latin.woff2',
  '/estaticos/img/icones.svg',
  '/estaticos/img/marca-sisa.png',
  '/estaticos/js/csso.js',
  '/estaticos/js/celular.js'
];

// A página da tela de bolso quando não há rede. Texto fixo, igual para todo
// mundo: é o que pode ficar no aparelho.
var SEM_REDE =
  '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<title>CSSO no celular — sem rede</title>' +
  '<link rel="stylesheet" href="/estaticos/css/csso.css">' +
  '<link rel="stylesheet" href="/estaticos/css/tema.css">' +
  '<link rel="stylesheet" href="/estaticos/css/celular.css">' +
  '</head><body><div class="area">' +
  '<header class="cabecalho-marca"><span class="nome">CSSO · Sisa/UFVJM</span></header>' +
  '<main class="conteudo celular" id="conteudo"><div class="app-celular">' +
  '<h1>Sem rede</h1>' +
  '<div class="aviso aviso-alerta" role="status"><strong>O celular está sem conexão.</strong> ' +
  'Nada se consulta nem se grava até a rede voltar. O que não chegou ao servidor não foi gravado.</div>' +
  '<p><a class="botao" href="/celular">Tentar de novo</a></p>' +
  '</div></main></div></body></html>';

self.addEventListener('install', function (evento) {
  evento.waitUntil(
    caches.open(VERSAO).then(function (cache) {
      // Só se guarda o que voltou 200 — os estáticos voltam sempre, e nenhum
      // deles depende de sessão.
      return Promise.all(CASCA.map(function (url) {
        return fetch(url, { credentials: 'same-origin' }).then(function (resposta) {
          if (resposta.ok && resposta.type === 'basic') return cache.put(url, resposta);
        }).catch(function () { /* sem rede na instalação: fica para a próxima */ });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (evento) {
  evento.waitUntil(
    caches.keys().then(function (nomes) {
      return Promise.all(nomes.filter(function (n) { return n !== VERSAO; }).map(function (n) { return caches.delete(n); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (evento) {
  var pedido = evento.request;
  if (pedido.method !== 'GET') return;
  var url = new URL(pedido.url);
  if (url.origin !== self.location.origin) return;
  // A página: sempre da rede, nunca para o cache. Sem rede, a página fixa de
  // cima — a do servidor, com o nome de alguém, nunca chega ao disco.
  if (url.pathname === '/celular' && pedido.mode === 'navigate') {
    evento.respondWith(fetch(pedido).catch(function () {
      return new Response(SEM_REDE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }));
    return;
  }
  // só a casca; tudo o mais (a API inclusive) vai direto à rede, sem passar
  // por cache nenhum
  if (CASCA.indexOf(url.pathname) === -1) return;

  evento.respondWith(
    fetch(pedido).then(function (resposta) {
      if (resposta.ok && resposta.type === 'basic') {
        var copia = resposta.clone();
        caches.open(VERSAO).then(function (cache) { cache.put(url.pathname, copia); });
      }
      return resposta;
    }).catch(function () {
      return caches.match(url.pathname).then(function (guardado) {
        return guardado || new Response('Sem rede, e esta parte da tela ainda não foi guardada.', {
          status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      });
    })
  );
});
