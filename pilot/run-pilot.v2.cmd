@echo off
setlocal ENABLEDELAYEDEXPANSION
rem === mrc-cua pilot v2: full diagnostics ===
rem Writes EVERYTHING locally first (log + exe + results + screenshot), then
rem copies artifacts to the Hermes share. Never exits silently.
set SHARE=\\192.168.1.191\Hermes
set LOG=%LOCALAPPDATA%\mrc-pilot-log.txt
set OUT=%LOCALAPPDATA%\mrc-cua-pilot.exe
set RES=%LOCALAPPDATA%\mrc-cua-results.txt
set SHOT=%LOCALAPPDATA%\mrc-cua-shot.png

echo === mrc-cua pilot run %DATE% %TIME% === > "%LOG%"
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
echo compiler=%CSC% >> "%LOG%"
if not exist "%CSC%" (
  echo ERROR: csc.exe not found on this system >> "%LOG%"
  goto :share
)
if not exist "%SHARE%\mrc-cua.cs" (
  echo ERROR: %SHARE%\mrc-cua.cs not readable from this session >> "%LOG%"
  goto :share
)

echo [1/3] compiling...
echo [1/3] compile >> "%LOG%"
"%CSC%" /nologo /warn:0 /out:"%OUT%" /r:"%WINDIR%\Microsoft.NET\frmref4" "%SHARE%\mrc-cua.cs" >> "%LOG%" 2>&1
if errorlevel 1 (
  echo attempt 1 failed, retrying with plain references >> "%LOG%"
  "%CSC%" /nologo /warn:0 /out:"%OUT%" /r:UIAutomationClient.dll /r:UIAutomationTypes.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll "%SHARE%\mrc-cua.cs" >> "%LOG%" 2>&1
)
if errorlevel 1 (
  echo BUILD_FAILED >> "%LOG%"
  goto :share
)
echo [1/3] compile OK >> "%LOG%"

echo [2/3] running evaluation...
"%OUT%" all "%SHOT%" > "%RES%" 2>&1
echo [2/3] eval exit=%ERRORLEVEL% >> "%LOG%"
type "%RES%" >> "%LOG%"
if not exist "%SHOT%" echo WARNING: no screenshot file produced >> "%LOG%"

:share
echo [3/3] copying artifacts to the share...
copy /y "%LOG%" "%SHARE%\mrc-pilot-log.txt" >> "%LOG%" 2>&1
copy /y "%RES%" "%SHARE%\results.txt" >> "%LOG%" 2>&1
if exist "%SHOT%" copy /y "%SHOT%" "%SHARE%\mrc-cua-shot.png" >> "%LOG%" 2>&1
echo.
echo === PILOT TERMINADO ===
echo Log local: %LOG%
pause
