@echo off
setlocal EnableDelayedExpansion

REM ---------------------------------------------------------------
REM  rc-agent (C# / .NET 8, un solo exe self-contained)
REM
REM  Copia el exe desde la share a %LOCALAPPDATA%\mrc-remote-control,
REM  lo arranca y deja el autoinicio en la clave Run del usuario
REM  (HKCU\...\Run), para que arranque solo al iniciar sesion.
REM
REM  No usa tareas programadas y no deja ninguna ventana de consola
REM  del agente abierta. Esta ventana se queda para poder leer el
REM  resultado: pulsa una tecla para cerrarla.
REM ---------------------------------------------------------------

set "SH=\\192.168.1.191\Hermes"
set "DIR=%LOCALAPPDATA%\mrc-remote-control"
set "EXE=%DIR%\rc-agent.exe"
REM   El binario se copia del MISMO archivo que usa el auto-update del hub
REM   (MRC_AGENT_BINARY_UNC). Con dos archivos en la share uno se queda
REM   atras y el instalador pone en la maquina una build vieja.
set "SRC=%SH%\rc-agent-update.exe"
set "NAME=SERVER-RX"
set "SERVER=ws://192.168.1.192:8787"
set "TOKEN=mrc_LajSuZKlZ57FDiI2ohKll0eisXagGTFndEv2GYu7-SY"

echo.
echo   rc-agent - instalando
echo   ============================================
echo.

REM --- 1) parar el agente anterior ---
echo [1/4] Parando el agente anterior...
taskkill /f /im rc-agent.exe >nul 2>&1
timeout /t 2 /nobreak >nul

REM --- 2) copiar el exe ---
echo [2/4] Copiando el exe desde la share (154 MB, tarda)...
if not exist "%DIR%" mkdir "%DIR%"
copy /y "%SRC%" "%EXE%" >nul
if errorlevel 1 (
  echo.
  echo   ERROR: no se pudo copiar "%SRC%".
  echo   Comprueba que la share responde:  dir "%SH%"
  goto fin
)
powershell -NoProfile -Command "Unblock-File -Path '%EXE%' -ErrorAction SilentlyContinue" >nul 2>&1

REM     La version se lee del binario QUE SE ACABA DE COPIAR (no de la
REM     share): asi se ve de verdad que version quedo instalada. El
REM     FileVersion es "1.0.31.0"; el ProductVersion, "1.0.31".
set "VER="
for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "(Get-Item '%EXE%').VersionInfo.ProductVersion.Split('+')[0]" 2^>nul`) do set "VER=%%v"
if defined VER (
  echo        version instalada: %VER%
) else (
  echo        AVISO: no se pudo leer la version del binario instalado.
)

REM --- 3) autoinicio al iniciar sesion (clave Run del usuario) ---
REM     Si el equipo ya tiene un agente configurado, se arranca SIN argumentos:
REM     el agente lee su config (nombre, servidor, token) y asi no se crea un
REM     agente nuevo con otro nombre. Solo en una instalacion nueva (sin
REM     config) se pasan los argumentos.
set "CFG=%APPDATA%\mcp-remote-control\agent.json"
set "AGENTARGS="
if not exist "%CFG%" (
  set "AGENTARGS=--name %NAME% --server %SERVER% --token %TOKEN%"
  echo        (instalacion nueva: se usara %NAME%)
) else (
  echo        (config existente: se respeta su nombre y servidor)
)

echo [3/4] Registrando el autoinicio...
set "RUNCMD=\"%EXE%\""
if defined AGENTARGS set "RUNCMD=\"%EXE%\" %AGENTARGS%"
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "mcp-remote-control" /t REG_SZ /d "%RUNCMD%" /f >nul 2>&1
if errorlevel 1 (
  echo        AVISO: no se pudo registrar el autoinicio.
) else (
  echo        Hecho: arrancara solo al iniciar sesion.
)

REM --- 4) arrancar ---
echo [4/4] Arrancando el agente...
start "" "%EXE%" %AGENTARGS%
timeout /t 8 /nobreak >nul
tasklist /fi "imagename eq rc-agent.exe" 2>nul | find /i "rc-agent.exe" >nul
if errorlevel 1 (
  echo.
  echo   ERROR: el agente no arranco. Ultimas lineas de su log:
  echo   ------------------------------------------------------------
  if exist "%DIR%\logs\agent.log" (
    powershell -NoProfile -Command "Get-Content '%DIR%\logs\agent.log' -Tail 20"
  ) else (
    echo   (no hay log)
  )
  echo   ------------------------------------------------------------
  goto fin
)

echo.
echo   OK: el agente esta en marcha. Se llama %NAME%.
echo   Autoinicio: clave Run del usuario.
echo   Log: %DIR%\logs\agent.log
echo.

REM --- copia del log del agente a la share (para diagnostico remoto) ---
if exist "%DIR%\logs\agent.log" (
  copy /y "%DIR%\logs\agent.log" "%SH%\_agent.log" >nul 2>&1
)

:fin
echo   Pulsa una tecla para cerrar esta ventana.
pause >nul
endlocal
