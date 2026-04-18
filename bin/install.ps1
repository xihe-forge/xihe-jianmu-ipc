$profileDir = Split-Path $PROFILE -Parent
if (!(Test-Path $profileDir)) { New-Item -ItemType Directory -Path $profileDir -Force | Out-Null }
if (!(Test-Path $PROFILE)) { New-Item -Path $PROFILE -Force | Out-Null }

# Claude Code 2.x+ 改成 native binary 分发，不再有 cli.js 可 patch
# 对话框跳过改为：
#   - dev channels 警告：Claude Code 2.x+ 已默认不再弹出（--dangerously-load-development-channels 认可后跳过）
#   - trust 对话框：通过 ~/.claude/settings.json 配置 hasTrustDialogAccepted=true 永久信任
# 原 patch-channels.mjs 保留作 LEGACY，不再调用

$funcCode = @"
function ipc {
    param([Parameter(Mandatory)][string]`$Name)
    `$env:IPC_NAME = `$Name
    claude --dangerously-skip-permissions --dangerously-load-development-channels server:ipc
}
"@

if (!(Select-String -Path $PROFILE -Pattern 'function ipc' -Quiet -ErrorAction SilentlyContinue)) {
    Add-Content -Path $PROFILE -Value "`n$funcCode"
    Write-Host "Done! Restart PowerShell, then use: ipc main / ipc test2"
} else {
    Write-Host "ipc function already in profile, no changes made."
}
