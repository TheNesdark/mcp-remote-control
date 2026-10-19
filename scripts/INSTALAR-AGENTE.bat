@echo off
setlocal EnableDelayedExpansion

REM ---------------------------------------------------------------
REM  rc-agent (C# / .NET 8, un solo exe self-contained)
REM  Instala en %LOCALAPPDATA%\mrc-remote-control\rc-agent.exe y arranca.
REM  Arranca DESDE LOCAL (no desde el share): un .exe lanzado desde una
REM  ruta de red dispara el aviso de seguridad de Windows y ademas el
REM  auto-update necesita un directorio local para el staging.
REM ---------------------------------------------------------------

set "SH=\\192.168.1.191\Hermes"
set "DIR=%LOCALAPPDATA%\mrc-remote-control"
set "EXE=%DIR%\rc-agent.exe"
set "SRC=%SH%\rc-agent.exe"
set "NAME=SERVER-RX"
set "SERVER=ws://192.168.1.192:8787"
set "TOKEN=mrc_LajSuZKlZ57FDiI2ohKll0eisXagGTFndEv2GYu7-SY"

echo ============================================================
echo   rc-agent  ^|  instalando y arrancando
echo ============================================================
echo.

REM --- 1) detener instancias previas (el exe en disco queda libre) ---
echo [1/6] Deteniendo instancias previas...
taskkill /f /im rc-agent.exe        >nul 2>&1
taskkill /f /im rc-agent-109.exe    >nul 2>&1
taskkill /f /im rc-agent-108.exe    >nul 2>&1
taskkill /f /im rc-agent-dotnet.exe >nul 2>&1
timeout /t 2 /nobreak >nul

REM --- 2) copiar el exe nuevo desde el share ---
echo [2/6] Copiando desde el share (154 MB, tarda un poco)...
if not exist "%DIR%" mkdir "%DIR%"
copy /y "%SRC%" "%EXE%"
if errorlevel 1 (
  echo.
  echo ERROR: no se pudo copiar "%SRC%".
  echo Comprueba que el share esta accesible:  dir "%SH%"
  pause
  exit /b 1
)

REM --- 3) quitar la marca de red (Zone.Identifier) que hereda del share ---
echo [3/6] Quitando la marca de red del exe...
powershell -NoProfile -Command "Unblock-File -Path '%EXE%' -ErrorAction SilentlyContinue" >nul 2>&1

REM --- 4) comprobar la version instalada ---
echo [4/6] Version instalada:
for /f "tokens=2 delims==" %%v in ('wmic datafile where "name='%EXE:\=\\%'" get Version /value 2^>nul ^| find "="') do echo        %%v
echo.

REM --- 5) arrancar DESDE LOCAL ---
echo [5/6] Arrancando agente desde local...
if not exist "%DIR%\logs" mkdir "%DIR%\logs"
start "" "%EXE%" --name %NAME% --server %SERVER% --token %TOKEN%

REM --- 6) verificar que sigue vivo ---
echo [6/6] Esperando 10s y comprobando...
timeout /t 10 /nobreak >nul
tasklist /fi "imagename eq rc-agent.exe" 2>nul | find /i "rc-agent.exe" >nul
if errorlevel 1 (
  echo.
  echo AVISO: el proceso NO sigue vivo. Ultimas lineas del log:
  echo ------------------------------------------------------------
  if exist "%DIR%\logs\agent.log" (
    powershell -NoProfile -Command "Get-Content '%DIR%\logs\agent.log' -Tail 25"
  ) else (
    echo   (no hay log en %DIR%\logs\agent.log)
  )
  echo ------------------------------------------------------------
  echo.
  echo Revisa el log de arriba y vuelve a ejecutar este .bat.
) else (
  echo.
  echo OK: agente en marcha (pid arriba). Nombre en el hub: %NAME%
  echo Log: %DIR%\logs\agent.log
  echo A partir de aqui el agente se actualiza solo (auto-update por la share).
)

echo.
pause
