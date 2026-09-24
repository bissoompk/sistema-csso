/* =====================================================================
   csso.js — os comportamentos de tela que não cabem num `hx-*`.

   Este arquivo existe por uma decisão, e a decisão está escrita aqui para
   ninguém a desfazer sem ler: o sistema NÃO adota um framework de front-end
   (Alpine, Vue, React). O motivo não é gosto — é a CSP. A política de
   `app/seguranca.py` é `script-src 'self' 'nonce-…'`, sem `'unsafe-inline'` e
   sem `'unsafe-eval'`, e é ela que faz script injetado numa página não rodar.
   Todo framework que avalia expressão escrita em atributo (`x-on:click="…"`,
   `@click="…"`, `v-if="…"`) precisa de `'unsafe-eval'` para existir, e
   abrir isso para ganhar uma sintaxe é trocar a proteção contra exfiltração
   por comodidade de escrita. O que os quatro blocos abaixo fazem, um framework
   faria com menos linhas; o que ele custaria, nenhum deles custa.

   Regras da casa, as mesmas dos blocos embutidos em `base.html`:

   1. **Delegado no documento.** Um tratador por comportamento, nunca um por
      elemento — o elemento pode nascer de uma troca parcial do HTMX ou de um
      cartão trocado pelo kanban, e um tratador preso a ele morreria junto.
   2. **Contrato por atributo `data-`.** Quem quer o comportamento escreve o
      atributo; quem não escreve, não ganha. Nada aqui procura por classe de
      desenho.
   3. **Sem JavaScript nada piora.** Cada bloco melhora um caminho que já
      funciona sem ele. O atalho de teclado é atalho para um botão que está na
      tela; o rascunho local devolve o que a recarga apagaria; a máscara do NUP
      só antecipa o aviso que o servidor vai dar; o retorno do download só
      desabilita um botão que sem script continua clicável.
   4. **O servidor é a autoridade.** Nenhum bloco valida no lugar dele, e
      nenhum bloqueia um envio — a dispensa do DV, registrada em auditoria,
      precisa continuar possível para quem tem razão.
   ===================================================================== */
(function () {
  'use strict';

  function ehCampoDeTexto(el) {
    if (!el) return false;
    var tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  // -------------------------------------------------------------------
  // 1. Atalhos de teclado — os que acompanham o Ctrl+K
  //
  // `Ctrl+K` já existia (em `base.html`) e era o único: três atalhos sem
  // lista são folclore, com lista são recurso. Estes só disparam com o foco
  // FORA de campo de texto — dentro de um campo, `/` e `n` são letras.
  // `accesskey` não serve: em Chrome no Windows é `Alt+tecla` e colide com o
  // menu do navegador.
  //
  //   /      foca o filtro da lista da tela (abre a gaveta de filtros se
  //          preciso); sem filtro na tela, cai na busca global
  //   n      aciona o primeiro botão de "novo" das ações da tela
  //   Esc    num campo de busca com texto, limpa; vazio, solta o foco
  //   ?      abre a lista de atalhos
  // -------------------------------------------------------------------
  function campoDeFiltro() {
    var main = document.getElementById('conteudo') || document;
    return document.getElementById('busca-processos')
      || main.querySelector('input[type="search"]')
      || document.getElementById('busca-global');
  }

  function focar(campo) {
    if (!campo) return false;
    // campo dentro de <details> fechado não é renderizado e não recebe foco:
    // a gaveta abre antes, como o Ctrl+K de `base.html` já faz
    var gaveta = campo.closest && campo.closest('details');
    if (gaveta) gaveta.open = true;
    campo.focus();
    if (campo.select) campo.select();
    return true;
  }

  function botaoDeNovo() {
    var acoes = document.querySelector('.acoes-cabecalho');
    if (!acoes) return null;
    var candidatos = acoes.querySelectorAll('a.botao, button');
    for (var i = 0; i < candidatos.length; i++) {
      var texto = (candidatos[i].textContent || '').trim().toLowerCase();
      if (/^(nov[oa]|registrar|criar|cadastrar|abrir)\b/.test(texto)) return candidatos[i];
    }
    return null;
  }

  function dialogoDeAtalhos() {
    return document.getElementById('atalhos-do-teclado');
  }

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var alvo = e.target;
    var noCampo = ehCampoDeTexto(alvo);

    if (e.key === 'Escape') {
      var atalhos = dialogoDeAtalhos();
      if (atalhos && atalhos.open) return;  // o <dialog> fecha sozinho
      if (noCampo && alvo.type === 'search') {
        if (alvo.value) { alvo.value = ''; alvo.dispatchEvent(new Event('input', { bubbles: true })); }
        else alvo.blur();
        e.preventDefault();
      }
      return;
    }
    if (noCampo) return;
    // um <dialog> modal aberto (popup de cadastro) tem o foco preso: os
    // atalhos da tela de trás não valem lá dentro
    if (document.querySelector('dialog[open]')) return;

    if (e.key === '/') {
      if (focar(campoDeFiltro())) e.preventDefault();
    } else if (e.key === 'n' || e.key === 'N') {
      var botao = botaoDeNovo();
      if (botao) { e.preventDefault(); botao.click(); }
    } else if (e.key === '?') {
      var caixa = dialogoDeAtalhos();
      if (caixa && typeof caixa.showModal === 'function') {
        e.preventDefault();
        if (!caixa.open) caixa.showModal();
      }
    }
  });

  document.addEventListener('click', function (e) {
    var fecha = e.target.closest && e.target.closest('[data-fecha-atalhos]');
    if (fecha) { e.preventDefault(); var d = dialogoDeAtalhos(); if (d && d.open) d.close(); }
    var abre = e.target.closest && e.target.closest('[data-abre-atalhos]');
    if (abre) { e.preventDefault(); var c = dialogoDeAtalhos(); if (c && !c.open && c.showModal) c.showModal(); }
  });

  // -------------------------------------------------------------------
  // 2. O rascunho local — o formulário longo que não se apaga mais
  //
  // O caso: o editor do parecer tem um formulário principal de ~25 campos e
  // quatro camadas ao lado (acrescentar exposição, cadastrar portaria, avaliar
  // EPI, emitir). Submeter QUALQUER camada redireciona para a mesma tela, e o
  // que estava digitado no principal e ainda não salvo some. O cartão da
  // portaria existe justamente para não sair da tela — e produzia a mesma
  // perda que queria evitar.
  //
  // Contrato: `<form data-rascunho-local="chave" data-rascunho-versao="N">`.
  // O que a pessoa digita vai para o `sessionStorage` sob a chave (com atraso
  // curto, a cada `input`). Ao carregar a tela, se há rascunho guardado sob a
  // MESMA chave e a MESMA versão, e ele difere do que o servidor desenhou, os
  // campos são repostos e um aviso diz que foram — com a saída de descartar.
  // A versão é a trava: o servidor a incrementa a cada salvamento, então um
  // rascunho velho nunca se sobrepõe a um salvamento mais novo (inclusive de
  // outra pessoa). O envio bem-sucedido do PRÓPRIO formulário apaga o rascunho.
  //
  // `sessionStorage`, e não `localStorage`: morre com a aba, e o que se guarda
  // é texto de parecer — não pode sobreviver a quem fecha o navegador numa
  // máquina compartilhada.
  // -------------------------------------------------------------------
  var GUARDA_DEPOIS_DE = 400;

  function chaveDe(form) {
    return 'csso:rascunho:' + form.getAttribute('data-rascunho-local');
  }

  function camposDe(form) {
    var saida = [];
    var todos = form.querySelectorAll('input[name], select[name], textarea[name]');
    for (var i = 0; i < todos.length; i++) {
      var c = todos[i];
      if (c.type === 'hidden' || c.type === 'password' || c.type === 'file' || c.disabled) continue;
      saida.push(c);
    }
    return saida;
  }

  function lerValores(form) {
    var valores = {};
    camposDe(form).forEach(function (c) {
      if (c.type === 'checkbox' || c.type === 'radio') valores[c.name + '#' + c.value] = c.checked;
      else if (c.multiple) valores[c.name] = Array.prototype.map.call(c.selectedOptions, function (o) { return o.value; });
      else valores[c.name] = c.value;
    });
    return valores;
  }

  function aplicarValores(form, valores) {
    var repostos = 0;
    camposDe(form).forEach(function (c) {
      var chave = (c.type === 'checkbox' || c.type === 'radio') ? c.name + '#' + c.value : c.name;
      if (!(chave in valores)) return;
      var v = valores[chave];
      if (c.type === 'checkbox' || c.type === 'radio') { if (c.checked !== v) { c.checked = v; repostos++; } }
      else if (c.multiple) {
        var quer = {}; (v || []).forEach(function (x) { quer[x] = true; });
        var mudou = false;
        Array.prototype.forEach.call(c.options, function (o) { if (o.selected !== !!quer[o.value]) { o.selected = !!quer[o.value]; mudou = true; } });
        if (mudou) repostos++;
      } else if (c.value !== v) { c.value = v; repostos++; }
    });
    return repostos;
  }

  function guardar(form) {
    try {
      sessionStorage.setItem(chaveDe(form), JSON.stringify({
        versao: form.getAttribute('data-rascunho-versao') || '',
        quando: Date.now(),
        valores: lerValores(form)
      }));
    } catch (e) { /* armazenamento indisponível: o caminho comum continua */ }
  }

  function esquecer(form) {
    try { sessionStorage.removeItem(chaveDe(form)); } catch (e) { /* idem */ }
  }

  function avisarReposicao(form, quantos) {
    var anterior = form.querySelector('.aviso-rascunho-local');
    if (anterior) anterior.remove();
    var aviso = document.createElement('div');
    aviso.className = 'aviso aviso-alerta aviso-rascunho-local';
    aviso.setAttribute('role', 'status');
    aviso.innerHTML =
      '<strong>Repus ' + quantos + ' campo(s) que você tinha digitado e não salvou.</strong> ' +
      'A tela recarregou (uma camada foi gravada, ou você voltou), e o que estava só na ' +
      'tela teria sumido. Confira e salve — ou <a href="#" data-descarta-rascunho>descarte ' +
      'o que foi reposto</a> para ver o que está gravado.';
    form.insertBefore(aviso, form.firstChild);
  }

  var temporizadores = new WeakMap();

  document.addEventListener('input', function (e) {
    var form = e.target && e.target.form;
    if (!form || !form.hasAttribute('data-rascunho-local')) return;
    clearTimeout(temporizadores.get(form));
    temporizadores.set(form, setTimeout(function () { guardar(form); }, GUARDA_DEPOIS_DE));
  });

  // o envio do PRÓPRIO formulário é o único que apaga o rascunho: se a rota
  // recusar e devolver a tela, o `input` seguinte volta a guardar
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (form && form.hasAttribute && form.hasAttribute('data-rascunho-local')) {
      clearTimeout(temporizadores.get(form));
      esquecer(form);
    } else if (form && form.tagName === 'FORM') {
      // qualquer OUTRO formulário da mesma página (as camadas) garante que o
      // principal está guardado antes de a página recarregar
      var principais = document.querySelectorAll('form[data-rascunho-local]');
      for (var i = 0; i < principais.length; i++) guardar(principais[i]);
    }
  });

  document.addEventListener('click', function (e) {
    var descarta = e.target.closest && e.target.closest('[data-descarta-rascunho]');
    if (!descarta) return;
    e.preventDefault();
    var form = descarta.closest('form');
    if (!form) return;
    esquecer(form);
    // o jeito honesto de "ver o que está gravado" é pedir a tela de novo
    window.location.reload();
  });

  function reporRascunhos() {
    var forms = document.querySelectorAll('form[data-rascunho-local]');
    for (var i = 0; i < forms.length; i++) {
      var form = forms[i];
      var bruto;
      try { bruto = sessionStorage.getItem(chaveDe(form)); } catch (e) { bruto = null; }
      if (!bruto) continue;
      var guardado;
      try { guardado = JSON.parse(bruto); } catch (e) { esquecer(form); continue; }
      if (!guardado || guardado.versao !== (form.getAttribute('data-rascunho-versao') || '')) {
        // o servidor salvou depois (versão diferente): o rascunho está velho
        esquecer(form);
        continue;
      }
      var quantos = aplicarValores(form, guardado.valores || {});
      if (quantos > 0) avisarReposicao(form, quantos);
      else esquecer(form);
    }
  }

  // -------------------------------------------------------------------
  // 3. A máscara do NUP — o aviso antes do envio
  //
  // O dígito verificador é o motivo de recusa que a tela inteira de "novo
  // processo" foi desenhada para explicar, e cada divergência custava POST +
  // recarga + releitura. Aqui a MESMA conta (`app/servicos/nup.py`: módulo 11
  // com a regra do NUP, pesos 16..2 e 17..2, 11→1 e 10→0) roda a cada tecla e
  // escreve o aviso ao lado do campo. Ela NÃO bloqueia o envio: o servidor
  // continua sendo a autoridade, e a dispensa do DV — registrada em auditoria
  // — precisa continuar possível para quem conferiu no SEI.
  //
  // Contrato: `<input data-nup>`; o aviso vai para `[data-nup-aviso]` no mesmo
  // `.campo`, ou é criado logo abaixo do campo.
  // -------------------------------------------------------------------
  function digitoNup(base, pesoInicial) {
    var soma = 0;
    for (var i = 0; i < base.length; i++) soma += parseInt(base[i], 10) * (pesoInicial - i);
    var dv = 11 - (soma % 11);
    if (dv === 11) return 1;
    if (dv === 10) return 0;
    return dv;
  }

  function dvNup(base15) {
    var dv1 = digitoNup(base15, 16);
    var dv2 = digitoNup(base15 + String(dv1), 17);
    return String(dv1) + String(dv2);
  }

  function formatarNup(digitos) {
    return digitos.slice(0, 5) + '.' + digitos.slice(5, 11) + '/' + digitos.slice(11, 15) + '-' + digitos.slice(15, 17);
  }

  function avaliarNup(bruto) {
    var digitos = (bruto || '').replace(/\D/g, '');
    if (!digitos) return { estado: 'vazio' };
    if (digitos.length < 17) return { estado: 'incompleto', faltam: 17 - digitos.length };
    if (digitos.length > 17) return { estado: 'sobra', sobram: digitos.length - 17 };
    var formatado = formatarNup(digitos);
    var confere = dvNup(digitos.slice(0, 15)) === digitos.slice(15, 17);
    return { estado: confere ? 'ok' : 'dv', formatado: formatado, esperado: dvNup(digitos.slice(0, 15)) };
  }

  function avisoDoNup(campo) {
    var caixa = campo.closest('.campo') || campo.parentNode;
    var aviso = caixa.querySelector('[data-nup-aviso]');
    if (!aviso) {
      aviso = document.createElement('span');
      aviso.setAttribute('data-nup-aviso', '');
      aviso.className = 'dica nup-aviso';
      aviso.setAttribute('aria-live', 'polite');
      campo.insertAdjacentElement('afterend', aviso);
    }
    return aviso;
  }

  function atualizarNup(campo) {
    var r = avaliarNup(campo.value);
    var aviso = avisoDoNup(campo);
    aviso.classList.remove('ok', 'atencao');
    if (r.estado === 'vazio') { aviso.textContent = ''; return; }
    if (r.estado === 'incompleto') { aviso.textContent = 'faltam ' + r.faltam + ' dígito(s) — o NUP tem 17'; return; }
    if (r.estado === 'sobra') { aviso.textContent = 'sobram ' + r.sobram + ' dígito(s) — o NUP tem 17'; aviso.classList.add('atencao'); return; }
    if (r.estado === 'ok') {
      aviso.textContent = 'dígito verificador confere · ' + r.formatado;
      aviso.classList.add('ok');
    } else {
      aviso.textContent = 'dígito verificador não confere (esperado ' + r.esperado + ') — confirme no SEI; ' +
        'se o número está certo lá, marque a dispensa abaixo';
      aviso.classList.add('atencao');
    }
  }

  document.addEventListener('input', function (e) {
    if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-nup')) atualizarNup(e.target);
  });

  // ao sair do campo, a pontuação entra — é a forma canônica, a mesma que o
  // servidor grava; quem colou "23086 021284 2024 56" vê o número como ele fica
  document.addEventListener('change', function (e) {
    var campo = e.target;
    if (!campo || !campo.hasAttribute || !campo.hasAttribute('data-nup')) return;
    var r = avaliarNup(campo.value);
    if (r.formatado) campo.value = r.formatado;
  });

  // -------------------------------------------------------------------
  // 4. O retorno do download demorado
  //
  // "Gerar PDF" chama o LibreOffice com até 180 s de limite, e o gatilho era
  // um `<a href>` comum: nada mudava na tela, o botão continuava clicável, e a
  // pessoa clicava de novo. Um download não dispara evento nenhum na página —
  // a única forma de saber que ele CHEGOU é o servidor deixar uma marca que a
  // página consiga ver: um cookie com o token que a própria página mandou.
  //
  // Contrato: `<a data-baixar="Gerando o PDF…" href="…">`. No clique, o link
  // ganha `?baixar=<token>`, o rótulo vira o do atributo e o botão desliga;
  // a rota devolve o arquivo com `Set-Cookie: csso_baixou=<token>`; a página
  // observa o cookie e, ao vê-lo, religa o botão e apaga o cookie. Sem
  // resposta em 180 s o botão religa sozinho — desabilitado para sempre é pior
  // do que clicável duas vezes.
  // -------------------------------------------------------------------
  var TEMPO_MAXIMO = 180000;

  function cookieBaixou() {
    var m = document.cookie.match(/(?:^|;\s*)csso_baixou=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function apagarCookieBaixou() {
    document.cookie = 'csso_baixou=; Max-Age=0; path=/';
  }

  document.addEventListener('click', function (e) {
    var link = e.target.closest && e.target.closest('a[data-baixar]');
    if (!link || link.getAttribute('aria-busy') === 'true') { if (link) e.preventDefault(); return; }
    var token = String(Date.now()) + Math.random().toString(36).slice(2, 8);
    var url = new URL(link.href, window.location.href);
    url.searchParams.set('baixar', token);
    e.preventDefault();

    var rotuloOriginal = link.textContent;
    link.setAttribute('aria-busy', 'true');
    link.classList.add('ocupado');
    link.textContent = link.getAttribute('data-baixar') || 'Gerando…';

    var inicio = Date.now();
    var relogio = setInterval(function () {
      var chegou = cookieBaixou() === token;
      if (chegou || Date.now() - inicio > TEMPO_MAXIMO) {
        clearInterval(relogio);
        if (chegou) apagarCookieBaixou();
        link.removeAttribute('aria-busy');
        link.classList.remove('ocupado');
        link.textContent = rotuloOriginal;
      }
    }, 300);

    // o download de verdade: navegar para o arquivo não troca a página, e o
    // navegador o entrega como anexo
    window.location.assign(url.toString());
  });

  // -------------------------------------------------------------------
  // arranque
  // -------------------------------------------------------------------
  function arrancar() {
    reporRascunhos();
    var nups = document.querySelectorAll('input[data-nup]');
    for (var i = 0; i < nups.length; i++) if (nups[i].value) atualizarNup(nups[i]);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arrancar);
  else arrancar();
})();
