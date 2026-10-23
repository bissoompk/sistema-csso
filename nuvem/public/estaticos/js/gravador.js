/* =====================================================================
   gravador.js — a gravação de entrevista da investigação de acidente (F4).

   Carregado só na aba Entrevistas da ficha, com `defer`. Sem framework e sem
   expressão em atributo (a CSP é `script-src 'self' 'nonce-…'`): o contrato é
   por `data-`, como em `csso.js`.

   Contrato, num `<form data-gravador>`:
   - `[data-gravador-consentimento]`: a caixa "consentimento obtido". Sem ela
     marcada, o gravador NÃO liga — e o servidor recusa o áudio do mesmo jeito;
   - `[data-gravador-iniciar]` e `[data-gravador-parar]`: os botões;
   - `[data-gravador-estado]`: a frase do que está acontecendo (aria-live);
   - `[data-gravador-arquivo]`: o `<input type=file name=audio>` que recebe a
     gravação ao parar (ou o arquivo que a pessoa escolher).

   O áudio sai do aparelho só no envio do formulário, pelo próprio sistema:
   nada de transcrição por serviço externo (no legado, Web Speech API).
   ===================================================================== */
(function () {
  'use strict';
  var LIMITE = 4 * 1024 * 1024;

  function preparar(form) {
    var consentimento = form.querySelector('[data-gravador-consentimento]');
    var iniciar = form.querySelector('[data-gravador-iniciar]');
    var parar = form.querySelector('[data-gravador-parar]');
    var estado = form.querySelector('[data-gravador-estado]');
    var arquivo = form.querySelector('[data-gravador-arquivo]');
    if (!consentimento || !iniciar || !parar || !arquivo) return;
    var gravador = null;
    var pedacos = [];
    var fluxo = null;

    function dizer(texto) { if (estado) estado.textContent = texto; }

    if (!window.MediaRecorder || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      iniciar.hidden = true;
      dizer('Este navegador não grava; anexe o arquivo de áudio abaixo.');
      return;
    }

    iniciar.addEventListener('click', function () {
      if (!consentimento.checked) {
        dizer('Marque antes o consentimento do entrevistado: sem ele, não se grava.');
        consentimento.focus();
        return;
      }
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) {
        fluxo = s;
        pedacos = [];
        gravador = new MediaRecorder(s);
        gravador.addEventListener('dataavailable', function (e) { if (e.data && e.data.size) pedacos.push(e.data); });
        gravador.addEventListener('stop', function () {
          var tipo = gravador.mimeType || 'audio/webm';
          var blob = new Blob(pedacos, { type: tipo });
          if (fluxo) fluxo.getTracks().forEach(function (t) { t.stop(); });
          if (blob.size > LIMITE) {
            dizer('A gravação passou de 4 MB. Grave em partes, uma entrevista por vez.');
            return;
          }
          var extensao = tipo.indexOf('ogg') !== -1 ? 'ogg' : (tipo.indexOf('mp4') !== -1 ? 'm4a' : 'webm');
          try {
            var transferencia = new DataTransfer();
            transferencia.items.add(new File([blob], 'entrevista.' + extensao, { type: tipo }));
            arquivo.files = transferencia.files;
            dizer('Gravação pronta (' + Math.round(blob.size / 1024) + ' KB). Ela vai junto ao registrar a entrevista.');
          } catch (erro) {
            dizer('Não foi possível juntar a gravação ao formulário neste navegador; anexe o arquivo.');
          }
        });
        gravador.start();
        iniciar.hidden = true;
        parar.hidden = false;
        dizer('Gravando… Avise o entrevistado e pare quando terminar.');
      }).catch(function () {
        dizer('O microfone não foi liberado. Anexe o arquivo de áudio, se houver.');
      });
    });

    parar.addEventListener('click', function () {
      if (gravador && gravador.state !== 'inactive') gravador.stop();
      parar.hidden = true;
      iniciar.hidden = false;
    });

    // desmarcar o consentimento descarta o que foi gravado
    consentimento.addEventListener('change', function () {
      if (!consentimento.checked && arquivo.files && arquivo.files.length) {
        arquivo.value = '';
        dizer('Consentimento desmarcado: a gravação foi descartada.');
      }
    });
  }

  function iniciarTudo() {
    var forms = document.querySelectorAll('form[data-gravador]');
    for (var i = 0; i < forms.length; i++) preparar(forms[i]);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciarTudo);
  else iniciarTudo();
})();
