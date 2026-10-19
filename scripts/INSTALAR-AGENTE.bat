@echo off
setlocal EnableDelayedExpansion

REM ---------------------------------------------------------------
REM  rc-agent (C# / .NET 8, un solo exe self-contained)
REM  1) instala el exe en %LOCALAPPDATA%\mrc-remote-control
REM  2) crea una tarea programada MRC-Agent (al iniciar sesion) que lo
REM     arranca y lo mantiene vivo: asi el auto-update solo tiene que
REM     sustituir el exe y disparar la tarea, sin relanzarse a si mismo.
REM ---------------------------------------------------------------

set "SH=\\192.168.1.191\Hermes"
set "DIR=%LOCALAPPDATA%\mrc-remote-control"
set "EXE=%DIR%\rc-agent.exe"
set "SRC=%SH%\rc-agent.exe"
set "TASK=MRC-Agent"
set "NAME=SERVER-RX"
set "SERVER=ws://192.168.1.192:8787"
set "TOKEN=mrc_LajSuZKlZ57FDiI2ohKll0eisXagGTFndEv2GYu7-SY"

echo ============================================================
echo   rc-agent  ^|  instalando, creando tarea y arrancando
echo ============================================================
echo.

REM --- 1) detener el agente y su tarea previa ---
echo [1/6] Deteniendo instancias previas...
schtasks /end /tn "%TASK%" >nul 2>&1
taskkill /f /im rc-agent.exe        >nul 2>&1
taskkill /f /im rc-agent-109.exe    >nul 2>&1
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

REM --- 3) quitar la marca de red (Zone.Identifier) ---
echo [3/6] Quitando la marca de red del exe...
powershell -NoProfile -Command "Unblock-File -Path '%EXE%' -ErrorAction SilentlyContinue" >nul 2>&1

REM --- 4) crear/actualizar la tarea programada (al iniciar sesion) ---
echo [4/6] Creando la tarea programada "%TASK%" (al iniciar sesion)...
schtasks /delete /tn "%TASK%" /f >nul 2>&1
schtasks /create /tn "%TASK%" /tr "\"%EXE%\" --name %NAME% --server %SERVER% --token %TOKEN%" /sc onlogon /rl limited /f
if errorlevel 1 (
  echo.
  echo AVISO: no se pudo crear la tarea programada. El agente arrancara solo esta vez.
) else (
  echo        Tarea creada: se arranca al iniciar sesion en este equipo.
)

REM --- 5) arrancar el agente ahora (via la tarea, desacoplado) ---
echo [5/6] Arrancando el agente...
schtasks /run /tn "%TASK%" >nul 2>&1
if errorlevel 1 (
  echo        (tarea no disponible; arrancando directamente)
  start "" "%EXE%" --name %NAME% --server %SERVER% --token %TOKEN%
)

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
) else (
  echo.
  echo OK: agente en marcha. Nombre en el hub: %NAME%
  echo Tarea programada: %TASK%   Log: %DIR%\logs\agent.log
  echo A partir de aqui se actualiza solo (auto-update por la share).
)

echo.
pause
