@echo off
setlocal EnableDelayedExpansion

REM ---------------------------------------------------------------
REM  rc-agent (C# / .NET 8, un solo exe self-contained)
REM  Instala en %LOCALAPPDATA%\mrc-remote-control\rc-agent.exe y arranca.
REM  Arranca DESDE LOCAL (no desde el share) para que el share quede libre
REM  y se pueda actualizar sin bloqueos.
REM ---------------------------------------------------------------

set "SH=\\192.168.1.191\Hermes"
set "DIR=%LOCALAPPDATA%\mrc-remote-control"
set "EXE=%DIR%\rc-agent.exe"
set "SRC=%SH%\rc-agent.exe"
set "NAME=SERVER-RX-DOTNET"
set "SERVER=ws://192.168.1.192:8787"
set "TOKEN=mrc_LajSuZKlZ57FDiI2ohKll0eisXagGTFndEv2GYu7-SY"

echo ============================================================
echo   rc-agent  ^|  instalando y arrancando
echo ============================================================
echo.

REM --- 1) detener instancias previas (el exe en disco queda libre) ---
echo [1/5] Deteniendo instancias previas...
taskkill /f /im rc-agent.exe        >nul 2>&1
taskkill /f /im rc-agent-109.exe    >nul 2>&1
taskkill /f /im rc-agent-dotnet.exe >nul 2>&1
taskkill /f /im rc-agent-091.exe    >nul 2>&1
timeout /t 2 /nobreak >nul

REM --- 2) copiar el exe nuevo desde el share ---
echo [2/5] Copiando desde el share (154 MB, tarda un poco)...
if not exist "%DIR%" mkdir "%DIR%"
copy /y "%SRC%" "%EXE%"
if errorlevel 1 (
  echo.
  echo ERROR: no se pudo copiar "%SRC%".
  echo Comprueba que el share esta accesible:  dir "%SH%"
  pause
  exit /b 1
)

REM --- 3) comprobar la version instalada ---
echo [3/5] Version instalada:
for /f "tokens=2 delims==" %%v in ('wmic datafile where "name='%EXE:\=\\%'" get Version /value 2^>nul ^| find "="') do echo        %%v
echo.

REM --- 4) arrancar DESDE LOCAL con log a fichero ---
echo [4/5] Arrancando agente...
if not exist "%DIR%\logs" mkdir "%DIR%\logs"
start "" "%EXE%" --name %NAME% --server %SERVER% --token %TOKEN%

REM --- 5) verificar que sigue vivo ---
echo [5/5] Esperando 10s y comprobando...
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
  echo Levantando el agente Bun de respaldo para no dejarte sin control...
  if exist "%DIR%\rc-agent.exe.bun" (
    start "" "%DIR%\rc-agent.exe.bun" --token %TOKEN%
    echo Bun de respaldo lanzado.
  ) else (
    echo   (no encuentro el Bun de respaldo en %DIR%\rc-agent.exe.bun)
  )
) else (
  echo.
  echo OK: agente en marcha (pid arriba). Nombre en el hub: %NAME%
  echo Log: %DIR%\logs\agent.log
)

echo.
pause
