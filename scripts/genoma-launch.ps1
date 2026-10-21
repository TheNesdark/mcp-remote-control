# genoma-launch.ps1 - lanza GENOMA y espera a que aparezca el login.
#
# GENOMA (GenomaP.jar) a veces sale solo a los 30-60 segundos de arrancar, sin
# dejar error: el pre-calentado del contexto JPA corre en segundo plano y la
# ventana aparece mas tarde. Este script reintenta hasta que el dialogo de
# autenticacion esta en pantalla y escribe su HWND en un fichero, para que el
# agente pueda trabajar con el sin depender de coordenadas adivinadas.
#
# Compatible con Windows PowerShell 5.1 (no usa el ternario de PowerShell 7).
#
# Uso (en la maquina donde este GENOMA):
#   powershell -NoProfile -ExecutionPolicy Bypass -File genoma-launch.ps1
#
# Opciones (variables de entorno):
#   GENOMA_DIR   carpeta de la aplicacion      (por defecto C:\Genoma)
#   GENOMA_JAR   el jar                        (por defecto <GENOMA_DIR>\GenomaP.jar)
#   GENOMA_JAVA  el java.exe                   (por defecto <GENOMA_DIR>\bin\java.exe,
#                                               si no existe, el java del PATH)
#   GENOMA_MARK  fichero donde dejar el estado (por defecto %TEMP%\genoma-state.txt)
#   GENOMA_TRIES intentos maximos              (por defecto 25)

$ErrorActionPreference = 'SilentlyContinue'

if ($env:GENOMA_DIR) { $dir = $env:GENOMA_DIR } else { $dir = 'C:\Genoma' }
if ($env:GENOMA_JAR) { $jar = $env:GENOMA_JAR } else { $jar = Join-Path $dir 'GenomaP.jar' }
if ($env:GENOMA_JAVA) {
  $java = $env:GENOMA_JAVA
} elseif (Test-Path (Join-Path $dir 'bin\java.exe')) {
  $java = Join-Path $dir 'bin\java.exe'
} else {
  $java = (Get-Command java -ErrorAction SilentlyContinue).Source
}
if ($env:GENOMA_MARK) { $marker = $env:GENOMA_MARK } else { $marker = Join-Path $env:TEMP 'genoma-state.txt' }
if ($env:GENOMA_TRIES) { $tries = [int]$env:GENOMA_TRIES } else { $tries = 25 }

Add-Type @'
using System;using System.Runtime.InteropServices;using System.Text;
public class GenomaWindows{
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc e, IntPtr l);
 public delegate bool EnumProc(IntPtr h, IntPtr l);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
'@

function Find-LoginDialog {
  $script:found = [IntPtr]::Zero
  [GenomaWindows]::EnumWindows({ param($h,$l)
    if ([GenomaWindows]::IsWindowVisible($h)) {
      $c = New-Object System.Text.StringBuilder 256
      [GenomaWindows]::GetClassName($h,$c,256) | Out-Null
      if ($c.ToString() -eq 'SunAwtDialog') {
        $t = New-Object System.Text.StringBuilder 512
        [GenomaWindows]::GetWindowText($h,$t,512) | Out-Null
        if ($t.ToString() -like '*G@noma Plus*') { $script:found = $h }
      }
    }
    return $true }, [IntPtr]::Zero) | Out-Null
  return $script:found
}

if (-not $java) {
  "ERROR: no encuentro java.exe (define GENOMA_JAVA)" | Set-Content $marker
  exit 1
}
if (-not (Test-Path $java)) {
  "ERROR: no existe el runtime de Java en $java" | Set-Content $marker
  exit 1
}
if (-not (Test-Path $jar)) {
  "ERROR: no existe $jar" | Set-Content $marker
  exit 1
}

Remove-Item $marker -Force -ErrorAction SilentlyContinue
"java=$java" | Add-Content $marker

for ($i = 1; $i -le $tries; $i++) {
  $running = Get-Process java -ErrorAction SilentlyContinue
  if (-not $running) {
    # Lanzado por WMI, no con Start-Process: asi GENOMA NO queda colgando del
    # arbol de procesos del agente y sobrevive cuando el agente se reinicia o
    # se actualiza (con Start-Process, el reinicio del agente se lo llevaba).
    $cmd = ('"{0}" -jar "{1}" > "{2}" 2> "{3}"' -f $java, $jar, (Join-Path $dir '_out.txt'), (Join-Path $dir '_err.txt'))
    $null = ([wmiclass]'Win32_Process').Create($cmd, $dir)
    ("lanzado intento {0} {1}" -f $i, (Get-Date).ToString('HH:mm:ss')) | Add-Content $marker
  }
  for ($t = 0; $t -lt 24; $t++) {
    Start-Sleep -Seconds 5
    $h = Find-LoginDialog
    if ($h -ne [IntPtr]::Zero) {
      ("DIALOGO hwnd={0} intento={1} {2}" -f $h.ToInt64(), $i, (Get-Date).ToString('HH:mm:ss')) | Add-Content $marker
      exit 0
    }
    if (-not (Get-Process java -ErrorAction SilentlyContinue)) { break }
  }
}
"FAIL: el dialogo de autenticacion no aparecio en $tries intentos" | Add-Content $marker
exit 1
