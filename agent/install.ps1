<#
.SYNOPSIS
  Installs the mcp-remote-control agent (rc-agent.exe) on Windows, user scope, no admin needed.

.DESCRIPTION
  Copies rc-agent.exe + the tray/first-run helpers into $InstallDir (default
  %LOCALAPPDATA%\mcp-remote-control), writes %APPDATA%\mcp-remote-control\agent.json
  (token encrypted with DPAPI, current user), registers Start with Windows
  (HKCU\...\Run) and starts the agent. Re-running updates config and files.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Server ws://192.168.1.50:8787 -Token mrc_xxxx -Name OFICINA-01

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$Server = "",
  [string]$Token = "",
  [string]$Name = $env:COMPUTERNAME,
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "mcp-remote-control"),
  [string]$ExePath = "",
  [string]$HelperDir = "",
  [switch]$NoAutostart,
  [switch]$NoStart,
  [switch]$Uninstall,
  [switch]$Purge
)

$ErrorActionPreference = "Stop"
$AppDataDir = Join-Path $env:APPDATA "mcp-remote-control"
$ConfigPath = Join-Path $AppDataDir "agent.json"
$RunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$RunName = "mcp-remote-control"

function Protect-Token([string]$Plain) {
  Add-Type -AssemblyName System.Security
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Plain)
  $protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  return [System.Convert]::ToBase64String($protected)
}

if ($Uninstall) {
  Write-Host "Uninstalling mcp-remote-control agent..."
  Get-Process -Name "rc-agent" -ErrorAction SilentlyContinue | Stop-Process -Force
  Remove-ItemProperty -Path $RunKey -Name $RunName -ErrorAction SilentlyContinue
  if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
  if ($Purge -and (Test-Path $ConfigPath)) {
    Remove-Item -Force $ConfigPath
    Write-Host "Removed $ConfigPath (logs kept)."
  } else {
    Write-Host "Kept config at $ConfigPath (use -Purge to remove it)."
  }
  Write-Host "Done."
  exit 0
}

# --- Resolve sources ---------------------------------------------------------
if (-not $ExePath) { $ExePath = Join-Path $PSScriptRoot "rc-agent.exe" }
if (-not (Test-Path $ExePath)) {
  Write-Error "rc-agent.exe not found at $ExePath. Download it next to install.ps1 or pass -ExePath."
  exit 1
}
if (-not $HelperDir) { $HelperDir = Join-Path $PSScriptRoot "tray" }
if (-not (Test-Path $HelperDir)) { $HelperDir = $PSScriptRoot }  # flat layout: ps1 next to the exe
foreach ($helper in @("tray.ps1", "first-run.ps1")) {
  if (-not (Test-Path (Join-Path $HelperDir $helper))) {
    Write-Error "Missing helper $helper in $HelperDir. Copy agent/tray/*.ps1 next to install.ps1."
    exit 1
  }
}

if ($Name -notmatch "^[A-Za-z0-9._-]{1,32}$") {
  Write-Error "Invalid -Name '$Name' (use letters, digits, dot, dash or underscore, max 32)."
  exit 1
}

# --- Install files -----------------------------------------------------------
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Force $ExePath (Join-Path $InstallDir "rc-agent.exe")
Copy-Item -Force (Join-Path $HelperDir "tray.ps1") (Join-Path $InstallDir "tray.ps1")
Copy-Item -Force (Join-Path $HelperDir "first-run.ps1") (Join-Path $InstallDir "first-run.ps1")
Write-Host "Installed files to $InstallDir"

# --- Config (keep existing values unless overridden) --------------------------
New-Item -ItemType Directory -Force -Path $AppDataDir | Out-Null
$existing = New-Object PSObject
if (Test-Path $ConfigPath) {
  # Note: no -AsHashtable (needs PS 6+); property access on $null is fine.
  try { $existing = Get-Content $ConfigPath -Raw | ConvertFrom-Json } catch { $existing = New-Object PSObject }
}
$finalName = $Name
$finalServer = if ($Server) { $Server } elseif ($existing.server) { $existing.server } else { "" }
if (-not $finalServer) {
  Write-Error "No server URL: pass -Server ws://<lan-ip>:8787 (or keep a previous agent.json)."
  exit 1
}
$config = @{
  name   = $finalName
  server = $finalServer
  tags   = if ($existing.tags) { $existing.tags } else { @() }
}
if ($existing.id) { $config.id = $existing.id }
if ($existing.paused -ne $null) { $config.paused = [bool]$existing.paused }
if ($Token) {
  $config.tokenProtected = Protect-Token $Token
} elseif ($existing.tokenProtected) {
  $config.tokenProtected = $existing.tokenProtected
} elseif ($existing.token) {
  $config.token = $existing.token
} else {
  Write-Error "No token: pass -Token <agent-token> (or keep a previous agent.json)."
  exit 1
}
$config | ConvertTo-Json | Set-Content -Encoding UTF8 $ConfigPath
Write-Host "Wrote $ConfigPath"

# --- Autostart ----------------------------------------------------------------
$exeTarget = Join-Path $InstallDir "rc-agent.exe"
if (-not $NoAutostart) {
  New-Item -Path $RunKey -Force | Out-Null
  Set-ItemProperty -Path $RunKey -Name $RunName -Value "`"$exeTarget`""
  Write-Host "Registered Start with Windows (HKCU Run)."
} else {
  Remove-ItemProperty -Path $RunKey -Name $RunName -ErrorAction SilentlyContinue
}

# --- Start --------------------------------------------------------------------
if (-not $NoStart) {
  Get-Process -Name "rc-agent" -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Process -FilePath $exeTarget
  Write-Host "Agent started. Look for the tray icon next to the clock."
  Write-Host "Verify from the server host: bun run admin -- server status"
} else {
  Write-Host "Skipped start (-NoStart). Run `"$exeTarget`" to launch it."
}
