/* =====================================================================
   sw.js — o service worker da tela de bolso. Guarda a CASCA, nunca o DADO.

   O que ele faz: quando a rede cai, `/celular` abre mesmo assim e diz "sem
   rede" com as próprias palavras, em vez do dinossauro do navegador. Para
   isso guarda cinco arquivos — a página, as duas folhas, os dois scripts.

   O que ele NÃO faz, de propósito: não guarda resposta nenhuma de `/api/`.
   A lista de quem recebe EPI e a folha de chamada nomeiam gente, e cache em
   disco de celular compartilhado é exatamente onde dado pessoal não pode ficar
   (ROPA §6). Pedido à API sem rede falha, e a página diz que falhou.

   Rede primeiro, cache depois: o arquivo novo de uma versão nova chega na
   abertura seguinte; o cache só fala quando a rede não fala. O nome do cache
   carrega a versão para o cache velho ser apagado na ativação.
   ===================================================================== */
var VERSAO = 'csso-celular-v1';
var CASCA = [
  '/celular',
  '/estaticos/css/csso.css',
  '/estaticos/css/celular.css',
  '/estaticos/js/csso.js',
  '/estaticos/js/celular.js'
];

self.addEventListener('install', function (evento) {
  evento.waitUntil(
    caches.open(VERSAO).then(function (cache) {
      // `/celular` exige sessão: sem ela o servidor responde 303 e o cache
      // guardaria a tela de login no lugar da página. Só se guarda o que
      // voltou 200; os estáticos voltam sempre.
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
