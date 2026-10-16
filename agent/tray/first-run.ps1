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
  [string]$DefaultToken = ""
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = "mcp-remote-control - first run"
$form.Size = New-Object System.Drawing.Size(430, 240)
$form.StartPosition = "CenterScreen"
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

$nameBox = Add-Field -LabelText "Computer name" -Value $DefaultName -Y 18
$serverBox = Add-Field -LabelText "Server URL" -Value $DefaultServer -Y 52
$tokenBox = Add-Field -LabelText "Agent token" -Value $DefaultToken -Y 86

$hint = New-Object System.Windows.Forms.Label
$hint.Text = "The name identifies this machine in agents_list."
$hint.ForeColor = [System.Drawing.Color]::DimGray
$hint.Location = New-Object System.Drawing.Point(16, 116)
$hint.Size = New-Object System.Drawing.Size(390, 20)
$form.Controls.Add($hint)

$okButton = New-Object System.Windows.Forms.Button
$okButton.Text = "Save"
$okButton.DialogResult = [System.Windows.Forms.DialogResult]::OK
$okButton.Location = New-Object System.Drawing.Point(230, 150)
$form.Controls.Add($okButton)

$cancelButton = New-Object System.Windows.Forms.Button
$cancelButton.Text = "Cancel"
$cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$cancelButton.Location = New-Object System.Drawing.Point(320, 150)
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

(@{
  name   = $name
  server = $serverBox.Text.Trim()
  token  = $tokenBox.Text.Trim()
} | ConvertTo-Json -Compress)
exit 0
