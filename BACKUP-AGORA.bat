@echo off
setlocal
chcp 65001 >nul
title Sistema CSSO - backup
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

echo Gerando backup cifrado do banco...
"%UV%" run python -m ferramentas.backup_cli backup

echo.
echo LEMBRETE: o backup contem dados pessoais de servidores.
echo NAO copie para OneDrive, Google Drive, Dropbox ou pen drive pessoal.
echo Disco local ou rede institucional apenas (LGPD arts. 33-36, 39 e 46).
echo.
pause
endlocal
