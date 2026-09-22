@echo off
setlocal
chcp 65001 >nul
title Sistema CSSO - parar
cd /d "%~dp0"

echo Encerrando o Sistema CSSO...

for /f "tokens=2 delims==" %%P in ('findstr /b /c:"CSSO_PORTA=" .env 2^>nul') do set "PORTA=%%P"
if not defined PORTA set "PORTA=8765"

set "ACHOU="
for /f "tokens=5" %%A in ('netstat -ano ^| findstr /r /c:":%PORTA% .*LISTENING"') do (
  echo   encerrando processo %%A na porta %PORTA%
  taskkill /PID %%A /F >nul 2>&1
  set "ACHOU=1"
)

if not defined ACHOU (
  echo Nada estava escutando na porta %PORTA%.
) else (
  echo Sistema encerrado.
)

timeout /t 3 >nul
endlocal
