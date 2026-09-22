@echo off
setlocal
chcp 65001 >nul
title Sistema CSSO - AMBIENTE DE TESTE servindo a rede (porta 8766)
cd /d "%~dp0"

rem ===========================================================================
rem  Sobe o AMBIENTE DE TESTE para a rede local e DEIXA no ar.
rem
rem  A diferenca para o INICIAR-TESTE.bat e uma so: este nao abre o navegador.
rem  Ele existe para ser chamado pela Tarefa Agendada do Windows que sobe o
rem  ambiente no logon — e uma janela de navegador por logon seria estorvo.
rem  Para usar na mao, o INICIAR-TESTE.bat continua sendo o certo.
rem
rem  ISTO E O AMBIENTE DE TESTE: banco proprio (dados-teste), gente inventada,
rem  porta 8766. O sistema de verdade (porta 8765, dados\) NAO e tocado.
rem
rem  Quem decide o endereco de ligacao e o dados-teste\.env (CSSO_HOST). Quem
rem  decide QUEM alcanca e a regra de firewall — ABRIR-TESTE-NA-REDE.bat.
rem ===========================================================================

rem O PYTHON DO AMBIENTE, DIRETO — e nao `uv run`, que os outros .bat usam.
rem
rem A diferenca importa porque este processo fica DE PE por horas: `uv run`
rem confere e reinstala o ambiente a cada chamada, e uma reinstalacao feita por
rem outra janela (um `uv sync` depois de mexer na versao, por exemplo) troca
rem arquivos dentro do `.venv` que este servidor ainda vai importar — e ele
rem morre no meio do expediente, sem erro que se leia. Aconteceu. Chamando o
rem interpretador direto, o servidor no ar nao depende de nenhuma resolucao de
rem dependencia posterior.
rem
rem O `uv` continua sendo quem MONTA o ambiente: o INICIAR.bat e o
rem CONFERIR-MUDANCA.bat fazem isso. Aqui so se usa o que ja esta montado.
set "PY=%~dp0.venv\Scripts\python.exe"
if not exist "%PY%" (
  echo O ambiente Python ainda nao foi montado nesta maquina.
  echo Rode o INICIAR.bat uma vez ^(ele instala tudo^) e volte aqui.
  pause
  exit /b 1
)

if not exist "dados-teste\.env" (
  echo O ambiente de teste ainda nao foi montado. Rode RECRIAR-TESTE.bat.
  pause
  exit /b 1
)

set "CSSO_ENV_FILE=%~dp0dados-teste\.env"
set "CSSO_ABRIR_NAVEGADOR=false"

echo Ambiente de TESTE no ar. Feche esta janela ou rode PARAR-TESTE.bat.
echo.
"%PY%" -m ferramentas.servidor

endlocal
