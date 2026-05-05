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

  [int]$MonitorPid = 0,

  [int]$InitialDelaySeconds = 8,

  [int]$IntervalSeconds = 60,

  [switch]$Once
)

$ErrorActionPreference = 'Stop'
$identityScript = Join-Path $PSScriptRoot 'update-claude-account-identity.ps1'

function Test-MonitorAlive {
  if ($MonitorPid -le 0) { return $true }
  return $null -ne (Get-Process -Id $MonitorPid -ErrorAction SilentlyContinue)
}

function Sync-Once {
  if (-not (Test-Path -LiteralPath $CredentialsPath)) { return }
  if (-not (Test-Path -LiteralPath $VaultPath)) { return }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $identityScript `
    -Which $Which `
    -VaultPath $VaultPath `
    -CredentialsPath $CredentialsPath `
    -MarkerPath $MarkerPath `
    -SyncOauthFromCredentials
}

if ($InitialDelaySeconds -gt 0) {
  Start-Sleep -Seconds $InitialDelaySeconds
}

while (Test-MonitorAlive) {
  try {
    Sync-Once
  } catch {
    Write-Warning "account $Which vault sync failed: $($_.Exception.Message)"
  }

  if ($Once) { break }
  Start-Sleep -Seconds ([Math]::Max(1, $IntervalSeconds))
}
