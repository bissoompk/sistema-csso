@echo off
setlocal
chcp 65001 >nul
title Sistema CSSO - agendar o ambiente de teste no logon
cd /d "%~dp0"

echo ============================================================
echo  Agendar o AMBIENTE DE TESTE para subir sozinho no logon
echo ============================================================
echo.
echo  Cria uma Tarefa Agendada do Windows que chama o
echo  SERVIR-TESTE-NA-REDE.bat toda vez que voce entra na maquina.
echo.
echo  ISTO E O AMBIENTE DE TESTE: banco proprio (dados-teste), gente
echo  inventada, porta 8766. O sistema de verdade (porta 8765, dados\)
echo  NAO e tocado por este arquivo.
echo.
echo  Precisa rodar COMO ADMINISTRADOR: o Windows exige elevacao para
echo  criar tarefa de logon. A tarefa em si roda SEM privilegio elevado
echo  (/rl limited) - servidor web nao deve rodar como administrador.
echo.

net session >nul 2>&1
if errorlevel 1 (
  echo NAO ESTA COMO ADMINISTRADOR. Feche esta janela, clique com o botao
  echo direito no arquivo e escolha "Executar como administrador".
  pause
  exit /b 1
)

set "TAREFA=CSSO - ambiente de teste na rede"
set "ALVO=%~dp0SERVIR-TESTE-NA-REDE.bat"

if not exist "%ALVO%" (
  echo Nao achei o SERVIR-TESTE-NA-REDE.bat ao lado deste arquivo.
  pause
  exit /b 1
)

rem `/ru` e a conta que ESTAVA logada quando este arquivo foi elevado — e nao
rem a conta de administrador. Sem isso a tarefa nasceria amarrada a outra
rem pessoa e nunca dispararia no logon de quem opera.
set "CONTA=%USERDOMAIN%\%USERNAME%"
echo Conta que vai disparar a tarefa: %CONTA%
echo.

echo Removendo tarefa anterior com o mesmo nome, se houver...
schtasks /delete /tn "%TAREFA%" /f >nul 2>&1

echo Criando a tarefa...
schtasks /create /tn "%TAREFA%" /sc onlogon /ru "%CONTA%" /rl limited /f ^
  /tr "\"%ALVO%\""
if errorlevel 1 (
  echo.
  echo Falhou ao criar a tarefa.
  pause
  exit /b 1
)

echo.
echo Tarefa criada:
schtasks /query /tn "%TAREFA%" /fo LIST
echo.
echo Ela sobe no proximo logon. Para subir AGORA sem sair da conta:
echo    schtasks /run /tn "%TAREFA%"
echo.
echo Para desfazer:
echo    schtasks /delete /tn "%TAREFA%" /f
echo.
pause
endlocal
