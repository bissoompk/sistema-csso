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
    // as ações da tela moram na faixa `.acoes-pagina`, abaixo do cabeçalho
    // (`base.html`); `.acoes-cabecalho` fica como recuo para a casca antiga
    var acoes = document.querySelector('.acoes-pagina') || document.querySelector('.acoes-cabecalho');
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

  // `form.elements`, e não os descendentes: o campo ligado de fora pelo
  // atributo `form=` (os de EPI do editor do parecer moram no fim da página)
  // também é do formulário, e o `input` acima já o trata assim.
  function camposDe(form) {
    var saida = [];
    var todos = form.elements;
    for (var i = 0; i < todos.length; i++) {
      var c = todos[i];
      if (!c.name || !/^(INPUT|SELECT|TEXTAREA)$/.test(c.tagName)) continue;
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

  // A DISPENSA DO DV SÓ APARECE QUANDO É O CASO. A caixa "dígito verificador
  // diverge, mas confirmei no SEI" ficava à vista em todo cadastro, com um
  // parágrafo de auditoria embaixo, para o NUP que confere — e o que confere é
  // quase sempre. Agora, com JavaScript, o bloco marcado `data-nup-dispensa`
  // fica oculto enquanto o DV confere ou o número está incompleto, e aparece
  // quando o DV não confere. Ele NUNCA some se já vier marcado (a recusa que
  // voltou com a dispensa escolhida) ou com `data-nup-dispensa="aberta"` (a
  // rota recusou pelo DV e quer a caixa à vista): esconder uma escolha feita é
  // esconder o que vai ser gravado. Sem JavaScript ninguém escreve `hidden`, e
  // o bloco fica sempre à vista, como era.
  function atualizarDispensa(campo, estado) {
    var escopo = campo.form || document;
    var blocos = escopo.querySelectorAll('[data-nup-dispensa]');
    for (var i = 0; i < blocos.length; i++) {
      var bloco = blocos[i];
      var caixa = bloco.querySelector('input[type="checkbox"]');
      var fixo = bloco.getAttribute('data-nup-dispensa') === 'aberta' || (caixa && caixa.checked);
      bloco.hidden = !(fixo || estado === 'dv');
    }
  }

  function atualizarNup(campo) {
    var r = avaliarNup(campo.value);
    var aviso = avisoDoNup(campo);
    atualizarDispensa(campo, r.estado);
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
  // 5. Reaproveitar a descrição da turma anterior
  //
  // Contrato: `<button type="button" data-reusar-descricao="<id da caixa>">`,
  // com o texto em `data-texto`, ou com `data-de="<id do select>"` — e aí o
  // texto vem do `data-descricao` da opção escolhida (a última turma daquele
  // treinamento). O botão nasce `hidden`: sem JavaScript ele não faria nada.
  // A caixa com texto não é sobrescrita sem confirmação de quem digitou — o
  // botão só preenche caixa vazia; com texto, acrescenta embaixo.
  // -------------------------------------------------------------------
  document.addEventListener('click', function (e) {
    var botao = e.target.closest && e.target.closest('button[data-reusar-descricao]');
    if (!botao) return;
    var caixa = document.getElementById(botao.getAttribute('data-reusar-descricao'));
    if (!caixa) return;
    var texto = botao.getAttribute('data-texto') || '';
    var de = botao.getAttribute('data-de');
    if (de) {
      var select = document.getElementById(de);
      var opcao = select && select.options[select.selectedIndex];
      texto = (opcao && opcao.getAttribute('data-descricao')) || '';
    }
    var aviso = document.getElementById(botao.id + '-aviso');
    if (!texto) {
      if (aviso) aviso.textContent = de && select && !select.value
        ? 'Escolha o treinamento primeiro.'
        : 'Nenhuma turma anterior deste treinamento tem descrição.';
      return;
    }
    caixa.value = caixa.value.trim() ? caixa.value.replace(/\s+$/, '') + '\n\n' + texto : texto;
    if (aviso) aviso.textContent = 'Descrição da turma anterior copiada — ajuste o que mudou.';
    caixa.focus();
  });

  // -------------------------------------------------------------------
  // Copiar para a área de transferência — o link público, a mensagem de
  // divulgação. Como no IntegraSST, um botão ao lado do campo.
  //
  // Contrato: `<button type="button" data-copiar="<id do campo>">`. O botão
  // nasce `hidden`: sem JavaScript o campo continua lá, selecionável. Sem a
  // API (página fora de HTTPS), cai no `select()` + `execCommand`.
  // -------------------------------------------------------------------
  document.addEventListener('click', function (e) {
    var botao = e.target.closest && e.target.closest('button[data-copiar]');
    if (!botao) return;
    var campo = document.getElementById(botao.getAttribute('data-copiar'));
    if (!campo) return;
    var rotulo = botao.getAttribute('data-rotulo') || botao.textContent;
    botao.setAttribute('data-rotulo', rotulo);
    function pronto() {
      botao.textContent = 'Copiado ✓';
      setTimeout(function () { botao.textContent = rotulo; }, 2000);
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(campo.value).then(pronto, function () {
        campo.select(); document.execCommand('copy'); pronto();
      });
    } else {
      campo.select(); document.execCommand('copy'); pronto();
    }
  });

  // -------------------------------------------------------------------
  // 6. O CNPJ — o mesmo aviso do NUP, para o fornecedor
  //
  // A conta é a da Receita: módulo 11, pesos 5..2 e 9..2 para o primeiro
  // dígito, 6..2 e 9..2 para o segundo, resto menor que 2 vira 0; cada posição
  // vale o código ASCII menos 48, o que cobre o CNPJ alfanumérico (letras nas
  // 12 primeiras posições, desde julho de 2026). A mesma regra de
  // `epi_estoque.normalizar_cnpj` — o aviso não pode dizer "confere" a um
  // número que o servidor vai recusar. NÃO bloqueia o envio nem reescreve o
  // campo: quem grava e normaliza é o servidor.
  //
  // Contrato: `<input data-cnpj>`; o aviso vai para `[data-cnpj-aviso]` no
  // mesmo `.campo`, ou é criado logo abaixo do campo.
  // -------------------------------------------------------------------
  function digitoCnpj(base, pesos) {
    var soma = 0;
    for (var i = 0; i < base.length; i++) soma += (base.charCodeAt(i) - 48) * pesos[i];
    var resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  }

  function avaliarCnpj(bruto) {
    var d = (bruto || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
    if (!d) return { estado: 'vazio' };
    if (d.length < 14) return { estado: 'incompleto', faltam: 14 - d.length };
    if (d.length > 14) return { estado: 'sobra', sobram: d.length - 14 };
    if (/^(.)\1{13}$/.test(d)) return { estado: 'repetido' };
    var formatado = d.slice(0, 2) + '.' + d.slice(2, 5) + '.' + d.slice(5, 8) + '/' + d.slice(8, 12) + '-' + d.slice(12);
    if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(d)) return { estado: 'dv', formatado: formatado };
    var dv1 = digitoCnpj(d.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
    var dv2 = digitoCnpj(d.slice(0, 12) + dv1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
    return { estado: (String(dv1) + dv2) === d.slice(12) ? 'ok' : 'dv', formatado: formatado };
  }

  function avisoDoCnpj(campo) {
    var caixa = campo.closest('.campo') || campo.parentNode;
    var aviso = caixa.querySelector('[data-cnpj-aviso]');
    if (!aviso) {
      aviso = document.createElement('span');
      aviso.setAttribute('data-cnpj-aviso', '');
      aviso.className = 'dica cnpj-aviso';
      aviso.setAttribute('aria-live', 'polite');
      campo.insertAdjacentElement('afterend', aviso);
    }
    return aviso;
  }

  function atualizarCnpj(campo) {
    var r = avaliarCnpj(campo.value);
    var aviso = avisoDoCnpj(campo);
    aviso.classList.remove('ok', 'atencao');
    if (r.estado === 'vazio') { aviso.textContent = ''; return; }
    if (r.estado === 'incompleto') { aviso.textContent = 'faltam ' + r.faltam + ' caractere(s) — o CNPJ tem 14'; return; }
    if (r.estado === 'sobra') { aviso.textContent = 'sobram ' + r.sobram + ' caractere(s) — o CNPJ tem 14'; aviso.classList.add('atencao'); return; }
    if (r.estado === 'repetido') { aviso.textContent = 'CNPJ inválido: todos os caracteres iguais'; aviso.classList.add('atencao'); return; }
    if (r.estado === 'ok') { aviso.textContent = 'dígito verificador confere · ' + r.formatado; aviso.classList.add('ok'); return; }
    aviso.textContent = 'dígito verificador não confere — confira o número na nota fiscal ou no cartão CNPJ';
    aviso.classList.add('atencao');
  }

  document.addEventListener('input', function (e) {
    if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-cnpj')) atualizarCnpj(e.target);
  });

  // -------------------------------------------------------------------
  // 7. O campo que só existe para uma escolha
  //
  // "Motivo da recusa" só quando a decisão é recusar; "qual outro" só quando a
  // opção é Outro. Sem isto o formulário mostra todos os campos de todas as
  // escolhas ao mesmo tempo, e a pessoa preenche o que não devia.
  //
  // Contrato: `data-mostra-quando="<name>=<VALOR>|<VALOR2>"` num invólucro. Ele
  // fica `hidden` enquanto o campo de mesmo `name` no mesmo formulário (select,
  // rádio ou caixa) não tem um desses valores. Sem JavaScript, tudo à vista.
  //
  // O `required` de dentro sai enquanto o invólucro está oculto e volta quando
  // ele aparece: campo obrigatório escondido faz o navegador recusar o envio
  // com um aviso que aponta para um campo que a pessoa não vê. Os campos NÃO são
  // desligados — o servidor continua decidindo o que vale do que chegou.
  // -------------------------------------------------------------------
  function valoresDe(escopo, nome) {
    var valores = [];
    var campos = escopo.querySelectorAll('[name]');
    for (var i = 0; i < campos.length; i++) {
      var c = campos[i];
      if (c.name !== nome || c.disabled) continue;
      if (c.type === 'checkbox' || c.type === 'radio') { if (c.checked) valores.push(c.value); }
      else if (c.tagName === 'SELECT') {
        for (var j = 0; j < c.options.length; j++) if (c.options[j].selected) valores.push(c.options[j].value);
      } else valores.push(c.value);
    }
    return valores;
  }

  function avaliarMostraQuando(involucro) {
    var regra = involucro.getAttribute('data-mostra-quando') || '';
    var corte = regra.indexOf('=');
    if (corte < 1) return;
    var nome = regra.slice(0, corte);
    var aceitos = regra.slice(corte + 1).split('|');
    var escopo = involucro.closest('form') || document;
    var atuais = valoresDe(escopo, nome);
    var mostra = false;
    for (var i = 0; i < atuais.length; i++) if (aceitos.indexOf(atuais[i]) !== -1) { mostra = true; break; }
    involucro.hidden = !mostra;
    var obrigatorios = involucro.querySelectorAll(mostra ? '[data-era-obrigatorio]' : '[required]');
    for (var k = 0; k < obrigatorios.length; k++) {
      if (mostra) { obrigatorios[k].required = true; obrigatorios[k].removeAttribute('data-era-obrigatorio'); }
      else { obrigatorios[k].required = false; obrigatorios[k].setAttribute('data-era-obrigatorio', ''); }
    }
  }

  function avaliarTodosMostraQuando(raiz) {
    var involucros = (raiz || document).querySelectorAll('[data-mostra-quando]');
    for (var i = 0; i < involucros.length; i++) avaliarMostraQuando(involucros[i]);
  }

  // -------------------------------------------------------------------
  // 8. Marcar todos de um grupo
  //
  // Contrato: `<input type="checkbox" data-marca-grupo="g">` marca e desmarca
  // todos os `input[type=checkbox][data-grupo="g"]` do mesmo formulário (os
  // desligados ficam como estão), e fica indeterminado quando a seleção é
  // parcial. Cada caixa marcada aqui dispara o seu `change`, para quem conta a
  // seleção (a barra de lote) contar também. Sem JavaScript, as caixas uma a uma.
  // -------------------------------------------------------------------
  function membrosDoGrupo(mestre) {
    var escopo = mestre.form || document;
    var grupo = mestre.getAttribute('data-marca-grupo');
    var todos = escopo.querySelectorAll('input[type="checkbox"][data-grupo]');
    var saida = [];
    for (var i = 0; i < todos.length; i++) {
      if (todos[i].getAttribute('data-grupo') === grupo && !todos[i].disabled) saida.push(todos[i]);
    }
    return saida;
  }

  function sincronizarMestre(mestre) {
    var membros = membrosDoGrupo(mestre);
    var marcados = 0;
    for (var i = 0; i < membros.length; i++) if (membros[i].checked) marcados++;
    mestre.checked = membros.length > 0 && marcados === membros.length;
    mestre.indeterminate = marcados > 0 && marcados < membros.length;
  }

  function mestresDe(caixa) {
    var escopo = caixa.form || document;
    var grupo = caixa.getAttribute('data-grupo');
    var todos = escopo.querySelectorAll('input[type="checkbox"][data-marca-grupo]');
    var saida = [];
    for (var i = 0; i < todos.length; i++) if (todos[i].getAttribute('data-marca-grupo') === grupo) saida.push(todos[i]);
    return saida;
  }

  var propagandoGrupo = false;

  document.addEventListener('change', function (e) {
    var alvo = e.target;
    if (!alvo || !alvo.hasAttribute) return;
    // o campo de que algum invólucro depende
    if (alvo.name) {
      var escopo = alvo.form || document;
      var involucros = escopo.querySelectorAll('[data-mostra-quando]');
      for (var i = 0; i < involucros.length; i++) avaliarMostraQuando(involucros[i]);
    }
    if (alvo.hasAttribute('data-marca-grupo') && !propagandoGrupo) {
      var membros = membrosDoGrupo(alvo);
      propagandoGrupo = true;
      for (var j = 0; j < membros.length; j++) {
        if (membros[j].checked !== alvo.checked) {
          membros[j].checked = alvo.checked;
          membros[j].dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      propagandoGrupo = false;
      alvo.indeterminate = false;
    } else if (alvo.hasAttribute('data-grupo') && !propagandoGrupo) {
      mestresDe(alvo).forEach(sincronizarMestre);
    }
    // a caixa da dispensa desmarcada à mão volta a seguir o DV
    if (alvo.closest && alvo.closest('[data-nup-dispensa]')) {
      var nup = (alvo.form || document).querySelector('input[data-nup]');
      if (nup) atualizarDispensa(nup, avaliarNup(nup.value).estado);
    }
  });

  // -------------------------------------------------------------------
  // 9. A barra de lote e o contador de seleção
  //
  // Contrato: `<section data-barra-lote="g">` é a barra das ações em lote do
  // grupo `g` (as caixas `data-grupo="g"` da seção 8); `[data-conta-grupo="g"]`
  // escreve "N selecionado(s)". A barra ganha `.flutuante` no arranque — só
  // quando há script para trazê-la de volta, porque `.flutuante` a esconde — e
  // `.tem-selecao` enquanto há alguma caixa marcada. Sem JavaScript a barra
  // fica onde está no HTML, alcançável rolando. Era um `<script>` na lista de
  // processos; aqui, a próxima lista com lote nasce com o mesmo gesto.
  // -------------------------------------------------------------------
  function contarGrupo(grupo) {
    var caixas = document.querySelectorAll('input[type="checkbox"][data-grupo]');
    var n = 0;
    for (var i = 0; i < caixas.length; i++) {
      if (caixas[i].getAttribute('data-grupo') === grupo && caixas[i].checked) n++;
    }
    return n;
  }

  function atualizarBarrasDeLote() {
    var contadores = document.querySelectorAll('[data-conta-grupo]');
    for (var i = 0; i < contadores.length; i++) {
      var n = contarGrupo(contadores[i].getAttribute('data-conta-grupo'));
      contadores[i].textContent = n + (n === 1 ? ' selecionado' : ' selecionados');
    }
    var barras = document.querySelectorAll('[data-barra-lote]');
    for (var j = 0; j < barras.length; j++) {
      barras[j].classList.add('flutuante');
      barras[j].classList.toggle('tem-selecao', contarGrupo(barras[j].getAttribute('data-barra-lote')) > 0);
    }
  }

  document.addEventListener('change', function (e) {
    var alvo = e.target;
    if (alvo && alvo.hasAttribute && (alvo.hasAttribute('data-grupo') || alvo.hasAttribute('data-marca-grupo'))) {
      atualizarBarrasDeLote();
    }
  });

  // o que entra por troca parcial nasce sem a avaliação do arranque
  document.addEventListener('htmx:afterSwap', function (e) {
    var raiz = (e.detail && e.detail.target) || document;
    avaliarTodosMostraQuando(raiz.querySelectorAll ? raiz : document);
    var mestres = document.querySelectorAll('input[type="checkbox"][data-marca-grupo]');
    for (var i = 0; i < mestres.length; i++) sincronizarMestre(mestres[i]);
    atualizarBarrasDeLote();
  });

  // -------------------------------------------------------------------
  // arranque
  // -------------------------------------------------------------------
  function arrancar() {
    reporRascunhos();
    var reusar = document.querySelectorAll('button[data-reusar-descricao]');
    for (var j = 0; j < reusar.length; j++) reusar[j].hidden = false;
    var copiar = document.querySelectorAll('button[data-copiar]');
    for (var k = 0; k < copiar.length; k++) copiar[k].hidden = false;
    var nups = document.querySelectorAll('input[data-nup]');
    for (var i = 0; i < nups.length; i++) {
      if (nups[i].value) atualizarNup(nups[i]);
      else atualizarDispensa(nups[i], 'vazio');
    }
    var cnpjs = document.querySelectorAll('input[data-cnpj]');
    for (var c = 0; c < cnpjs.length; c++) if (cnpjs[c].value) atualizarCnpj(cnpjs[c]);
    avaliarTodosMostraQuando(document);
    var mestres = document.querySelectorAll('input[type="checkbox"][data-marca-grupo]');
    for (var m = 0; m < mestres.length; m++) sincronizarMestre(mestres[m]);
    atualizarBarrasDeLote();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arrancar);
  else arrancar();
})();
