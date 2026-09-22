@echo off
setlocal
chcp 65001 >nul
title Sistema CSSO - exportar tudo
cd /d "%~dp0"

set "UV="
where uv >nul 2>&1 && set "UV=uv"
if not defined UV if exist "%USERPROFILE%\.local\bin\uv.exe" set "UV=%USERPROFILE%\.local\bin\uv.exe"
if not defined UV if exist "%APPDATA%\Python\Scripts\uv.exe" set "UV=%APPDATA%\Python\Scripts\uv.exe"
for /d %%D in ("%APPDATA%\Python\Python3*") do (
  if not defined UV if exist "%%D\Scripts\uv.exe" set "UV=%%D\Scripts\uv.exe"
)
if not defined UV (
  echo Rode INICIAR.bat pelo menos uma vez antes.
  pause
  exit /b 1
)

echo Gerando o pacote completo (planilha + CSVs + banco + documentos + anexos)...
"%UV%" run python -m ferramentas.backup_cli exportar

echo.
echo Criterio deste pacote: "desligue o sistema para sempre;
echo com este zip o setor trabalha amanha."
echo.
pause
endlocal
