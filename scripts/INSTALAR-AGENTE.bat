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
set "SRC=%SH%\rc-agent.exe"
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
for /f "tokens=3 delims=." %%a in ('powershell -NoProfile -Command "(Get-Item '%EXE%').VersionInfo.FileVersion" 2^>nul') do echo        version instalada: %%a.%%b.%%c

REM --- 3) autoinicio al iniciar sesion (clave Run del usuario) ---
echo [3/4] Registrando el autoinicio...
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "mcp-remote-control" /t REG_SZ /d "\"%EXE%\"" /f >nul 2>&1
if errorlevel 1 (
  echo        AVISO: no se pudo registrar el autoinicio.
) else (
  echo        Hecho: arrancara solo al iniciar sesion.
)

REM --- 4) arrancar ---
echo [4/4] Arrancando el agente...
start "" "%EXE%" --name %NAME% --server %SERVER% --token %TOKEN%
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

:fin
echo   Pulsa una tecla para cerrar esta ventana.
pause >nul
endlocal
