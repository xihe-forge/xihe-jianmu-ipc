$shells = @{
    'PS5' = Test-Path "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
    'PS7' = (Test-Path "$env:ProgramFiles\PowerShell\7\pwsh.exe") -or (Test-Path "$env:ProgramFiles\PowerShell\7-preview\pwsh.exe")
}

$profilesToInstall = @()
if ($shells['PS5']) {
    $profilesToInstall += "$env:USERPROFILE\Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1"
}
if ($shells['PS7']) {
    $profilesToInstall += "$env:USERPROFILE\Documents\PowerShell\Microsoft.PowerShell_profile.ps1"
}

if ($profilesToInstall.Count -eq 0) {
    Write-Error "No PowerShell installed. Install PowerShell 5 or 7+: https://aka.ms/powershell"
    exit 1
}

# Claude Code 2.x+ 改成 native binary 分发，不再有 cli.js 可 patch
# 对话框跳过改为：
#   - Claude Code 2.1.119 起旧 dev-channels 入口会再弹 warning，用 --dangerously-load-development-channels server:ipc 是官方推荐替代
#   - trust 对话框：通过 ~/.claude/settings.json 配置 hasTrustDialogAccepted=true 永久信任
# 原 patch-channels.mjs 保留作 LEGACY，不再调用

$funcCode = @"
function ipc {
    param([Parameter(Mandatory)][string]`$Name)
    `$env:IPC_NAME = `$Name
    claude --dangerously-skip-permissions --dangerously-load-development-channels server:ipc
}
"@

$ipcxFuncCode = @"
function ipcx {
    param([Parameter(Mandatory)][string]`$Name)
    codex --dangerously-bypass-approvals-and-sandbox -c "mcp_servers.jianmu-ipc.env.IPC_NAME=``"`$Name``""
}
"@

foreach ($p in $profilesToInstall) {
    $dir = Split-Path $p -Parent
    if (!(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    if (!(Test-Path $p)) { New-Item -Path $p -Force | Out-Null }

    if (!(Select-String -Path $p -Pattern '^function ipc\s*\{' -Quiet -ErrorAction SilentlyContinue)) {
        Add-Content -Path $p -Value "`n$funcCode"
    }
    if (!(Select-String -Path $p -Pattern '^function ipcx' -Quiet -ErrorAction SilentlyContinue)) {
        Add-Content -Path $p -Value "`n$ipcxFuncCode"
    }
}

Write-Output "Installed to: $($profilesToInstall -join ', ')"
Write-Output "Detected: PS5=$($shells['PS5']) PS7=$($shells['PS7'])"
