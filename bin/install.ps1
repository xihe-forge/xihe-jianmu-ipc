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

    `$node = 'D:\software\ide\nodejs\node.exe'
    `$helper = 'D:\workspace\ai\research\xiheAi\xihe-jianmu-ipc\bin\claude-stdin-auto-accept.mjs'
    `$claudeBin = "`$env:APPDATA\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe"
    `$projectRoot = 'D:\workspace\ai\research\xiheAi'

    Push-Location `$projectRoot
    try {
        & `$node `$helper `$claudeBin --dangerously-skip-permissions --dangerously-load-development-channels server:ipc
    } finally {
        Pop-Location
    }
}
"@

$ipcxFuncCode = @"
function ipcx {
    param([Parameter(Mandatory)][string]`$Name)
    codex --dangerously-bypass-approvals-and-sandbox -c "mcp_servers.jianmu-ipc.env.IPC_NAME=``"`$Name``""
}
"@

function Install-VSCodeTerminalTabTitle {
    if ([string]::IsNullOrWhiteSpace($env:APPDATA)) {
        Write-Host "APPDATA not set, skip VSCode settings.json patch"
        return
    }

    $vscodeSettingsPath = Join-Path $env:APPDATA "Code\User\settings.json"

    if (-not (Test-Path -Path $vscodeSettingsPath -PathType Leaf)) {
        Write-Host "VSCode settings.json not found at $vscodeSettingsPath, skip"
        return
    }

    try {
        $bytes = [System.IO.File]::ReadAllBytes($vscodeSettingsPath)
    } catch {
        Write-Warning "Could not read VSCode settings.json at $vscodeSettingsPath, skip: $($_.Exception.Message)"
        return
    }

    $hasUtf8Bom = ($bytes.Length -ge 3) -and ($bytes[0] -eq 0xEF) -and ($bytes[1] -eq 0xBB) -and ($bytes[2] -eq 0xBF)
    $offset = 0
    if ($hasUtf8Bom) {
        $offset = 3
    }

    try {
        $utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList $false, $true
        $content = $utf8NoBom.GetString($bytes, $offset, ($bytes.Length - $offset))
    } catch {
        Write-Warning "Could not read VSCode settings.json as UTF-8 at $vscodeSettingsPath, skip: $($_.Exception.Message)"
        return
    }

    try {
        $settings = $content | ConvertFrom-Json -ErrorAction Stop
    } catch {
        Write-Warning "Could not parse VSCode settings.json at $vscodeSettingsPath, skip: $($_.Exception.Message)"
        return
    }

    if (($null -eq $settings) -or (-not ($settings -is [System.Management.Automation.PSCustomObject]))) {
        Write-Warning "Could not parse VSCode settings.json at $vscodeSettingsPath, skip: expected a JSON object"
        return
    }

    $titleKey = 'terminal.integrated.tabs.title'
    $descKey = 'terminal.integrated.tabs.description'
    $propertyNames = $settings.PSObject.Properties.Name
    $changed = $false

    if (-not ($propertyNames -contains $titleKey)) {
        $settings | Add-Member -MemberType NoteProperty -Name $titleKey -Value '${sequence}'
        $changed = $true
    }

    if (-not ($propertyNames -contains $descKey)) {
        $settings | Add-Member -MemberType NoteProperty -Name $descKey -Value '${sequence}'
        $changed = $true
    }

    if (-not $changed) {
        Write-Host "VSCode settings.json already has tabs.title + tabs.description, skip"
        return
    }

    try {
        $newContent = $settings | ConvertTo-Json -Depth 10
        $newBytes = $utf8NoBom.GetBytes($newContent)
        if ($hasUtf8Bom) {
            $newBytes = [byte[]]([byte[]](0xEF, 0xBB, 0xBF) + $newBytes)
        }
        [System.IO.File]::WriteAllBytes($vscodeSettingsPath, $newBytes)
    } catch {
        Write-Warning "Could not write VSCode settings.json at $vscodeSettingsPath, skip: $($_.Exception.Message)"
        return
    }

    Write-Host 'VSCode settings.json patched: tabs.title + tabs.description = ${sequence}'
}

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

Install-VSCodeTerminalTabTitle

Write-Output "Installed to: $($profilesToInstall -join ', ')"
Write-Output "Detected: PS5=$($shells['PS5']) PS7=$($shells['PS7'])"
