@echo off
setlocal
chcp 65001 >nul
title Sistema CSSO - recriar o ambiente de teste
cd /d "%~dp0"

echo ============================================================
echo  Recriar o AMBIENTE DE TESTE do zero
echo ============================================================
echo.
echo  Isto APAGA a pasta dados-teste e monta tudo de novo.
echo  Nada do sistema de verdade e tocado: dados\csso.db fica como esta.
echo.
choice /c SN /m "Recriar agora"
if errorlevel 2 goto :fim

set "UV="
where uv >nul 2>&1 && set "UV=uv"
if not defined UV if exist "%USERPROFILE%\.local\bin\uv.exe" set "UV=%USERPROFILE%\.local\bin\uv.exe"
if not defined UV if exist "%APPDATA%\Python\Scripts\uv.exe" set "UV=%APPDATA%\Python\Scripts\uv.exe"
for /d %%D in ("%APPDATA%\Python\Python3*") do (
  if not defined UV if exist "%%D\Scripts\uv.exe" set "UV=%%D\Scripts\uv.exe"
)
if not defined UV (
  echo O uv nao foi encontrado. Rode o INICIAR.bat uma vez e volte aqui.
  pause
  exit /b 1
)

rem Derruba o que estiver na 8766 antes: o SQLite do ambiente antigo ainda
rem estaria com o arquivo aberto, e a pasta nao se apagaria.
call "%~dp0PARAR-TESTE.bat" >nul 2>&1

echo.
"%UV%" run python -m ferramentas.ambiente_teste_cli
if errorlevel 1 (
  echo.
  echo Nao foi possivel recriar o ambiente de teste.
  pause
  exit /b 1
)

echo.
echo Pronto. Rode INICIAR-TESTE.bat para subir.
:fim
pause
endlocal
