$profileDir = Split-Path $PROFILE -Parent
if (!(Test-Path $profileDir)) { New-Item -ItemType Directory -Path $profileDir -Force | Out-Null }
if (!(Test-Path $PROFILE)) { New-Item -Path $PROFILE -Force | Out-Null }

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$patchPath = Join-Path $scriptDir "patch-channels.mjs"

$funcCode = @"
function ipc {
    param([Parameter(Mandatory)][string]`$Name)
    `$env:IPC_NAME = `$Name
    node "$patchPath"
    claude --dangerously-skip-permissions --dangerously-load-development-channels server:ipc
}
"@

if (!(Select-String -Path $PROFILE -Pattern 'function ipc' -Quiet -ErrorAction SilentlyContinue)) {
    Add-Content -Path $PROFILE -Value "`n$funcCode"
    Write-Host "Done! Restart PowerShell, then use: ipc main / ipc test2"
} else {
    Write-Host "ipc function already in profile, no changes made."
}
