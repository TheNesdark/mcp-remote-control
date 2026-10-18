@echo off
setlocal ENABLEEXTENSIONS
rem === mrc-cua pilot v3: GAC reference discovery via dir /b /s + csc response file ===
set SHARE=\\192.168.1.191\Hermes
set LOG=%LOCALAPPDATA%\mrc-pilot-log.txt
set OUT=%LOCALAPPDATA%\mrc-cua-pilot.exe
set RES=%LOCALAPPDATA%\mrc-cua-results.txt
set SHOT=%LOCALAPPDATA%\mrc-cua-shot.png
set RSP=%LOCALAPPDATA%\mrc-refs.rsp
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
set RUNDIR=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319
if not exist "%RUNDIR%" set RUNDIR=%WINDIR%\Microsoft.NET\Framework\v4.0.30319

echo === pilot v3 %DATE% %TIME% === > "%LOG%"
echo compiler=%CSC% >> "%LOG%"
if not exist "%CSC%" (echo ERROR: csc.exe missing & goto :share)
if not exist "%SHARE%\mrc-cua.cs" (echo ERROR: source not on share & goto :share)

del "%RSP%" 2>nul
del "%RES%" 2>nul
call :find1 UIAutomationClient
set R1=%REF%
call :find1 UIAutomationTypes
set R2=%REF%
call :find1 System.Windows.Forms
set R3=%REF%
call :find1 System.Drawing
set R4=%REF%
echo refs: >> "%LOG%"
echo R1=%R1% >> "%LOG%"
echo R2=%R2% >> "%LOG%"
echo R3=%R3% >> "%LOG%"
echo R4=%R4% >> "%LOG%"
if "%R1%"=="" goto :missing
if "%R2%"=="" goto :missing
if "%R3%"=="" goto :missing
if "%R4%"=="" goto :missing

(echo /warn:0
echo /out:"%OUT%"
echo /r:"%R1%"
echo /r:"%R2%"
echo /r:"%R3%"
echo /r:"%R4%"
echo "%SHARE%\mrc-cua.cs") > "%RSP%"

echo [1/3] compiling...
"%CSC%" /nologo "@%RSP%" >> "%LOG%" 2>&1
if errorlevel 1 (echo BUILD_FAILED >> "%LOG%" & goto :share)
echo [1/3] compile OK >> "%LOG%"

echo [2/3] running evaluation...
"%OUT%" all "%SHOT%" > "%RES%" 2>&1
echo [2/3] eval exit=%ERRORLEVEL% >> "%LOG%"
type "%RES%" >> "%LOG%"
if not exist "%SHOT%" echo WARNING: no screenshot produced >> "%LOG%"

:share
echo [3/3] copying artifacts...
copy /y "%LOG%" "%SHARE%\mrc-pilot-log.txt" >nul 2>&1
if exist "%RES%" copy /y "%RES%" "%SHARE%\results.txt" >nul 2>&1
if exist "%SHOT%" copy /y "%SHOT%" "%SHARE%\mrc-cua-shot.png" >nul 2>&1
echo === PILOT V3 TERMINADO ===
echo log: %LOG%
pause
exit /b

:missing
echo ERROR: reference assembly not found (see refs above) >> "%LOG%"
goto :share

:find1
set REF=
for /f "tokens=* usebackq delims=" %%f in (`dir /b /s "%WINDIR%\Microsoft.NET\assembly\GAC_64\%~1\*.dll" 2^>nul`) do set "REF=%%f"
if "%REF%"=="" if exist "%RUNDIR%\%~1.dll" set "REF=%RUNDIR%\%~1.dll"
exit /b
