@echo off
setlocal
chcp 65001 >nul
title Sistema CSSO - AMBIENTE DE TESTE (porta 8766)
cd /d "%~dp0"

echo ============================================================
echo  Sistema CSSO . AMBIENTE DE TESTE . dados de mentira
echo ============================================================
echo.
echo  Este NAO e o sistema de verdade.
echo  Banco proprio (dados-teste), porta 8766, tudo inventado.
echo  O sistema real continua em http://127.0.0.1:8765/ e nao cai.
echo.

rem ---- 1. localizar o uv (mesma busca do INICIAR.bat) --------------------
set "UV="
where uv >nul 2>&1 && set "UV=uv"
if not defined UV if exist "%USERPROFILE%\.local\bin\uv.exe" set "UV=%USERPROFILE%\.local\bin\uv.exe"
if not defined UV if exist "%APPDATA%\Python\Scripts\uv.exe" set "UV=%APPDATA%\Python\Scripts\uv.exe"
for /d %%D in ("%APPDATA%\Python\Python3*") do (
  if not defined UV if exist "%%D\Scripts\uv.exe" set "UV=%%D\Scripts\uv.exe"
)

if not defined UV (
  echo O uv nao foi encontrado. Rode o INICIAR.bat uma vez ^(ele instala^) e volte aqui.
  pause
  exit /b 1
)

rem ---- 2. o ambiente de teste, se ainda nao existir ----------------------
rem O .env de teste NAO e o da raiz: e ele que aponta banco, pastas e porta
rem para dentro de dados-teste. Sem esta variavel o servidor subiria lendo o
rem .env de producao - e escreveria documento de mentira em dados\.
set "CSSO_ENV_FILE=%~dp0dados-teste\.env"

if not exist "dados-teste\.env" (
  echo Primeira vez: montando o ambiente de teste. Pode demorar um minuto.
  echo.
  "%UV%" run python -m ferramentas.ambiente_teste_cli
  if errorlevel 1 (
    echo.
    echo Nao foi possivel montar o ambiente de teste.
    pause
    exit /b 1
  )
  echo.
)

rem ---- 3. subir na 8766 -------------------------------------------------
echo Subindo o ambiente de teste. Feche esta janela ^(ou rode PARAR-TESTE.bat^).
echo Para comecar do zero de novo, rode RECRIAR-TESTE.bat.
echo.
"%UV%" run python -m ferramentas.servidor

endlocal
