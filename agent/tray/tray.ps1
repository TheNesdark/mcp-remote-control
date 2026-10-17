# mcp-remote-control - tray helper (F3)
#
# Shows a NotifyIcon next to the clock (like the volume/battery icons) and lets
# the local user enable/disable the agent, reconnect, open logs, toggle autostart
# and exit. It talks JSON-lines with the Bun agent over stdin/stdout:
#
#   stdin  <- {"type":"state","state":"connecting|connected|paused|disconnected","label":"PC-01","detail":"ws://...","autostart":true,"logDir":"C:\\...\\logs"}
#   stdin  <- {"type":"exit"}
#   stdout -> {"type":"action","action":"toggle|reconnect|open_logs|autostart|exit|already_running","enabled":true}
#
# The agent performs the actual registry write for "Start with Windows" and
# sends the resulting state back (the helper never touches the registry).
#
# Run (STA is required for WinForms):
#   powershell -NoProfile -Sta -ExecutionPolicy Bypass -File tray.ps1 -Label "PC-01"
#   powershell -NoProfile -Sta -ExecutionPolicy Bypass -File tray.ps1 -Demo   # cycles states, no agent needed

[CmdletBinding()]
param(
  [string]$Label = "agent",
  [string]$InitialState = "connecting",
  [switch]$Demo
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if ([System.Threading.Thread]::CurrentThread.GetApartmentState() -ne "STA") {
  Write-Error "tray.ps1 must run on an STA thread (use: powershell -Sta -File tray.ps1)"
  exit 5
}

# Single instance.
$mutex = New-Object System.Threading.Mutex($false, "Global\mcp-remote-control-tray")
if (-not $mutex.WaitOne(0)) {
  '{"type":"action","action":"already_running"}'
  exit 4
}

$script:state = $InitialState
$script:label = $Label
$script:detail = ""
$script:logDir = ""

function Emit {
  param($Object)
  $Object | ConvertTo-Json -Compress | Write-Output
}

# ---------------------------------------------------------------------------
# State icons: a colored dot per state (drawn at runtime, no .ico files needed)
# ---------------------------------------------------------------------------
function New-StateIcon {
  param([System.Drawing.Color]$Color)
  $bmp = New-Object System.Drawing.Bitmap 16, 16
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $brush = New-Object System.Drawing.SolidBrush $Color
    try {
      $g.FillEllipse($brush, 1, 1, 14, 14)
      $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(160, 0, 0, 0)), 1
      try { $g.DrawEllipse($pen, 1, 1, 14, 14) } finally { $pen.Dispose() }
    } finally { $brush.Dispose() }
  } finally { $g.Dispose() }
  $handle = $bmp.GetHicon()
  $icon = [System.Drawing.Icon]::FromHandle($handle)
  $bmp.Dispose()
  return $icon
}

$script:icons = @{
  connected    = New-StateIcon ([System.Drawing.Color]::FromArgb(34, 177, 76))    # green
  paused       = New-StateIcon ([System.Drawing.Color]::FromArgb(255, 201, 14))   # yellow
  connecting   = New-StateIcon ([System.Drawing.Color]::FromArgb(127, 127, 127))  # gray
  disconnected = New-StateIcon ([System.Drawing.Color]::FromArgb(237, 28, 36))    # red
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $script:icons[$script:state]
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$statusItem = New-Object System.Windows.Forms.ToolStripMenuItem
$statusItem.Enabled = $false
[void]$menu.Items.Add($statusItem)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$toggleItem = New-Object System.Windows.Forms.ToolStripMenuItem
$toggleItem.Text = "Disable agent"
[void]$menu.Items.Add($toggleItem)

$reconnectItem = New-Object System.Windows.Forms.ToolStripMenuItem
$reconnectItem.Text = "Reconnect now"
[void]$menu.Items.Add($reconnectItem)

$logsItem = New-Object System.Windows.Forms.ToolStripMenuItem
$logsItem.Text = "Open logs"
[void]$menu.Items.Add($logsItem)

$settingsItem = New-Object System.Windows.Forms.ToolStripMenuItem
$settingsItem.Text = "Settings..."
[void]$menu.Items.Add($settingsItem)

$autostartItem = New-Object System.Windows.Forms.ToolStripMenuItem
$autostartItem.Text = "Start with Windows"
$autostartItem.CheckOnClick = $true
[void]$menu.Items.Add($autostartItem)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem
$exitItem.Text = "Exit"
[void]$menu.Items.Add($exitItem)

$notify.ContextMenuStrip = $menu

function Update-Status {
  $text = switch ($script:state) {
    "connected"    { "Connected" }
    "paused"       { "Paused (disabled locally)" }
    "connecting"   { "Connecting..." }
    "disconnected" { "Disconnected" }
    default        { $script:state }
  }
  if ($script:icons.ContainsKey($script:state)) { $notify.Icon = $script:icons[$script:state] }
  $statusItem.Text = "$($script:label) - $text"
  $tooltip = "$($script:label) - $text"
  if ($script:detail) { $tooltip = "$tooltip - $($script:detail)" }
  if ($tooltip.Length -gt 63) { $tooltip = $tooltip.Substring(0, 63) }   # NotifyIcon limit
  $notify.Text = $tooltip
  $toggleItem.Text = if ($script:state -eq "paused") { "Enable agent" } else { "Disable agent" }
}

$toggleItem.Add_Click({ Emit @{ type = "action"; action = "toggle" } })
$reconnectItem.Add_Click({ Emit @{ type = "action"; action = "reconnect" } })
$logsItem.Add_Click({ Emit @{ type = "action"; action = "open_logs" } })
$settingsItem.Add_Click({ Emit @{ type = "action"; action = "settings" } })

# The agent owns the registry: just report the desired value and wait for the
# next state line to confirm (it echoes autostart back).
$autostartItem.Add_Click({
  Emit @{ type = "action"; action = "autostart"; enabled = [bool]$autostartItem.Checked }
})

$exitItem.Add_Click({
  Emit @{ type = "action"; action = "exit" }
  $notify.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})

$notify.Add_MouseDoubleClick({
  Emit @{ type = "action"; action = "toggle" }
})

Update-Status

# ---------------------------------------------------------------------------
# stdin reader (async, non-blocking for the message loop)
# ---------------------------------------------------------------------------
$stdinReader = New-Object System.IO.StreamReader ([Console]::OpenStandardInput())
$script:pendingRead = $stdinReader.ReadLineAsync()

$stdinTimer = New-Object System.Windows.Forms.Timer
$stdinTimer.Interval = 100
$stdinTimer.Add_Tick({
  if (-not $script:pendingRead -or -not $script:pendingRead.IsCompleted) { return }
  $line = $script:pendingRead.GetAwaiter().GetResult()
  $script:pendingRead = $stdinReader.ReadLineAsync()

  if ($null -eq $line) {
    # parent process is gone: exit
    $notify.Visible = $false
    [System.Windows.Forms.Application]::Exit()
    return
  }

  $line = $line.Trim()
  if (-not $line) { return }
  try { $msg = $line | ConvertFrom-Json } catch { return }

  switch ($msg.type) {
    "state" {
      if ($msg.state) { $script:state = $msg.state }
      if ($msg.label) { $script:label = $msg.label }
      $script:detail = if ($msg.detail) { $msg.detail } else { "" }
      if ($msg.logDir) { $script:logDir = $msg.logDir }
      if ($null -ne $msg.autostart) { $autostartItem.Checked = [bool]$msg.autostart }
      Update-Status
    }
    "exit" {
      $notify.Visible = $false
      [System.Windows.Forms.Application]::Exit()
    }
  }
})
$stdinTimer.Start()

# ---------------------------------------------------------------------------
# demo mode: cycle states so the icon can be validated without the agent
# ---------------------------------------------------------------------------
if ($Demo) {
  $script:demoStates = @("connecting", "connected", "paused", "disconnected")
  $script:demoIndex = 0
  $demoTimer = New-Object System.Windows.Forms.Timer
  $demoTimer.Interval = 2000
  $demoTimer.Add_Tick({
    $script:state = $script:demoStates[$script:demoIndex % $script:demoStates.Count]
    $script:demoIndex++
    $script:detail = "demo"
    Update-Status
  })
  $demoTimer.Start()
}

[System.Windows.Forms.Application]::Run()
$notify.Visible = $false
$notify.Dispose()
$mutex.ReleaseMutex()
exit 0
