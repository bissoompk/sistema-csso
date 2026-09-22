/* =====================================================================
   celular.js — a tela de bolso, inteira em cima de /api/v1.

   Mesmas regras de `csso.js`: sem framework (a CSP não tem `unsafe-eval`),
   tratadores delegados, contrato por `data-`, e o servidor é a autoridade —
   este arquivo não valida regra nenhuma, só mostra o que a API respondeu.

   O que este arquivo faz que `csso.js` não faz: ele DESENHA. A página é uma
   casca, e cada lista aqui é montada a partir de JSON. É de propósito: é a
   experiência de "front separado" da fase 3, num pedaço pequeno o bastante
   para ser jogado fora se o desenho não render.

   Dado pessoal NUNCA fica em `localStorage`/`sessionStorage`: a lista de
   quem recebe EPI e a folha de chamada nomeiam gente, e cache em celular
   compartilhado é onde isso não pode ficar. O que se guarda é só a aba em que
   a pessoa estava.
   ===================================================================== */
(function () {
  'use strict';

  var raiz = document.getElementById('app-celular');
  if (!raiz) return;

  // -------------------------------------------------------------------
  // A API
  // -------------------------------------------------------------------
  function api(metodo, caminho, corpo) {
    var opcoes = {
      method: metodo,
      headers: { 'Accept': 'application/json', 'X-Requested-With': 'fetch' },
      credentials: 'same-origin'
    };
    if (corpo !== undefined) {
      opcoes.headers['Content-Type'] = 'application/json';
      opcoes.body = JSON.stringify(corpo);
    }
    return fetch('/api/v1' + caminho, opcoes).then(function (resposta) {
      if (resposta.status === 401) {
        // a sessão acabou: a única saída honesta é o login, com a volta para cá
        window.location.assign('/login?proximo=%2Fcelular&motivo=sessao');
        return new Promise(function () {});
      }
      return resposta.json().catch(function () { return {}; }).then(function (dados) {
        if (!resposta.ok) {
          var erro = new Error(dados.erro || ('Erro ' + resposta.status));
          erro.motivos = dados.motivos || [];
          erro.status = resposta.status;
          throw erro;
        }
        return dados;
      });
    });
  }

  function semRede(ligado) {
    var caixa = document.getElementById('sem-rede');
    if (caixa) caixa.hidden = !ligado;
  }
  window.addEventListener('offline', function () { semRede(true); });
  window.addEventListener('online', function () { semRede(false); });
  if (navigator.onLine === false) semRede(true);

  function escreverRecusa(alvo, erro) {
    if (!alvo) return;
    if (!erro) { alvo.innerHTML = ''; return; }
    var motivos = (erro.motivos || []).map(function (m) { return '<li>' + escapar(m) + '</li>'; }).join('');
    alvo.innerHTML = '<div class="aviso aviso-erro"><strong>' + escapar(erro.message) + '</strong>' +
      (motivos ? '<ul>' + motivos + '</ul>' : '') + '</div>';
    alvo.scrollIntoView({ block: 'nearest' });
  }

  function escapar(texto) {
    return String(texto).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function opcoes(select, itens, primeiro) {
    select.innerHTML = '';
    if (primeiro) {
      var vazio = document.createElement('option');
      vazio.value = ''; vazio.textContent = primeiro;
      select.appendChild(vazio);
    }
    itens.forEach(function (item) {
      var o = document.createElement('option');
      o.value = item.valor; o.textContent = item.rotulo;
      if (item.desligado) o.disabled = true;
      if (item.escolhido) o.selected = true;
      select.appendChild(o);
    });
  }

  // -------------------------------------------------------------------
  // As abas — pela âncora, para o botão de voltar do celular funcionar
  // -------------------------------------------------------------------
  function mostrarAba(nome) {
    var existe = raiz.querySelector('[data-tela="' + nome + '"]');
    if (!existe) nome = 'inicio';
    raiz.querySelectorAll('[data-tela]').forEach(function (tela) {
      tela.hidden = tela.getAttribute('data-tela') !== nome;
    });
    raiz.querySelectorAll('[data-aba]').forEach(function (aba) {
      var ativa = aba.getAttribute('data-aba') === nome;
      aba.classList.toggle('ativo', ativa);
      if (ativa) aba.setAttribute('aria-current', 'page'); else aba.removeAttribute('aria-current');
    });
    try { sessionStorage.setItem('csso:celular:aba', nome); } catch (e) { /* sem armazenamento */ }
    if (nome === 'chamada') carregarTurmas();
    if (nome === 'balcao') carregarItens();
  }

  window.addEventListener('hashchange', function () { mostrarAba(location.hash.slice(1) || 'inicio'); });

  // -------------------------------------------------------------------
  // O balcão
  // -------------------------------------------------------------------
  var balcao = { servidor: null, item: null, itens: [], lotes: [], itensCarregados: false };

  var busca = document.getElementById('c-busca');
  var listaServidores = document.getElementById('c-servidores');
  var selItem = document.getElementById('c-item');
  var selLote = document.getElementById('c-lote');
  var selTamanho = document.getElementById('c-tamanho');
  var campoQuantidade = document.getElementById('c-quantidade');
  var campoData = document.getElementById('c-data');
  var caixaExcecao = document.getElementById('c-excecao');

  // Os passos do balcão: um de cada vez, e o do item continua visível no dos
  // detalhes — é ali que se troca o equipamento sem voltar ao começo.
  function passo(nome) {
    raiz.querySelectorAll('[data-passo]').forEach(function (li) {
      var p = li.getAttribute('data-passo');
      var visivel = p === nome || (nome === 'detalhes' && p === 'item');
      li.hidden = !visivel;
      li.classList.toggle('atual', p === nome);
    });
  }

  var temporizadorBusca = null;
  if (busca) {
    busca.addEventListener('input', function () {
      clearTimeout(temporizadorBusca);
      var termo = busca.value.trim();
      if (termo.length < 2) { listaServidores.innerHTML = ''; return; }
      temporizadorBusca = setTimeout(function () {
        api('GET', '/epis/servidores?q=' + encodeURIComponent(termo)).then(function (lista) {
          listaServidores.innerHTML = '';
          if (!lista.length) {
            listaServidores.innerHTML = '<li class="nada">Nada encontrado para “' + escapar(termo) + '”.</li>';
            return;
          }
          lista.forEach(function (sv) {
            var li = document.createElement('li');
            var botao = document.createElement('button');
            botao.type = 'button';
            botao.className = 'toque';
            botao.setAttribute('data-servidor', sv.id);
            botao.setAttribute('data-rotulo', sv.rotulo);
            botao.textContent = sv.rotulo;
            if (!sv.nominal) botao.title = 'identificação suprimida (RN-19)';
            li.appendChild(botao);
            listaServidores.appendChild(li);
          });
        }).catch(function (erro) { escreverRecusa(document.getElementById('c-recusa'), erro); });
      }, 250);
    });
  }

  function carregarItens() {
    if (!selItem || balcao.itensCarregados) return;
    api('GET', '/epis/itens').then(function (itens) {
      balcao.itens = itens;
      balcao.itensCarregados = true;
      opcoes(selItem, itens.map(function (i) { return { valor: i.id, rotulo: i.nome }; }), '— escolha —');
    }).catch(function (erro) { escreverRecusa(document.getElementById('c-recusa'), erro); });
  }

  document.addEventListener('click', function (e) {
    var escolha = e.target.closest && e.target.closest('button[data-servidor]');
    if (!escolha) return;
    balcao.servidor = { id: Number(escolha.getAttribute('data-servidor')), rotulo: escolha.getAttribute('data-rotulo') };
    raiz.querySelector('[data-escolhido="servidor"]').textContent = 'Recebe: ' + balcao.servidor.rotulo;
    passo('item');
    selItem.focus();
  });

  if (selItem) {
    selItem.addEventListener('change', function () {
      var id = Number(selItem.value);
      balcao.item = balcao.itens.find(function (i) { return i.id === id; }) || null;
      if (!balcao.item) { passo('item'); return; }
      campoQuantidade.value = balcao.item.quantidade_padrao;
      opcoes(selTamanho, balcao.item.tamanhos.map(function (t) { return { valor: t, rotulo: t }; }), '—');
      caixaExcecao.hidden = balcao.item.quantidade_maxima === null;
      if (!campoData.value) campoData.value = new Date().toISOString().slice(0, 10);
      campoData.max = new Date().toISOString().slice(0, 10);
      api('GET', '/epis/itens/' + id + '/lotes').then(function (lotes) {
        balcao.lotes = lotes;
        opcoes(selLote, lotes.map(function (l) {
          return {
            valor: l.entrada_id,
            rotulo: l.rotulo + (l.impedimento ? ' — INDISPONÍVEL: ' + l.impedimento : (l.saldo <= 0 ? ' — sem saldo' : '')),
            desligado: !l.pode_sair
          };
        }), 'Sem lote — entrega de balcão');
        document.getElementById('c-lote-dica').textContent = lotes.length
          ? 'O CA que bloqueia a entrega é o do lote, não o do catálogo.'
          : 'Nenhum lote cadastrado: sem lote, o CA conferido é o do catálogo.';
        passo('detalhes');
      }).catch(function (erro) { escreverRecusa(document.getElementById('c-recusa'), erro); });
    });
  }

  var botaoRegistrar = document.getElementById('c-registrar');
  if (botaoRegistrar) {
    botaoRegistrar.addEventListener('click', function () {
      if (!balcao.servidor || !balcao.item) return;
      var recusa = document.getElementById('c-recusa');
      escreverRecusa(recusa, null);
      botaoRegistrar.disabled = true;
      botaoRegistrar.textContent = 'Registrando…';
      api('POST', '/epis/entregas', {
        servidor_id: balcao.servidor.id,
        item_id: balcao.item.id,
        quantidade: Number(campoQuantidade.value || 0),
        entrada_id: selLote.value ? Number(selLote.value) : null,
        tamanho: selTamanho.value || '',
        data_evento: campoData.value || null,
        justificativa_excecao: (document.getElementById('c-justificativa').value || '')
      }).then(function (feito) {
        document.getElementById('c-feito').textContent = feito.mensagem;
        document.getElementById('c-comprovante').href = feito.comprovante;
        passo('feito');
      }).catch(function (erro) {
        escreverRecusa(recusa, erro);
      }).then(function () {
        botaoRegistrar.disabled = false;
        botaoRegistrar.textContent = 'Registrar entrega';
      });
    });
  }

  var botaoOutra = document.getElementById('c-outra');
  if (botaoOutra) {
    botaoOutra.addEventListener('click', function () {
      // a série do balcão: volta ao começo com a lista de itens já carregada
      balcao.servidor = null; balcao.item = null;
      busca.value = ''; listaServidores.innerHTML = ''; selItem.value = '';
      escreverRecusa(document.getElementById('c-recusa'), null);
      passo('servidor');
      busca.focus();
    });
  }

  // -------------------------------------------------------------------
  // A chamada
  // -------------------------------------------------------------------
  var chamada = { turmas: [], turma: null, grade: null, carregou: false };
  var selTurma = document.getElementById('c-turma');
  var selDia = document.getElementById('c-dia');
  var campoHoras = document.getElementById('c-horas');
  var listaInscritos = document.getElementById('c-inscritos');

  function carregarTurmas() {
    if (!selTurma || chamada.carregou) return;
    api('GET', '/turmas?situacao=EM_ANDAMENTO').then(function (turmas) {
      chamada.turmas = turmas;
      chamada.carregou = true;
      opcoes(selTurma, turmas.map(function (t) {
        return { valor: t.id, rotulo: t.codigo + ' · ' + t.treinamento + ' (' + t.inscritos + ' inscritos)' };
      }), turmas.length ? '— escolha —' : 'nenhuma turma em andamento no seu escopo');
    }).catch(function (erro) { escreverRecusa(document.getElementById('c-chamada-recusa'), erro); });
  }

  function dataBr(iso) {
    var p = iso.split('-');
    return p[2] + '/' + p[1] + '/' + p[0];
  }

  function desenharGrade() {
    var grade = chamada.grade;
    var dia = selDia.value;
    listaInscritos.innerHTML = '';
    document.getElementById('c-retificando').hidden = !grade.retificando;
    if (!grade.linhas.length) {
      listaInscritos.innerHTML = '<li class="nada">Ninguém a avaliar: a turma não tem inscrição ativa.</li>';
      return;
    }
    grade.linhas.forEach(function (linha) {
      var lancado = linha.por_dia[dia];
      var li = document.createElement('li');
      li.className = 'inscrito' + (lancado ? (lancado.presente ? ' presente' : ' falta') : '');
      li.innerHTML =
        '<div class="quem"><strong>' + escapar(linha.participante) + '</strong>' +
        '<span class="discreto">' + escapar(linha.frequencia) + '% · ' + escapar(linha.horas) + 'h · ' + escapar(linha.situacao) + '</span></div>' +
        '<div class="marcas">' +
        '<button type="button" class="marcador' + (lancado && lancado.presente ? ' ativo' : '') + '" data-presenca="1" data-inscricao="' + linha.inscricao_id + '">presente</button>' +
        '<button type="button" class="marcador' + (lancado && !lancado.presente ? ' ativo' : '') + '" data-presenca="0" data-inscricao="' + linha.inscricao_id + '">falta</button>' +
        '</div>';
      listaInscritos.appendChild(li);
    });
  }

  if (selTurma) {
    selTurma.addEventListener('change', function () {
      var id = Number(selTurma.value);
      chamada.turma = chamada.turmas.find(function (t) { return t.id === id; }) || null;
      var caixaDia = document.getElementById('c-dia-caixa');
      if (!chamada.turma) { caixaDia.hidden = true; listaInscritos.innerHTML = ''; return; }
      var hoje = new Date().toISOString().slice(0, 10);
      opcoes(selDia, chamada.turma.dias.map(function (d) {
        return { valor: d, rotulo: dataBr(d), escolhido: d === hoje };
      }));
      // turma de um dia: o dia é o curso inteiro, e as horas são a carga
      campoHoras.value = chamada.turma.dias.length === 1 ? chamada.turma.carga_efetiva : '';
      caixaDia.hidden = false;
      api('GET', '/turmas/' + id + '/presencas').then(function (grade) {
        chamada.grade = grade;
        desenharGrade();
      }).catch(function (erro) { escreverRecusa(document.getElementById('c-chamada-recusa'), erro); });
    });
    selDia.addEventListener('change', function () { if (chamada.grade) desenharGrade(); });
  }

  document.addEventListener('click', function (e) {
    var marca = e.target.closest && e.target.closest('button[data-presenca]');
    if (!marca || !chamada.turma) return;
    var recusa = document.getElementById('c-chamada-recusa');
    escreverRecusa(recusa, null);
    marca.disabled = true;
    api('POST', '/turmas/' + chamada.turma.id + '/presencas', {
      inscricao_id: Number(marca.getAttribute('data-inscricao')),
      data: selDia.value,
      presente: marca.getAttribute('data-presenca') === '1',
      horas: campoHoras.value || '',
      motivo: (document.getElementById('c-motivo') || {}).value || ''
    }).then(function (grade) {
      chamada.grade = grade;
      desenharGrade();
    }).catch(function (erro) {
      marca.disabled = false;
      escreverRecusa(recusa, erro);
    });
  });

  // -------------------------------------------------------------------
  // arranque: a aba da âncora (ou a última), e o service worker
  // -------------------------------------------------------------------
  var inicial = location.hash.slice(1);
  if (!inicial) { try { inicial = sessionStorage.getItem('csso:celular:aba') || 'inicio'; } catch (e) { inicial = 'inicio'; } }
  mostrarAba(inicial);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function () { /* sem worker a tela continua igual */ });
  }
})();
