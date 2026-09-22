@echo off
setlocal
chcp 65001 >nul
title Sistema CSSO - Sisa/UFVJM
cd /d "%~dp0"

echo ============================================================
echo  Sistema CSSO . Sisa/UFVJM . Modulo Adicional Ocupacional
echo ============================================================
echo.

rem ---- 1. localizar o uv (ele instala o proprio Python) -------------------
set "UV="
where uv >nul 2>&1 && set "UV=uv"
if not defined UV if exist "%USERPROFILE%\.local\bin\uv.exe" set "UV=%USERPROFILE%\.local\bin\uv.exe"
if not defined UV if exist "%APPDATA%\Python\Scripts\uv.exe" set "UV=%APPDATA%\Python\Scripts\uv.exe"
for /d %%D in ("%APPDATA%\Python\Python3*") do (
  if not defined UV if exist "%%D\Scripts\uv.exe" set "UV=%%D\Scripts\uv.exe"
)

if not defined UV (
  echo O uv nao foi encontrado. Vou instala-lo agora ^(precisa de internet^).
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex"
  if exist "%USERPROFILE%\.local\bin\uv.exe" set "UV=%USERPROFILE%\.local\bin\uv.exe"
)

if not defined UV (
  echo.
  echo NAO FOI POSSIVEL INSTALAR O uv.
  echo Instale manualmente em https://docs.astral.sh/uv/ e rode este arquivo de novo.
  pause
  exit /b 1
)

rem ---- 2. .env -----------------------------------------------------------
if not exist ".env" (
  echo Primeira execucao: criando o .env a partir de .env.exemplo
  copy /y ".env.exemplo" ".env" >nul
  "%UV%" run --no-project python -c "import secrets,pathlib;p=pathlib.Path('.env');t=p.read_text(encoding='utf-8');t=t.replace('troque-esta-chave-antes-de-usar-em-producao',secrets.token_hex(32)).replace('troque-esta-senha-de-backup',secrets.token_urlsafe(24));p.write_text(t,encoding='utf-8')" 2>nul
  echo .env criado. Revise-o depois: ele guarda a senha do backup.
)

rem ---- 3. dependencias ---------------------------------------------------
echo Preparando o ambiente ^(pode demorar na primeira vez^)...
"%UV%" sync --extra dev
if errorlevel 1 (
  echo.
  echo Falha ao preparar o ambiente. Confira a conexao de rede.
  pause
  exit /b 1
)

rem ---- 4. subir ----------------------------------------------------------
echo.
echo Subindo o sistema. Feche esta janela ^(ou rode PARAR.bat^) para encerrar.
echo.
"%UV%" run python -m ferramentas.servidor

endlocal
