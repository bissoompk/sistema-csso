@echo off
setlocal
chcp 65001 >nul
title Sistema CSSO - conferir mudanca de maquina
cd /d "%~dp0"

echo ============================================================
echo  Conferindo se a copia chegou inteira nesta maquina
echo ============================================================
echo.

set "UV="
where uv >nul 2>&1 && set "UV=uv"
if not defined UV if exist "%USERPROFILE%\.local\bin\uv.exe" set "UV=%USERPROFILE%\.local\bin\uv.exe"
if not defined UV if exist "%APPDATA%\Python\Scripts\uv.exe" set "UV=%APPDATA%\Python\Scripts\uv.exe"
for /d %%D in ("%APPDATA%\Python\Python3*") do (
  if not defined UV if exist "%%D\Scripts\uv.exe" set "UV=%%D\Scripts\uv.exe"
)
rem Instala o uv aqui tambem, e nao manda rodar o INICIAR.bat antes: numa
rem maquina nova o INICIAR.bat instala tudo e SO ENTAO morre no endereco errado,
rem e a janela preta fecha antes de dar para ler. A ordem certa e conferir
rem primeiro, subir depois.
if not defined UV (
  echo O uv nao foi encontrado. Vou instala-lo agora ^(precisa de internet^).
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex"
  if exist "%USERPROFILE%\.local\bin\uv.exe" set "UV=%USERPROFILE%\.local\bin\uv.exe"
)
if not defined UV (
  echo.
  echo NAO FOI POSSIVEL INSTALAR O uv. Instale em https://docs.astral.sh/uv/
  pause
  exit /b 1
)

echo Preparando o ambiente ^(demora na primeira vez desta maquina^)...
"%UV%" sync --extra dev
if errorlevel 1 (
  echo.
  echo Falha ao preparar o ambiente. Confira a conexao de rede.
  pause
  exit /b 1
)
echo.

"%UV%" run python -m ferramentas.conferir_mudanca
set "SAIDA=%ERRORLEVEL%"

echo.
if not "%SAIDA%"=="0" (
  echo Corrija os ERROs acima e rode este arquivo de novo.
  pause
  exit /b %SAIDA%
)

echo Rodando a suite de testes ^(demora alguns minutos^)...
echo.
"%UV%" run pytest
set "SAIDA=%ERRORLEVEL%"

echo.
if "%SAIDA%"=="0" (
  echo TUDO CERTO. Pode rodar INICIAR.bat.
  echo Falta so a prova da senha do backup - passo 6 de MUDAR-DE-PC.md.
) else (
  echo A SUITE FALHOU. Nao mexa em dados/ ate entender o motivo.
  echo Leia MUDAR-DE-PC.md, secao "Quando a suite falha na maquina nova".
)
pause
endlocal
exit /b %SAIDA%
