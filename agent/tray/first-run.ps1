# mcp-remote-control - first-run setup dialog (spike)
#
# Asks for the machine name (and server/token if not provided by the installer).
# Prints ONE JSON line to stdout and exits:
#   {"name":"PC-01","server":"ws://127.0.0.1:8787","token":"..."}   (exit 0)
#   {"cancelled":true}                                              (exit 2)
#   {"error":"invalid_name","name":"..."}                           (exit 3)
#
# Run:
#   powershell -NoProfile -Sta -ExecutionPolicy Bypass -File first-run.ps1

[CmdletBinding()]
param(
  [string]$DefaultName = $env:COMPUTERNAME,
  [string]$DefaultServer = "ws://127.0.0.1:8787",
  [string]$DefaultToken = "",
  [switch]$HideServer,
  [switch]$HideToken
)

# Auto-detect: if a server/token is provided (baked into the exe), hide
# those fields so the dialog only asks for the machine name.
if (-not $HideServer -and -not [string]::IsNullOrWhiteSpace($DefaultServer) -and $DefaultServer -ne "ws://127.0.0.1:8787") {
  $HideServer = $true
}
if (-not $HideToken -and -not [string]::IsNullOrWhiteSpace($DefaultToken)) {
  $HideToken = $true
}

# Count visible fields to size the form
$fieldCount = 1
if (-not $HideServer) { $fieldCount++ }
if (-not $HideToken) { $fieldCount++ }
$formHeight = 100 + ($fieldCount * 38) + 40

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = "mcp-remote-control - first run"
$form.Size = New-Object System.Drawing.Size(430, $formHeight)
$form.StartPosition = "CenterScreen"
$form.TopMost = $true
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.MinimizeBox = $false

function Add-Field {
  param([string]$LabelText, [string]$Value, [int]$Y)
  $label = New-Object System.Windows.Forms.Label
  $label.Text = $LabelText
  $label.Location = New-Object System.Drawing.Point(16, ($Y + 3))
  $label.Size = New-Object System.Drawing.Size(105, 20)
  $form.Controls.Add($label)

  $box = New-Object System.Windows.Forms.TextBox
  $box.Text = $Value
  $box.Location = New-Object System.Drawing.Point(125, $Y)
  $box.Size = New-Object System.Drawing.Size(270, 22)
  $form.Controls.Add($box)
  return $box
}

$y = 18
$nameBox = Add-Field -LabelText "Computer name" -Value $DefaultName -Y $y
$y += 38

$serverBox = $null
if (-not $HideServer) {
  $serverBox = Add-Field -LabelText "Server URL" -Value $DefaultServer -Y $y
  $y += 38
}

$tokenBox = $null
if (-not $HideToken) {
  $tokenBox = Add-Field -LabelText "Agent token" -Value $DefaultToken -Y $y
  $y += 38
}

$hint = New-Object System.Windows.Forms.Label
$hint.Text = "The name identifies this machine in agents_list."
$hint.ForeColor = [System.Drawing.Color]::DimGray
$hint.Location = New-Object System.Drawing.Point(16, $y)
$hint.Size = New-Object System.Drawing.Size(390, 20)
$form.Controls.Add($hint)
$y += 30

$okButton = New-Object System.Windows.Forms.Button
$okButton.Text = "Save"
$okButton.DialogResult = [System.Windows.Forms.DialogResult]::OK
$okButton.Location = New-Object System.Drawing.Point(230, $y)
$form.Controls.Add($okButton)

$cancelButton = New-Object System.Windows.Forms.Button
$cancelButton.Text = "Cancel"
$cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$cancelButton.Location = New-Object System.Drawing.Point(320, $y)
$form.Controls.Add($cancelButton)

$form.AcceptButton = $okButton
$form.CancelButton = $cancelButton

$result = $form.ShowDialog()
if ($result -ne [System.Windows.Forms.DialogResult]::OK) {
  '{"cancelled":true}'
  exit 2
}

$name = $nameBox.Text.Trim()
if ($name -notmatch '^[A-Za-z0-9._-]{1,32}$') {
  (@{ error = "invalid_name"; name = $name } | ConvertTo-Json -Compress)
  exit 3
}

$result = @{ name = $name }
if ($serverBox -ne $null) { $result.server = $serverBox.Text.Trim() }
if ($tokenBox -ne $null) { $result.token = $tokenBox.Text.Trim() }
($result | ConvertTo-Json -Compress)
exit 0
