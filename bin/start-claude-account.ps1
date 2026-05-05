#requires -version 5
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('a', 'b')]
  [string]$Which,

  [Parameter(Mandatory = $true)]
  [string]$VaultPath,

  [Parameter(Mandatory = $true)]
  [string]$CredentialsPath,

  [Parameter(Mandatory = $true)]
  [string]$MarkerPath,

  [Parameter(ValueFromRemainingArguments = $true)]
  [object[]]$ClaudeArgs
)

$ErrorActionPreference = 'Stop'
$label = $Which.ToUpperInvariant()

if (-not (Test-Path -LiteralPath $VaultPath)) {
  Write-Host "[!] Account $label credentials not saved yet."
  Write-Host "    First login normally with 'claude' then run:"
  Write-Host "    copy `"$CredentialsPath`" `"$VaultPath`""
  exit 1
}

Copy-Item -LiteralPath $VaultPath -Destination $CredentialsPath -Force
[Console]::Title = "Claude Code [Account $label]"

$identityScript = Join-Path $PSScriptRoot 'update-claude-account-identity.ps1'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $identityScript `
  -Which $Which `
  -VaultPath $VaultPath `
  -CredentialsPath $CredentialsPath `
  -MarkerPath $MarkerPath

$syncScript = Join-Path $PSScriptRoot 'sync-claude-account-vault.ps1'
$syncArgs = @(
  '-NoProfile',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  $syncScript,
  '-Which',
  $Which,
  '-VaultPath',
  $VaultPath,
  '-CredentialsPath',
  $CredentialsPath,
  '-MarkerPath',
  $MarkerPath,
  '-MonitorPid',
  [string]$PID,
  '-InitialDelaySeconds',
  '8',
  '-IntervalSeconds',
  '60'
)
Start-Process -FilePath 'powershell.exe' -ArgumentList $syncArgs -WindowStyle Hidden | Out-Null

& claude @ClaudeArgs
if ($null -ne $global:LASTEXITCODE) {
  exit $global:LASTEXITCODE
}
