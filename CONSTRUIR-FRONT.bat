@echo off
setlocal
chcp 65001 >nul
title Sistema CSSO - montar o front compilado (/app)
cd /d "%~dp0"

echo ============================================================
echo  Montar o front compilado ^(a tela /app^)
echo ============================================================
echo.
echo  Isto so e preciso em maquina de DESENVOLVIMENTO, depois de mexer
echo  em frontend\. Quem so instala o sistema ja recebe o bundle pronto
echo  em app\estaticos\app\ e nao precisa de Node nem deste arquivo.
echo.

where npm >nul 2>&1
if errorlevel 1 (
  echo O npm nao foi encontrado. Instale o Node.js LTS em https://nodejs.org/
  echo e rode este arquivo de novo.
  pause
  exit /b 1
)

cd frontend
if not exist node_modules (
  echo Primeira vez nesta maquina: baixando as dependencias ^(precisa de internet^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo Falha ao baixar as dependencias. Confira a conexao de rede.
    pause
    exit /b 1
  )
)

echo.
echo Conferindo os tipos, rodando os testes do front e montando o bundle...
call npm test
if errorlevel 1 (
  echo.
  echo OS TESTES DO FRONT FALHARAM. O bundle antigo continua valendo.
  pause
  exit /b 1
)
call npm run build
if errorlevel 1 (
  echo.
  echo A montagem falhou. O bundle antigo continua valendo.
  pause
  exit /b 1
)

echo.
echo Pronto: app\estaticos\app\ foi refeita. Reinicie o sistema para servir a nova.
pause
endlocal
