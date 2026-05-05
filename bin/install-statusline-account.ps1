#requires -version 5
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$UserHome = $env:USERPROFILE
)

$ErrorActionPreference = 'Stop'

$claudeDir = Join-Path $UserHome '.claude'
New-Item -ItemType Directory -Force -Path $claudeDir | Out-Null

function Backup-IfExists {
  param([string]$Path)
  if (Test-Path -LiteralPath $Path) {
    $stamp = Get-Date -Format 'yyyyMMddTHHmmss'
    Copy-Item -LiteralPath $Path -Destination "$Path.bak-$stamp" -Force
  }
}

$statuslineSource = Join-Path $RepoRoot 'bin\statusline-account.mjs'
$statuslineTarget = Join-Path $claudeDir 'statusline-account.mjs'
Backup-IfExists $statuslineTarget
Copy-Item -LiteralPath $statuslineSource -Destination $statuslineTarget -Force

foreach ($name in @('cc-a.bat', 'cc-b.bat', 'cc-save.bat', 'start-claude-account.ps1', 'sync-claude-account-vault.ps1', 'update-claude-account-identity.ps1')) {
  $source = Join-Path $RepoRoot "bin\$name"
  $target = Join-Path $UserHome $name
  Backup-IfExists $target
  Copy-Item -LiteralPath $source -Destination $target -Force
}

Write-Host "Installed statusline-account.mjs and cc account switchers to $UserHome"
