@echo off
setlocal
chcp 65001 >nul
title Sistema CSSO - abrir o AMBIENTE DE TESTE para a rede local
cd /d "%~dp0"

echo ============================================================
echo  Abrir a porta 8766 do AMBIENTE DE TESTE para a rede local
echo ============================================================
echo.
echo  ISTO E O AMBIENTE DE TESTE: banco proprio ^(dados-teste^), gente
echo  inventada, porta 8766. O sistema de verdade ^(porta 8765, dados\^)
echo  NAO e tocado por este arquivo.
echo.
echo  Precisa rodar COMO ADMINISTRADOR: clique com o botao direito neste
echo  arquivo e escolha "Executar como administrador".
echo.

net session >nul 2>&1
if errorlevel 1 (
  echo NAO ESTA COMO ADMINISTRADOR. Feche esta janela, clique com o botao
  echo direito no arquivo e escolha "Executar como administrador".
  pause
  exit /b 1
)

rem A faixa da rede local desta maquina. Regra de ORIGEM, e nao "abrir a
rem porta": abrir para tudo entrega a tela de login a qualquer maquina que
rem alcance este computador. Se a rede mudar, troque a faixa aqui.
set "FAIXA=192.168.31.0/24"
set "REGRA=CSSO ambiente de teste (8766)"

echo Removendo regra anterior com o mesmo nome, se houver...
netsh advfirewall firewall delete rule name="%REGRA%" >nul 2>&1

echo Criando a regra para a faixa %FAIXA%...
netsh advfirewall firewall add rule name="%REGRA%" dir=in action=allow ^
  protocol=TCP localport=8766 remoteip=%FAIXA% profile=any ^
  description="Ambiente de TESTE do Sistema CSSO (dados inventados). Origem limitada a rede local."
if errorlevel 1 (
  echo.
  echo Falhou ao criar a regra.
  pause
  exit /b 1
)

echo.
echo Regra criada. Confira:
netsh advfirewall firewall show rule name="%REGRA%" | findstr /i "Regra Nome Ativado Acao IP Porta Enabled Action LocalPort RemoteIP"
echo.
echo Agora suba o ambiente de teste com INICIAR-TESTE.bat e peca a alguem
echo da rede para abrir:
for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /i "IPv4" ^| findstr /v "127.0.0.1"') do (
  for /f "tokens=* delims= " %%B in ("%%A") do echo    http://%%B:8766/
)
echo.
echo Para FECHAR de novo quando terminar o teste:
echo    netsh advfirewall firewall delete rule name="%REGRA%"
echo.
pause
endlocal
