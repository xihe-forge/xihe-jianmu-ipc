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
    param(
        [Parameter(Mandatory)][string]`$Name,
        [Parameter()][switch]`$resume,
        [Parameter(ValueFromRemainingArguments=`$true)][object[]]`$rest
    )
    `$env:IPC_NAME = `$Name

    `$node = 'D:\software\ide\nodejs\node.exe'
    `$helper = 'D:\workspace\ai\research\xiheAi\xihe-jianmu-ipc\bin\claude-stdin-auto-accept.mjs'
    `$claudeBin = "`$env:APPDATA\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe"
    `$projectRoot = 'D:\workspace\ai\research\xiheAi'
    `$claudeArgs = @()

    if (`$rest.Count -gt 1) {
        Write-Error "Unexpected arguments: `$(`$rest -join ' ')"
        return
    }

    if (`$resume) {
        `$resumeValue = '0'
        if (`$rest.Count -eq 1) {
            `$resumeValue = [string]`$rest[0]
        }

        if (`$resumeValue -match '^-\d+`$') {
            Write-Error "-resume `$resumeValue is not supported. Use -resume 0 for latest, -resume 1 for HEAD~1."
            return
        }

        if (`$resumeValue -match '^\d+`$') {
            `$index = [int]`$resumeValue
            `$onlineSessionId = Get-OnlineSessionId -Name `$Name
            `$historySessions = @(Get-IpcSessionsByNameFromHub -Name `$Name -Limit 10)
            if ((`$index -eq 0) -and (-not ([string]::IsNullOrWhiteSpace(`$onlineSessionId)))) {
                `$claudeArgs += @('--resume', `$onlineSessionId)
            } elseif (`$historySessions.Count -gt 0) {
                `$historyIndex = `$index
                if (-not ([string]::IsNullOrWhiteSpace(`$onlineSessionId))) {
                    `$historyIndex = `$index - 1
                }

                if ((`$historyIndex -lt 0) -or (`$historyIndex -ge `$historySessions.Count)) {
                    Write-Error "-resume `$resumeValue is out of range for IPC name '`$Name'. Found `$(`$historySessions.Count) sessions_history row(s). Use 0 for latest, 1 for HEAD~1."
                    return
                }

                `$sessionId = [string]`$historySessions[`$historyIndex].sessionId
                if ([string]::IsNullOrWhiteSpace(`$sessionId)) {
                    Write-Error "sessions_history row for IPC name '`$Name' has empty sessionId."
                    return
                }
                `$claudeArgs += @('--resume', `$sessionId)
            } else {
                `$encodedCwd = ((`$projectRoot -replace ':', '-') -replace '[/\\]', '-') -replace '\s', '-'
                `$jsonlDir = Join-Path (Join-Path `$env:USERPROFILE '.claude\projects') `$encodedCwd

                if (-not (Test-Path -Path `$jsonlDir -PathType Container)) {
                    Write-Error "Claude project history directory not found: `$jsonlDir"
                    return
                }

                `$jsonlFiles = @(Get-IpcSessionJsonls -Name `$Name -JsonlDir `$jsonlDir)
                `$jsonlIndex = `$index
                if (-not ([string]::IsNullOrWhiteSpace(`$onlineSessionId))) {
                    `$jsonlIndex = `$index - 1
                }

                if (`$jsonlFiles.Count -eq 0) {
                    Write-Error "IPC name '`$Name' has no historical session in `$jsonlDir. Use fresh: ipc `$Name"
                    return
                }

                if ((`$jsonlIndex -lt 0) -or (`$jsonlIndex -ge `$jsonlFiles.Count)) {
                    Write-Error "-resume `$resumeValue is out of range for IPC name '`$Name'. Found `$(`$jsonlFiles.Count) matching jsonl session(s) in `$jsonlDir. Use 0 for latest, 1 for HEAD~1."
                    return
                }

                `$sessionId = `$jsonlFiles[`$jsonlIndex].BaseName
                `$claudeArgs += @('--resume', `$sessionId)
            }
        } else {
            if (`$resumeValue -match '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`$') {
                `$claudeArgs += @('--resume', `$resumeValue)
            } else {
                Write-Error "-resume must be 0, a positive HEAD~N index, or a session UUID. Negative indexes like -1 are not supported; use 0 for latest."
                return
            }
        }
    } else {
        if (`$rest.Count -gt 0) {
            Write-Error "Unexpected arguments: `$(`$rest -join ' ')"
            return
        }
    }
    `$claudeArgs += @('--dangerously-skip-permissions', '--dangerously-load-development-channels', 'server:ipc')

    Push-Location `$projectRoot
    try {
        & `$node `$helper `$claudeBin @claudeArgs
    } finally {
        Pop-Location
    }
}

function Get-IpcSessionJsonls {
    param(
        [Parameter(Mandatory)][string]`$Name,
        [Parameter(Mandatory)][string]`$JsonlDir
    )

    # Marker must include the stderr JSON boundary to avoid transcript text false positives.
    # Real hook stderr: ,"stderr":"[session-state-writer] throttle skip for ipc_name=<name>\r\n"
    # False-positive sample has escaped quotes: \",\"stderr\":\"[session-state-writer]...
    `$markers = @(
        ",``"stderr``":``"[session-state-writer] throttle skip for ipc_name=`$Name\r\n``"",
        ",``"stderr``":``"[session-state-writer] throttle skip for IPC_NAME=`$Name\r\n``"",
        "``"ipc_name``":``"`$Name``"",
        "``"ipcName``":``"`$Name``"",
        "``"IPC_NAME``":``"`$Name``""
    )

    `$rg = Get-Command rg -ErrorAction SilentlyContinue
    if (`$null -ne `$rg) {
        `$rgArgs = @('--files-with-matches', '--fixed-strings', '--glob', '*.jsonl')
        foreach (`$marker in `$markers) {
            `$rgArgs += @('-e', `$marker)
        }
        `$rgArgs += @('--', `$JsonlDir)

        `$paths = @(& `$rg.Source @rgArgs 2>`$null)
        `$rgMatches = @(
            `$paths |
                Where-Object { -not [string]::IsNullOrWhiteSpace(`$_) } |
                Sort-Object -Unique |
                ForEach-Object { Get-Item -LiteralPath `$_ -ErrorAction SilentlyContinue } |
                Where-Object { `$null -ne `$_ } |
                Sort-Object LastWriteTime -Descending
        )
        if (`$rgMatches.Count -gt 0) {
            return @(`$rgMatches)
        }
    }

    `$matches = @()
    foreach (`$jsonl in (Get-ChildItem -Path `$JsonlDir -Filter '*.jsonl' -File | Sort-Object LastWriteTime -Descending)) {
        # The marker is written periodically and can appear anywhere in the transcript.
        # Full-file ReadAllBytes + UTF8 + Contains keeps the fallback fast.
        try {
            `$bytes = [System.IO.File]::ReadAllBytes(`$jsonl.FullName)
            `$text = [System.Text.Encoding]::UTF8.GetString(`$bytes)
            foreach (`$marker in `$markers) {
                if (`$text.Contains(`$marker)) {
                    `$matches += `$jsonl
                    break
                }
            }
        } catch {}
    }

    return @(`$matches)
}

function Get-OnlineSessionId {
    param([Parameter(Mandatory)][string]`$Name)

    try {
        `$response = Invoke-WebRequest -Uri 'http://127.0.0.1:3179/sessions' -TimeoutSec 2 -UseBasicParsing
        `$sessions = `$response.Content | ConvertFrom-Json
        foreach (`$session in @(`$sessions)) {
            if ((`$session.name -eq `$Name) -and
                (-not ([string]::IsNullOrWhiteSpace([string]`$session.transcriptPath))) -and
                (-not ([string]::IsNullOrWhiteSpace([string]`$session.sessionId)))) {
                return [string]`$session.sessionId
            }
        }
    } catch {}

    return `$null
}

function Get-IpcSessionsByNameFromHub {
    param(
        [Parameter(Mandatory)][string]`$Name,
        [Parameter()][int]`$Limit = 10
    )

    try {
        `$encodedName = [System.Uri]::EscapeDataString(`$Name)
        `$response = Invoke-WebRequest -Uri "http://127.0.0.1:3179/sessions-history?name=`$encodedName&limit=`$Limit" -TimeoutSec 2 -UseBasicParsing
        `$rows = `$response.Content | ConvertFrom-Json
        return @(`$rows | Where-Object {
            (`$_.name -eq `$Name) -and (-not ([string]::IsNullOrWhiteSpace([string]`$_.sessionId)))
        })
    } catch {}

    return @()
}
"@

$ipcxFuncCode = @"
function ipcx {
    param([Parameter(Mandatory)][string]`$Name)
    `$env:IPC_NAME = `$Name
    `$env:IPC_RUNTIME = 'codex'

    `$node = 'D:\software\ide\nodejs\node.exe'
    `$wrapper = 'D:\workspace\ai\research\xiheAi\xihe-jianmu-ipc\bin\codex-title-wrapper.mjs'
    `$codexBin = "`$env:APPDATA\npm\codex.cmd"
    `$projectRoot = 'D:\workspace\ai\research\xiheAi'

    Push-Location `$projectRoot
    try {
        & `$node `$wrapper `$codexBin --dangerously-bypass-approvals-and-sandbox -c "model_reasoning_effort=``"xhigh``"" -c "mcp_servers.jianmu-ipc.env.IPC_NAME=``"`$Name``"" -c "mcp_servers.jianmu-ipc.env.IPC_RUNTIME=``"codex``""
    } finally {
        Pop-Location
    }
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

function Remove-IpcProfileBlocks {
    param([Parameter(Mandatory)][string]$Content)

    $lines = $Content -split "`r?`n"
    $output = New-Object System.Collections.Generic.List[string]
    $skip = $false
    $depth = 0
    foreach ($line in $lines) {
        if (-not $skip -and $line -match '^function (ipc|Get-IpcSessionJsonls|Get-OnlineSessionId|Get-IpcSessionsByNameFromHub)\s*\{') {
            $skip = $true
            $depth = 0
        }

        if ($skip) {
            $depth += ([regex]::Matches($line, '\{')).Count
            $depth -= ([regex]::Matches($line, '\}')).Count
            if ($depth -le 0) {
                $skip = $false
                $depth = 0
            }
            continue
        }

        $output.Add($line)
    }

    return ($output -join [Environment]::NewLine).TrimEnd()
}

function Remove-IpcxProfileBlocks {
    param([string]$Content)

    if ([string]::IsNullOrEmpty($Content)) { return "" }

    $lines = $Content -split "`r?`n"
    $output = New-Object System.Collections.Generic.List[string]
    $skip = $false
    $depth = 0
    foreach ($line in $lines) {
        if (-not $skip -and $line -match '^function ipcx\s*\{') {
            $skip = $true
            $depth = 0
        }

        if ($skip) {
            $depth += ([regex]::Matches($line, '\{')).Count
            $depth -= ([regex]::Matches($line, '\}')).Count
            if ($depth -le 0) {
                $skip = $false
                $depth = 0
            }
            continue
        }

        $output.Add($line)
    }

    return ($output -join [Environment]::NewLine).TrimEnd()
}

foreach ($p in $profilesToInstall) {
    $dir = Split-Path $p -Parent
    if (!(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    if (!(Test-Path $p)) { New-Item -Path $p -Force | Out-Null }

    $ipcMatches = @(Select-String -Path $p -Pattern '^function ipc\s*\{' -ErrorAction SilentlyContinue)
    $hasIpc = $ipcMatches.Count -gt 0
    $needsIpcUpgrade = $hasIpc -and (
        ($ipcMatches.Count -gt 1) -or
        !(Select-String -Path $p -Pattern 'ValueFromRemainingArguments' -Quiet -ErrorAction SilentlyContinue) -or
        !(Select-String -Path $p -Pattern 'Get-IpcSessionsByNameFromHub' -Quiet -ErrorAction SilentlyContinue)
    )

    if ($needsIpcUpgrade) {
        $cleanedProfile = Remove-IpcProfileBlocks -Content (Get-Content -Path $p -Raw -ErrorAction SilentlyContinue)
        Set-Content -Path $p -Value $cleanedProfile -Encoding UTF8
        Add-Content -Path $p -Value "`n$funcCode"
    } elseif (!($hasIpc)) {
        Add-Content -Path $p -Value "`n$funcCode"
    }
    $hasIpcx = Select-String -Path $p -Pattern '^function ipcx' -Quiet -ErrorAction SilentlyContinue
    $needsIpcxUpgrade = $hasIpcx -and !(
        Select-String -Path $p -Pattern 'model_reasoning_effort' -Quiet -ErrorAction SilentlyContinue
    )
    if ($needsIpcxUpgrade) {
        $cleanedProfile = Remove-IpcxProfileBlocks -Content (Get-Content -Path $p -Raw -ErrorAction SilentlyContinue)
        Set-Content -Path $p -Value $cleanedProfile -Encoding UTF8
        Add-Content -Path $p -Value "`n$ipcxFuncCode"
    } elseif (!($hasIpcx)) {
        Add-Content -Path $p -Value "`n$ipcxFuncCode"
    }
}

Install-VSCodeTerminalTabTitle

Write-Output "Installed to: $($profilesToInstall -join ', ')"
Write-Output "Detected: PS5=$($shells['PS5']) PS7=$($shells['PS7'])"
