@echo off
setlocal EnableDelayedExpansion

REM ---------------------------------------------------------------
REM  rc-agent (C# / .NET 8, un solo exe self-contained)
REM  1) instala el exe en %LOCALAPPDATA%\mrc-remote-control
REM  2) escribe run-agent.cmd (el comando de arranque) y crea la tarea
REM     programada MRC-Agent que lo arranca al iniciar sesion: asi el
REM     auto-update solo tiene que sustituir el exe y disparar la tarea.
REM
REM  Este .bat NO deja ninguna ventana de consola abierta: termina solo
REM  (la pausa queda solo cuando hay un error que hay que leer).
REM ---------------------------------------------------------------

set "SH=\\192.168.1.191\Hermes"
set "DIR=%LOCALAPPDATA%\mrc-remote-control"
set "EXE=%DIR%\rc-agent.exe"
set "RUN=%DIR%\run-agent.cmd"
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
copy /y "%SRC%" "%EXE%" >nul
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

REM --- 4) escribir el comando de arranque ---
REM     La tarea apunta a este .cmd (ruta sin espacios), asi no hay
REM     comillas que liar al crear la tarea. El agente reescribe este
REM     fichero cuando cambian los ajustes desde el icono.
echo [4/6] Escribiendo el comando de arranque...
> "%RUN%" echo @echo off
>> "%RUN%" echo start "" "%EXE%" --name %NAME% --server %SERVER% --token %TOKEN%

REM --- 5) crear/actualizar la tarea programada (al iniciar sesion) ---
echo [5/6] Creando la tarea programada "%TASK%" (al iniciar sesion)...
schtasks /delete /tn "%TASK%" /f >nul 2>&1
schtasks /create /tn "%TASK%" /tr %RUN% /sc onlogon /f >nul 2>&1
if errorlevel 1 (
  echo        AVISO: no se pudo crear la tarea; el agente arrancara solo esta vez.
) else (
  echo        Tarea creada: se arranca al iniciar sesion en este equipo.
)

REM --- 6) arrancar el agente ahora (via la tarea, desacoplado) ---
echo [6/6] Arrancando el agente...
schtasks /run /tn "%TASK%" >nul 2>&1
if errorlevel 1 (
  echo        (tarea no disponible; arrancando directamente)
  start "" "%EXE%" --name %NAME% --server %SERVER% --token %TOKEN%
)

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
  pause
  exit /b 1
)

echo.
echo OK: agente en marcha. Nombre en el hub: %NAME%
echo Tarea programada: %TASK%   Log: %DIR%\logs\agent.log
echo A partir de aqui el agente se actualiza solo (auto-update por la share).
echo.
REM Sin "pause": esta ventana se cierra sola al terminar.
endlocal
