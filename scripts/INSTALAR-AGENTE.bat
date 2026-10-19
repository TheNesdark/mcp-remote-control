@echo off
setlocal EnableDelayedExpansion

REM ---------------------------------------------------------------
REM  rc-agent (C# / .NET 8, un solo exe self-contained)
REM
REM  1) instala el exe en %LOCALAPPDATA%\mrc-remote-control
REM  2) deja el arranque automatico en la clave Run del usuario
REM     (HKCU\...\Run). No hace falta ser administrador y funciona
REM     igual que una tarea programada: al iniciar sesion arranca el
REM     agente, que es lo que sostiene el auto-update.
REM  3) arranca el agente.
REM
REM  Este .bat NO deja ninguna ventana de consola abierta: termina solo
REM  (la pausa queda solo cuando hay un error que hay que leer).
REM ---------------------------------------------------------------

set "SH=\\192.168.1.191\Hermes"
set "DIR=%LOCALAPPDATA%\mrc-remote-control"
set "EXE=%DIR%\rc-agent.exe"
set "RUN=%DIR%\run-agent.cmd"
set "SRC=%SH%\rc-agent.exe"
set "NAME=SERVER-RX"
set "SERVER=ws://192.168.1.192:8787"
set "TOKEN=mrc_LajSuZKlZ57FDiI2ohKll0eisXagGTFndEv2GYu7-SY"
set "RUNKEY=HKCU\Software\Microsoft\Windows\CurrentVersion\Run"

REM --- registro de la ejecucion (en la share, para diagnosticar fallos) ---
set "LOG=%SH%\_instalar-agente.log"
echo ============================================================
echo   rc-agent  ^|  instalando, arrancando y dejando el autoinicio
echo ============================================================
echo.
echo [%DATE% %TIME%] inicio de INSTALAR-AGENTE.bat > "%LOG%"
echo instalando... >> "%LOG%"

REM --- 1) detener el agente anterior ---
echo [1/5] Deteniendo instancias previas... & echo paso1: matando instancias >> "%LOG%"
taskkill /f /im rc-agent.exe        >nul 2>&1
taskkill /f /im rc-agent-109.exe    >nul 2>&1
taskkill /f /im rc-agent-dotnet.exe >nul 2>&1
timeout /t 2 /nobreak >nul

REM --- 2) copiar el exe nuevo desde el share ---
echo [2/5] Copiando desde el share (154 MB, tarda un poco)... & echo paso2: copiando >> "%LOG%"
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
echo [3/5] Quitando la marca de red del exe... & echo paso3: unblock >> "%LOG%"
powershell -NoProfile -Command "Unblock-File -Path '%EXE%' -ErrorAction SilentlyContinue" >nul 2>&1

REM --- 4) arranque automatico al iniciar sesion (clave Run del usuario) ---
echo [4/5] Dejando el autoinicio en la clave Run... & echo paso4: registro en la clave Run >> "%LOG%"
> "%RUN%" echo @echo off
>> "%RUN%" echo start "" "%EXE%" --name %NAME% --server %SERVER% --token %TOKEN%
reg add "%RUNKEY%" /v "mcp-remote-control" /t REG_SZ /d "\"%EXE%\"" /f >nul 2>&1
if errorlevel 1 (
  echo        AVISO: no se pudo registrar el autoinicio (el agente no arrancara solo).
) else (
  echo        Autoinicio registrado: el agente arranca al iniciar sesion.
)

REM --- 5) arrancar el agente ahora ---
echo [5/5] Arrancando el agente... & echo paso5: arrancando >> "%LOG%"
start "" "%EXE%" --name %NAME% --server %SERVER% --token %TOKEN%

timeout /t 10 /nobreak >nul
tasklist /fi "imagename eq rc-agent.exe" 2>nul | find /i "rc-agent.exe" >nul
if errorlevel 1 (
  echo el proceso NO vive >> "%LOG%"
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

REM --- copia del log del agente a la share (diagnostico) ---
timeout /t 3 /nobreak >nul
if exist "%DIR%\logs\agent.log" (
  copy /y "%DIR%\logs\agent.log" "%SH%\_agent.log" >nul 2>&1
)

echo.
echo OK: agente en marcha. Nombre en el hub: %NAME%
echo Autoinicio: clave Run del usuario.   Log: %DIR%\logs\agent.log
echo A partir de aqui el agente se actualiza solo (auto-update por la share).
echo OK: el agente esta vivo &gt;&gt; "%LOG%"
echo.
REM Sin "pause": esta ventana se cierra sola al terminar.
endlocal
