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
      // `:disabled`, e não `.disabled`: o campo dentro de `<fieldset disabled>`
      // tem a propriedade falsa e, mesmo assim, não é editável nem enviado
      if (c.type === 'hidden' || c.type === 'password' || c.type === 'file' || c.matches(':disabled')) continue;
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

  // -------------------------------------------------------------------
  // 9b. Trocar um campo recarrega o bloco que depende dele
  //
  // Contrato: `data-ao-trocar-dispara="#seletor"` num contêiner. Um `change`
  // dentro dele (o seletor de servidor do balcão, que a busca HTMX substitui
  // inteiro — por isso o atributo fica no contêiner, e não no `<select>`)
  // dispara `change` no alvo, se ele já tem valor: o alvo faz o próprio
  // `hx-get`. Usado no balcão de EPI: trocar quem recebe atualiza a etiqueta de
  // treinamento do item já escolhido. Sem JavaScript, a conferência ao gravar
  // continua valendo.
  // -------------------------------------------------------------------
  document.addEventListener('change', function (e) {
    var dono = e.target && e.target.closest && e.target.closest('[data-ao-trocar-dispara]');
    if (!dono) return;
    var alvo = document.querySelector(dono.getAttribute('data-ao-trocar-dispara'));
    if (!alvo || !alvo.value || alvo === e.target) return;
    if (window.htmx) window.htmx.trigger(alvo, 'change');
    else alvo.dispatchEvent(new Event('change', { bubbles: true }));
  });

  // -------------------------------------------------------------------
  // 10. O menu do celular fecha como camada
  //
  // Contrato: `<summary data-menu-celular>` dentro do `<details>` do "Menu"
  // (`base.html`). Abaixo de 900px o menu aberto é uma camada do tamanho da
  // tela, e camada que só fecha no próprio botão prende quem abriu sem querer:
  // `Esc` fecha e devolve o foco ao "Menu" (quem está no teclado continua de
  // onde saiu), e o toque fora da lateral fecha sem engolir o toque — o link
  // tocado continua sendo seguido. Não fecha por cima de um popup aberto: ali o
  // `Esc` é do popup. Sem JavaScript o "Menu" abre e fecha como sempre.
  // -------------------------------------------------------------------
  function menuCelularAberto() {
    var resumo = document.querySelector('summary[data-menu-celular]');
    var menu = resumo && resumo.parentElement;
    return (menu && menu.open) ? menu : null;
  }

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    var menu = menuCelularAberto();
    if (!menu || document.querySelector('dialog[open]')) return;
    menu.open = false;
    var resumo = menu.querySelector('summary[data-menu-celular]');
    if (resumo) resumo.focus();
    e.preventDefault();
  });

  document.addEventListener('click', function (e) {
    var menu = menuCelularAberto();
    if (!menu || !e.target || !e.target.closest) return;
    var lateral = menu.parentElement;
    if (lateral && !lateral.contains(e.target)) menu.open = false;
  });

  // -------------------------------------------------------------------
  // 11. Recolher a lateral (só no computador)
  //
  // Contrato: `<button data-recolher-lateral aria-expanded>` no alto da
  // lateral (`base.html`). O clique, ou `Ctrl+B` (`Cmd+B` no Mac), troca a
  // classe `lateral-recolhida` do <html>, o `aria-expanded` e o `title` do
  // botão, e grava a escolha no cookie `csso_lateral` por um ano. Quem desenha
  // a faixa é a folha; quem aplica a classe ao carregar a tela é o SERVIDOR,
  // que lê o mesmo cookie (`base.html`) — por isso a página não "pisca"
  // aberta antes de recolher. Este bloco só alterna e grava.
  //
  // O atalho não vale com o foco num campo de texto nem no editor do parecer
  // (`contenteditable`): ali `Ctrl+B` é negrito. Também não vale no celular
  // (até 900px), onde a lateral é o "Menu" e a classe é ignorada, nem por cima
  // de um popup aberto. Expandir APAGA o cookie: aberta é o padrão.
  // -------------------------------------------------------------------
  var COOKIE_LATERAL = 'csso_lateral';
  var naMesa = window.matchMedia ? window.matchMedia('(min-width: 901px)') : null;

  function alternarLateral() {
    var raiz = document.documentElement;
    var recolher = !raiz.classList.contains('lateral-recolhida');
    raiz.classList.toggle('lateral-recolhida', recolher);
    var botoes = document.querySelectorAll('[data-recolher-lateral]');
    for (var i = 0; i < botoes.length; i++) {
      botoes[i].setAttribute('aria-expanded', recolher ? 'false' : 'true');
      botoes[i].title = (recolher ? 'Expandir' : 'Recolher') + ' o menu (Ctrl+B)';
    }
    var seguro = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = recolher
      ? COOKIE_LATERAL + '=recolhida; Max-Age=31536000; Path=/; SameSite=Lax' + seguro
      : COOKIE_LATERAL + '=; Max-Age=0; Path=/; SameSite=Lax' + seguro;
  }

  document.addEventListener('click', function (e) {
    var botao = e.target.closest && e.target.closest('[data-recolher-lateral]');
    if (!botao) return;
    e.preventDefault();
    alternarLateral();
  });

  document.addEventListener('keydown', function (e) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if (e.key !== 'b' && e.key !== 'B') return;
    if (ehCampoDeTexto(e.target)) return;
    if (naMesa && !naMesa.matches) return;
    if (document.querySelector('dialog[open]')) return;
    if (!document.querySelector('[data-recolher-lateral]')) return;  // tela sem casca
    e.preventDefault();
    alternarLateral();
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
  // 12. O desligamento por inatividade — o aviso antes de a sessão cair
  //
  // Contrato: `<body data-sessao-inatividade="60">`, escrito pela casca
  // (`base.html`) só em página logada e só com o limite ligado
  // (`CSSO_SESSAO_INATIVIDADE_MINUTOS`). Quem derruba a sessão é o SERVIDOR
  // (`sessao_valida`); este bloco só avisa antes e, no fim, leva ao login com a
  // explicação escrita (`/login?motivo=inatividade`). Sem JavaScript a sessão
  // cai do mesmo jeito e o próximo clique leva ao login com "sessão expirou".
  //
  // O QUE CONTA COMO ATIVIDADE é o que o servidor conta: pedido. Carregar a
  // página, enviar formulário, a troca parcial do HTMX, o download do bloco 4 e
  // o "Continuar conectado". Mexer o mouse não conta — o servidor não vê o
  // mouse, e contar aqui o que lá não conta faria o aviso prometer um prazo que
  // a sessão não tem. A exceção é DIGITAR num campo: o parecer e as atas se
  // escrevem por mais de uma hora sem envio, e a sessão vencida no salvamento
  // perderia o texto. Digitar renova a sessão no servidor com um GET leve a
  // `/quem-sou-eu` (que passa por `sessao_valida` e regrava o último uso), no
  // máximo um a cada 5 minutos — é a mesma requisição do botão.
  //
  // VÁRIAS ABAS: o horário da última atividade vai para o `localStorage`
  // (`sisa.sessao.ultima-atividade`), e cada aba conta a partir do mais recente
  // entre o dela e o guardado. A aba esquecida não derruba a sessão que outra
  // aba está usando, e o evento `storage` fecha o aviso nas outras abas quando
  // uma renova. Sem `localStorage` (bloqueado, modo privado) cada aba conta só
  // o que é dela.
  //
  // O aviso abre 5 minutos antes, com contagem regressiva e o foco em
  // "Continuar conectado". `Esc` NÃO desconecta: ele vale como "continuar" (é
  // gesto de quem está ali). Com `prefers-reduced-motion` a contagem não corre
  // de segundo em segundo: mostra os minutos. O leitor de tela ouve o texto ao
  // abrir e um lembrete por minuto, não um número por segundo.
  // -------------------------------------------------------------------
  (function () {
    var corpo = document.body;
    var minutos = corpo ? parseInt(corpo.getAttribute('data-sessao-inatividade') || '', 10) : NaN;
    if (!(minutos > 0)) return;
    var LIMITE = minutos * 60000;
    var ANTECEDENCIA = Math.min(5 * 60000, LIMITE / 2);
    var RENOVA_DIGITANDO = 5 * 60000;
    var CHAVE = 'sisa.sessao.ultima-atividade';
    var poucoMovimento = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

    var ultima = Date.now();
    var dialogo = null;
    var focoAntes = null;
    var saindo = false;
    var renovando = false;
    var ultimoFalado = null;

    function guardada() {
      try {
        var v = parseInt(localStorage.getItem(CHAVE) || '', 10);
        // valor do futuro é relógio mexido ou chave escrita à mão: não adia nada
        return isFinite(v) ? Math.min(v, Date.now()) : 0;
      } catch (e) { return 0; }
    }

    function guardar() {
      try { if (guardada() < ultima) localStorage.setItem(CHAVE, String(ultima)); } catch (e) { /* sem armazenamento */ }
    }

    function marcar() {
      ultima = Date.now();
      guardar();
      verificar();
    }

    function irAoLogin() {
      saindo = true;
      location.replace('/login?motivo=inatividade&proximo=' +
        encodeURIComponent(location.pathname + location.search));
    }

    // No prazo, a sessão é encerrada no servidor também (o servidor a daria por
    // vencida sozinho no minuto seguinte — `sessao_valida` tolera um passo do
    // último uso); quem chega ao login não deixa uma sessão viva para trás.
    function encerrar() {
      if (saindo) return;
      saindo = true;
      try {
        fetch('/sair', { method: 'POST', credentials: 'same-origin', redirect: 'manual', keepalive: true })
          .then(irAoLogin, irAoLogin);
      } catch (e) { irAoLogin(); }
    }

    function texto(ms) {
      var min = Math.max(1, Math.ceil(ms / 60000));
      return min === 1 ? '1 minuto' : min + ' minutos';
    }

    function construir() {
      dialogo = document.createElement('dialog');
      dialogo.className = 'popup popup-info popup-inatividade';
      dialogo.setAttribute('role', 'alertdialog');
      dialogo.setAttribute('aria-labelledby', 'inatividade-titulo');
      dialogo.setAttribute('aria-describedby', 'inatividade-texto');
      dialogo.innerHTML =
        '<div class="popup-caixa popup-caixa-info">' +
          '<div class="popup-topo"><div class="popup-titulo">' +
            '<h2 id="inatividade-titulo">Você ainda está aí?</h2></div></div>' +
          '<div class="popup-corpo">' +
            '<p id="inatividade-texto">Por segurança, você será desconectado em ' +
              '<span data-inatividade-prazo>5 minutos</span> por inatividade.</p>' +
            '<p class="contagem-inatividade" aria-hidden="true">Tempo restante: ' +
              '<strong data-inatividade-contagem>5:00</strong></p>' +
            '<p class="oculto" aria-live="polite" data-inatividade-falado></p>' +
            '<div class="aviso aviso-erro" role="alert" data-inatividade-erro hidden></div>' +
          '</div>' +
          '<div class="acoes popup-acoes">' +
            '<button type="button" data-inatividade-continuar>Continuar conectado</button>' +
            '<form method="post" action="/sair"><button type="submit" class="secundario">Sair agora</button></form>' +
          '</div>' +
        '</div>';
      dialogo.addEventListener('click', function (e) {
        if (e.target.closest && e.target.closest('[data-inatividade-continuar]')) continuar();
      });
      // o `Esc` nativo do <dialog> (evento `cancel`) fecharia sem renovar nada
      dialogo.addEventListener('cancel', function (e) { e.preventDefault(); continuar(); });
      document.body.appendChild(dialogo);
    }

    function parte(nome) { return dialogo.querySelector('[data-inatividade-' + nome + ']'); }

    function atualizar(restante) {
      var s = Math.max(0, Math.ceil(restante / 1000));
      var reduzido = poucoMovimento && poucoMovimento.matches;
      parte('contagem').textContent = reduzido
        ? texto(restante)
        : Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
      // um lembrete por minuto (e nos 30 s finais) para o leitor de tela
      var marco = s <= 30 ? '30s' : String(Math.ceil(s / 60));
      if (marco !== ultimoFalado) {
        if (ultimoFalado !== null) {
          parte('falado').textContent = marco === '30s'
            ? 'Faltam 30 segundos para a desconexão.'
            : 'Faltam ' + texto(restante) + ' para a desconexão.';
        }
        ultimoFalado = marco;
      }
    }

    function abrirAviso(restante) {
      if (!dialogo) construir();
      if (!dialogo.open) {
        parte('prazo').textContent = texto(restante);
        parte('erro').hidden = true;
        parte('falado').textContent = '';
        ultimoFalado = null;
        focoAntes = document.activeElement;
        if (typeof dialogo.showModal === 'function') dialogo.showModal();
        else dialogo.setAttribute('open', '');
        parte('continuar').focus();
      }
      atualizar(restante);
    }

    function fecharAviso() {
      if (!dialogo || !dialogo.open) return;
      if (typeof dialogo.close === 'function') dialogo.close();
      else dialogo.removeAttribute('open');
      if (focoAntes && focoAntes.focus && document.contains(focoAntes)) focoAntes.focus();
      focoAntes = null;
    }

    function verificar() {
      if (saindo) return;
      var outra = guardada();
      if (outra > ultima) ultima = outra;
      var restante = ultima + LIMITE - Date.now();
      if (restante <= 0) encerrar();
      else if (restante <= ANTECEDENCIA) abrirAviso(restante);
      else fecharAviso();
    }

    // O GET passa por `sessao_valida`, que regrava o último uso. Devolve
    // `true` (renovada), `false` (a sessão já tinha caído) ou rejeita (rede).
    function renovar() {
      return fetch('/quem-sou-eu', {
        credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' },
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (j && j.autenticado) { marcar(); return true; }
        return false;
      });
    }

    function continuar() {
      if (renovando || saindo) return;
      renovando = true;
      var botao = parte('continuar');
      botao.setAttribute('aria-busy', 'true');
      renovar().then(function (ok) {
        renovando = false;
        botao.removeAttribute('aria-busy');
        if (!ok) irAoLogin();
      }, function () {
        renovando = false;
        botao.removeAttribute('aria-busy');
        var erro = parte('erro');
        erro.textContent = 'Não foi possível falar com o servidor agora. Confira a conexão e tente de novo.';
        erro.hidden = false;
      });
    }

    // Esc com o aviso aberto: na CAPTURA, antes do tratador dos popups de
    // `base.html` (que fecharia a camada de cima sem renovar a sessão)
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !dialogo || !dialogo.open) return;
      e.preventDefault();
      e.stopPropagation();
      continuar();
    }, true);

    document.addEventListener('submit', function (e) {
      // o "Sair agora" é o único formulário do aviso: dali não se volta
      if (dialogo && dialogo.contains(e.target)) { saindo = true; return; }
      marcar();
    }, true);
    document.addEventListener('htmx:afterRequest', function (e) {
      var xhr = e.detail && e.detail.xhr;
      if (xhr && xhr.status > 0) marcar();
    });
    document.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('a[data-baixar]')) marcar();
    }, true);
    document.addEventListener('input', function (e) {
      var alvo = e.target;
      if (!alvo || (dialogo && dialogo.open) || renovando || saindo) return;
      if (!(ehCampoDeTexto(alvo) && (alvo.form || alvo.isContentEditable))) return;
      if (Date.now() - ultima < RENOVA_DIGITANDO) return;
      renovando = true;
      // falha aqui não leva a lugar nenhum: tirar a pessoa da tela no meio do
      // texto é o que esta renovação existe para evitar; o prazo segue valendo
      renovar().then(function () { renovando = false; }, function () { renovando = false; });
    }, true);
    window.addEventListener('storage', function (e) { if (e.key === CHAVE) verificar(); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) verificar(); });
    window.addEventListener('pageshow', function (e) { if (e.persisted) verificar(); });

    marcar();
    setInterval(verificar, 1000);
  })();

  // -------------------------------------------------------------------
  // 13. A trava do envio duplicado (24/10/2026)
  //
  // O clique duplo em "Salvar", "Inscrever" ou "Entrar" mandava o formulário
  // duas vezes — duas inscrições, dois registros, duas mensagens na trilha.
  // Agora, enviado o formulário, o botão que o enviou vira "Aguarde…"
  // (`aria-busy`, anunciado ao leitor de tela) e o segundo envio do mesmo
  // formulário é recusado até a página trocar.
  //
  // - Só trava o que de fato saiu: se outro tratador cancelou o envio (o HTMX,
  //   uma conferência), nada muda.
  // - Não usa `disabled` (o botão desabilitado some do envio e da navegação
  //   por teclado); usa `aria-disabled` e a recusa do segundo envio.
  // - Formulário GET (filtros, busca) não trava: repetir não grava nada.
  // - Quem não quer a trava escreve `data-sem-trava` no form ou no botão.
  // - Formulário que responde com um arquivo não troca de página: a trava se
  //   desfaz sozinha em `DESTRAVA_EM`; voltar pelo navegador (bfcache) também
  //   desfaz. O servidor continua sendo quem impede o registro repetido; isto
  //   só tira o clique duplo do caminho.
  //
  // O HTMX tem a fila dele por elemento; aqui ele só ganha o "Aguarde…"
  // enquanto a requisição está no ar.
  // -------------------------------------------------------------------
  var DESTRAVA_EM = 8000;
  var formsEmVoo = new WeakSet();
  var travados = [];

  var anuncioEnvio = null;
  function anunciarEnvio(texto) {
    if (!anuncioEnvio) {
      anuncioEnvio = document.createElement('span');
      anuncioEnvio.className = 'oculto';
      anuncioEnvio.setAttribute('role', 'status');
      anuncioEnvio.setAttribute('aria-live', 'polite');
      document.body.appendChild(anuncioEnvio);
    }
    anuncioEnvio.textContent = texto;
  }

  function travarBotao(botao) {
    if (!botao || botao.getAttribute('aria-busy') === 'true') return;
    botao.setAttribute('data-trava-texto', botao.tagName === 'INPUT' ? botao.value : botao.innerHTML);
    botao.setAttribute('aria-busy', 'true');
    botao.setAttribute('aria-disabled', 'true');
    botao.classList.add('enviando');
    if (botao.tagName === 'INPUT') botao.value = 'Aguarde…';
    else botao.innerHTML = '<span class="enviando-giro" aria-hidden="true"></span>Aguarde…';
    travados.push(botao);
    anunciarEnvio('Enviando. Aguarde.');
  }

  function destravarBotao(botao) {
    if (!botao || !botao.hasAttribute('data-trava-texto')) return;
    var original = botao.getAttribute('data-trava-texto');
    if (botao.tagName === 'INPUT') botao.value = original;
    else botao.innerHTML = original;
    botao.removeAttribute('data-trava-texto');
    botao.removeAttribute('aria-busy');
    botao.removeAttribute('aria-disabled');
    botao.classList.remove('enviando');
  }

  function destravarTudo() {
    for (var i = 0; i < travados.length; i++) {
      destravarBotao(travados[i]);
      if (travados[i].form) formsEmVoo.delete(travados[i].form);
    }
    travados = [];
  }

  function semTrava(form, botao) {
    return form.hasAttribute('data-sem-trava') || (botao && botao.hasAttribute('data-sem-trava'))
      || (form.getAttribute('method') || 'get').toLowerCase() !== 'post'
      || (form.getAttribute('target') || '') !== '';
  }

  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || form.tagName !== 'FORM') return;
    var botao = e.submitter || form.querySelector('button[type="submit"], button:not([type]), input[type="submit"]');
    if (semTrava(form, botao)) return;
    if (formsEmVoo.has(form)) { e.preventDefault(); return; }
    formsEmVoo.add(form);
    // decide depois dos outros tratadores: se algum cancelou, não houve envio
    setTimeout(function () {
      if (e.defaultPrevented) { formsEmVoo.delete(form); return; }
      travarBotao(botao);
      setTimeout(function () { destravarBotao(botao); formsEmVoo.delete(form); }, DESTRAVA_EM);
    }, 0);
  });

  document.addEventListener('htmx:beforeRequest', function (e) {
    var elt = e.detail && e.detail.elt;
    if (!elt || elt.tagName !== 'FORM' || elt.hasAttribute('data-sem-trava')) return;
    var botao = elt.querySelector('button[type="submit"], button:not([type]), input[type="submit"]');
    if (botao && !botao.hasAttribute('data-sem-trava')) travarBotao(botao);
  });
  document.addEventListener('htmx:afterRequest', function (e) {
    var elt = e.detail && e.detail.elt;
    if (!elt || elt.tagName !== 'FORM') return;
    var botoes = elt.querySelectorAll('[data-trava-texto]');
    for (var i = 0; i < botoes.length; i++) destravarBotao(botoes[i]);
  });
  window.addEventListener('pageshow', function (e) { if (e.persisted) destravarTudo(); });

  // -------------------------------------------------------------------
  // 14. Mostrar ou ocultar a senha (24/10/2026)
  //
  // Contrato: `<input type="password" data-mostrar-senha>`. O script põe ao
  // lado um botão "Mostrar"/"Ocultar" (`aria-pressed`, com o nome do campo
  // para o leitor de tela) que troca o tipo do campo. Sem script o campo é o
  // de sempre. Ao enviar, o campo volta a `password`, para o navegador não
  // guardar a senha como texto comum no histórico do formulário.
  // -------------------------------------------------------------------
  function prepararMostrarSenha(raiz) {
    var campos = (raiz || document).querySelectorAll('input[data-mostrar-senha]');
    for (var i = 0; i < campos.length; i++) {
      var campo = campos[i];
      if (campo.hasAttribute('data-mostrar-pronto')) continue;
      campo.setAttribute('data-mostrar-pronto', '');
      var caixa = document.createElement('span');
      caixa.className = 'campo-senha';
      campo.parentNode.insertBefore(caixa, campo);
      caixa.appendChild(campo);
      var botao = document.createElement('button');
      botao.type = 'button';
      botao.className = 'mostrar-senha';
      botao.setAttribute('aria-pressed', 'false');
      var rotulo = campo.id && document.querySelector('label[for="' + campo.id + '"]');
      botao.setAttribute('aria-label', 'Mostrar ' + (rotulo ? rotulo.textContent.trim().toLowerCase() : 'senha'));
      botao.textContent = 'Mostrar';
      caixa.appendChild(botao);
    }
  }

  document.addEventListener('click', function (e) {
    var botao = e.target.closest && e.target.closest('button.mostrar-senha');
    if (!botao) return;
    var campo = botao.parentNode.querySelector('input[data-mostrar-senha]');
    if (!campo) return;
    var mostrar = campo.type === 'password';
    campo.type = mostrar ? 'text' : 'password';
    botao.textContent = mostrar ? 'Ocultar' : 'Mostrar';
    botao.setAttribute('aria-pressed', mostrar ? 'true' : 'false');
    botao.setAttribute('aria-label', botao.getAttribute('aria-label').replace(/^(Mostrar|Ocultar)/, mostrar ? 'Ocultar' : 'Mostrar'));
    campo.focus();
  });
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || !form.querySelectorAll) return;
    var abertos = form.querySelectorAll('input[data-mostrar-senha][type="text"]');
    for (var i = 0; i < abertos.length; i++) abertos[i].type = 'password';
  }, true);
  document.addEventListener('htmx:afterSwap', function (e) { prepararMostrarSenha(e.target); });

  // -------------------------------------------------------------------
  // O local da turma segue o campus (24/10/2026)
  //
  // Contrato: `<select data-filtra-campus="<id do select de campus>">`, com
  // `data-campus` em cada opcao (vazio = serve a qualquer campus). Com um
  // campus escolhido, os locais de outro campus somem da lista; se o
  // escolhido sumiu, volta para a primeira opcao ("outro local"). Sem
  // JavaScript a lista vem inteira, e o servidor recusa o local de outro campus.
  // -------------------------------------------------------------------
  function filtrarLocais(select) {
    var campus = document.getElementById(select.getAttribute('data-filtra-campus'));
    var valor = campus ? campus.value : '';
    var sumiu = false;
    for (var i = 0; i < select.options.length; i++) {
      var opcao = select.options[i];
      var dele = opcao.getAttribute('data-campus');
      var esconde = Boolean(valor && dele && dele !== valor);
      opcao.hidden = esconde;
      opcao.disabled = esconde;
      if (esconde && opcao.selected) sumiu = true;
    }
    if (sumiu) {
      select.value = '';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  function filtrarLocaisDe(campus) {
    var selects = document.querySelectorAll('select[data-filtra-campus]');
    for (var i = 0; i < selects.length; i++) {
      if (!campus || selects[i].getAttribute('data-filtra-campus') === campus.id) filtrarLocais(selects[i]);
    }
  }
  document.addEventListener('change', function (e) {
    var alvo = e.target;
    if (alvo && alvo.tagName === 'SELECT' && alvo.id) filtrarLocaisDe(alvo);
  });

  // -------------------------------------------------------------------
  // arranque
  // -------------------------------------------------------------------
  // ---------------------------------------------------------------------
  // Codigo curto do treinamento (catalogo, 22/10/2026): ele entra no numero
  // do certificado novo (`CSSO-NR35-2026-0001`). Enquanto o nome e digitado,
  // o campo recebe a sugestao — a MESMA regra de `sugerir_codigo_curto`
  // (`src/dominio/treinamento.ts`) e da trava do banco —, mas so enquanto a
  // pessoa nao mexeu nele, e so se ele abriu vazio (na edicao o codigo ja
  // existe e nao muda sozinho). Sem JavaScript, o servidor preenche a sugestao
  // do cadastro em branco.
  // Contrato: `<input data-sugerir-codigo-curto="<id do campo nome>"
  //   [data-sugerir-codigo-curto-codigo="<id do campo codigo>"]
  //   [data-sugerir-codigo-curto-codigo-fixo="<codigo do catalogo>"]>`.
  // ---------------------------------------------------------------------
  var PARTICULAS_CODIGO = { DAS: 1, DOS: 1, NOS: 1, NAS: 1, PARA: 1, COM: 1, POR: 1 };
  function semAcentoMaiusculo(texto) {
    return String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  }
  function soLetrasEAlgarismos(texto) {
    return semAcentoMaiusculo(texto).replace(/[^A-Z0-9]/g, '');
  }
  function sugerirCodigoCurto(nome, codigo) {
    var fonte = semAcentoMaiusculo((nome || '') + ' ' + (codigo || ''));
    var nr = /\bNR\s*[-–—]?\s*0*(\d{1,2})\b/.exec(fonte);
    if (nr) return 'NR' + nr[1];
    var doCodigo = soLetrasEAlgarismos(codigo).slice(0, 10);
    if (doCodigo.length >= 2) return doCodigo;
    var palavras = semAcentoMaiusculo(nome).split(/[^A-Z0-9]+/);
    var iniciais = '';
    for (var i = 0; i < palavras.length; i++) {
      if (palavras[i].length >= 3 && !PARTICULAS_CODIGO[palavras[i]]) iniciais += palavras[i].charAt(0);
    }
    iniciais = iniciais.slice(0, 6);
    if (iniciais.length >= 2) return iniciais;
    var letras = soLetrasEAlgarismos(nome).slice(0, 4);
    return letras.length >= 2 ? letras : 'TR';
  }
  function preencherCodigoCurto(campo) {
    if (campo.getAttribute('data-codigo-curto-editado')) return;
    var nome = document.getElementById(campo.getAttribute('data-sugerir-codigo-curto'));
    if (!nome) return;
    var idCodigo = campo.getAttribute('data-sugerir-codigo-curto-codigo');
    var doCodigo = idCodigo ? document.getElementById(idCodigo) : null;
    var codigo = doCodigo ? doCodigo.value : campo.getAttribute('data-sugerir-codigo-curto-codigo-fixo') || '';
    campo.value = nome.value.trim() ? sugerirCodigoCurto(nome.value, codigo) : '';
  }
  document.addEventListener('input', function (e) {
    var el = e.target;
    if (!el || el.tagName !== 'INPUT') return;
    if (el.hasAttribute('data-sugerir-codigo-curto')) {
      // a pessoa escreveu no codigo: dali em diante a sugestao nao o cobre.
      // Esvaziado, ele volta a seguir o nome.
      var inicio = el.selectionStart;
      var fim = el.selectionEnd;
      el.value = el.value.toUpperCase();
      if (inicio !== null && el.setSelectionRange) el.setSelectionRange(inicio, fim);
      if (el.value) el.setAttribute('data-codigo-curto-editado', '1');
      else {
        el.removeAttribute('data-codigo-curto-editado');
        preencherCodigoCurto(el);
      }
      return;
    }
    if (!el.id) return;
    var campos = document.querySelectorAll('input[data-sugerir-codigo-curto]');
    for (var i = 0; i < campos.length; i++) {
      if (
        campos[i].getAttribute('data-sugerir-codigo-curto') === el.id ||
        campos[i].getAttribute('data-sugerir-codigo-curto-codigo') === el.id
      ) {
        preencherCodigoCurto(campos[i]);
      }
    }
  });
  function marcarCodigosCurtosPreenchidos() {
    var campos = document.querySelectorAll('input[data-sugerir-codigo-curto]');
    for (var i = 0; i < campos.length; i++) {
      if (campos[i].value.trim()) campos[i].setAttribute('data-codigo-curto-editado', '1');
    }
  }

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
    aplicarCorTipo(document);
    marcarCodigosCurtosPreenchidos();
    filtrarLocaisDe(null);
    prepararMostrarSenha(document);
  }
  // A cor do tipo de processo no cartao do kanban vem em `data-cor-tipo` (sem
  // `style=` no HTML, pela CSP). A folha ja traduz as cores semeadas; aqui
  // entra so o hexadecimal valido que ela nao conheca. O CSSOM nao e estilo
  // inline para a CSP.
  function aplicarCorTipo(raiz) {
    var cartoes = (raiz || document).querySelectorAll('[data-cor-tipo]');
    for (var i = 0; i < cartoes.length; i++) {
      var cor = cartoes[i].getAttribute('data-cor-tipo');
      if (/^#[0-9a-f]{6}$/i.test(cor) && !getComputedStyle(cartoes[i]).getPropertyValue('--cor-tipo').trim()) {
        cartoes[i].style.setProperty('--cor-tipo', cor);
      }
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arrancar);
  else arrancar();
})();
