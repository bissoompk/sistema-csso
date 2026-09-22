@echo off
setlocal
chcp 65001 >nul
title Sistema CSSO - parar o ambiente de teste
cd /d "%~dp0"

rem A porta e fixa, e nao lida do .env da raiz de proposito: este arquivo so
rem pode encerrar o ambiente de teste. Ler a porta de um .env qualquer era o
rem caminho curto para PARAR-TESTE derrubar o sistema de verdade na 8765.
set "PORTA=8766"

echo Encerrando o AMBIENTE DE TESTE (porta %PORTA%)...

set "ACHOU="
for /f "tokens=5" %%A in ('netstat -ano ^| findstr /r /c:":%PORTA% .*LISTENING"') do (
  echo   encerrando processo %%A na porta %PORTA%
  taskkill /PID %%A /F >nul 2>&1
  set "ACHOU=1"
)

if not defined ACHOU (
  echo Nada estava escutando na porta %PORTA%.
) else (
  echo Ambiente de teste encerrado. O sistema de verdade nao foi tocado.
)

timeout /t 3 >nul
endlocal
