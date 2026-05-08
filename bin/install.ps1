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
        [Parameter(Position=0)][string]`$Name,
        [Parameter()][string]`$Role,
        [Parameter()][switch]`$resume,
        [Parameter()][switch]`$pick,
        [Parameter()][ValidateSet('high', 'max', 'list', 'show', 'clear')][string]`$effort,
        [Parameter()][switch]`$save,
        [Parameter(ValueFromRemainingArguments=`$true)][object[]]`$rest
    )

    if (`$pick) {
        ipc-pick
        return
    }

    if (`$effort -in @('list', 'show', 'clear')) {
        ipc-effort `$effort
        return
    }

    if ([string]::IsNullOrWhiteSpace(`$Name)) {
        if ([string]::IsNullOrWhiteSpace(`$Role)) {
            Write-Error "Name is required. Use: ipc <name> [-Role <role>] or ipc -Role <role>."
            return
        }
        `$Name = `$Role
    }
    if ([string]::IsNullOrWhiteSpace(`$Role)) {
        `$Role = `$Name
    }

    `$roleKey = `$Role.Trim().ToLowerInvariant()
    `$governanceEffortRoles = [System.Collections.Generic.List[string]]::new()
    foreach (`$role in @('harness', 'jianmu-pm', 'taiwei-pm', 'taiwei-architect', 'taiwei-director')) {
        [void]`$governanceEffortRoles.Add(`$role)
    }

    `$effortConfigPath = Join-Path `$env:USERPROFILE '.claude\jianmu-ipc-effort-max.json'
    if (Test-Path -Path `$effortConfigPath -PathType Leaf) {
        try {
            `$effortConfig = Get-Content -LiteralPath `$effortConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if (`$effortConfig.add) {
                foreach (`$addRole in @(`$effortConfig.add)) {
                    `$normalized = ([string]`$addRole).Trim().ToLowerInvariant()
                    if (`$normalized -and -not `$governanceEffortRoles.Contains(`$normalized)) {
                        [void]`$governanceEffortRoles.Add(`$normalized)
                    }
                }
            }
            if (`$effortConfig.remove) {
                foreach (`$removeRole in @(`$effortConfig.remove)) {
                    `$normalized = ([string]`$removeRole).Trim().ToLowerInvariant()
                    if (`$normalized) {
                        [void]`$governanceEffortRoles.Remove(`$normalized)
                    }
                }
            }
        } catch {
            Write-Warning "ignored bad ${effortConfigPath}: `$(`$_.Exception.Message)"
        }
    }

    if (`$effort) {
        `$effortLevel = `$effort
    } elseif (`$governanceEffortRoles.Contains(`$roleKey)) {
        `$effortLevel = 'max'
    } else {
        `$effortLevel = 'high'
    }

    if (`$save) {
        if (-not `$effort) {
            Write-Warning "-save ignored: -effort <high|max> required to persist."
        } else {
            Update-IpcEffortConfig -Name `$roleKey -Effort `$effort
        }
    }

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
    `$claudeArgs += @('--effort', `$effortLevel)
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

function Get-IpcEffortConfigPath {
    return (Join-Path `$env:USERPROFILE '.claude\jianmu-ipc-effort-max.json')
}

function Update-IpcEffortConfig {
    param(
        [Parameter(Mandatory)][string]`$Name,
        [Parameter(Mandatory)][ValidateSet('high', 'max')][string]`$Effort
    )

    `$normalized = `$Name.Trim().ToLowerInvariant()
    if (-not `$normalized) {
        Write-Error "ipc-effort: name is required."
        return
    }

    `$configPath = Get-IpcEffortConfigPath
    `$add = @()
    `$remove = @()
    if (Test-Path -Path `$configPath -PathType Leaf) {
        try {
            `$existing = Get-Content -LiteralPath `$configPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if (`$existing.add) {
                `$add = @(`$existing.add | ForEach-Object { ([string]`$_).Trim().ToLowerInvariant() } | Where-Object { `$_ })
            }
            if (`$existing.remove) {
                `$remove = @(`$existing.remove | ForEach-Object { ([string]`$_).Trim().ToLowerInvariant() } | Where-Object { `$_ })
            }
        } catch {
            Write-Warning "ipc-effort: ignored unparsable `$configPath; rewriting fresh."
        }
    }

    if (`$Effort -eq 'max') {
        `$remove = @(`$remove | Where-Object { `$_ -ne `$normalized })
        if (`$add -notcontains `$normalized) { `$add += `$normalized }
    } else {
        `$add = @(`$add | Where-Object { `$_ -ne `$normalized })
        if (`$remove -notcontains `$normalized) { `$remove += `$normalized }
    }

    `$dir = Split-Path -Parent `$configPath
    if (-not (Test-Path -Path `$dir -PathType Container)) {
        New-Item -ItemType Directory -Path `$dir -Force | Out-Null
    }
    `$payload = [pscustomobject]@{ add = `$add; remove = `$remove }
    `$payload | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath `$configPath -Encoding UTF8
    Write-Host "ipc-effort: '`$normalized' -> `$Effort (saved to `$configPath)"
}

function ipc-effort {
    param(
        [Parameter(Position=0)][ValidateSet('add', 'remove', 'list', 'show', 'clear')][string]`$Action,
        [Parameter(Position=1)][string]`$Name
    )

    `$configPath = Get-IpcEffortConfigPath

    switch (`$Action) {
        'add' {
            if ([string]::IsNullOrWhiteSpace(`$Name)) {
                Write-Error "usage: ipc-effort add <name>"
                return
            }
            Update-IpcEffortConfig -Name `$Name -Effort 'max'
        }
        'remove' {
            if ([string]::IsNullOrWhiteSpace(`$Name)) {
                Write-Error "usage: ipc-effort remove <name>"
                return
            }
            Update-IpcEffortConfig -Name `$Name -Effort 'high'
        }
        'show' {
            if (Test-Path -Path `$configPath -PathType Leaf) {
                Get-Content -LiteralPath `$configPath -Raw
            } else {
                Write-Output "(no config at `$configPath)"
            }
        }
        'list' {
            `$effective = [System.Collections.Generic.List[string]]::new()
            foreach (`$role in @('harness', 'jianmu-pm', 'taiwei-pm', 'taiwei-architect', 'taiwei-director')) {
                [void]`$effective.Add(`$role)
            }
            if (Test-Path -Path `$configPath -PathType Leaf) {
                try {
                    `$cfg = Get-Content -LiteralPath `$configPath -Raw -Encoding UTF8 | ConvertFrom-Json
                    foreach (`$r in @(`$cfg.add)) {
                        `$n = ([string]`$r).Trim().ToLowerInvariant()
                        if (`$n -and -not `$effective.Contains(`$n)) { [void]`$effective.Add(`$n) }
                    }
                    foreach (`$r in @(`$cfg.remove)) {
                        `$n = ([string]`$r).Trim().ToLowerInvariant()
                        if (`$n) { [void]`$effective.Remove(`$n) }
                    }
                } catch {
                    Write-Warning "ipc-effort: ignored unparsable `$configPath."
                }
            }
            Write-Output "effective effort=max names:"
            (`$effective | Sort-Object -Unique) | ForEach-Object { Write-Output "  `$_" }
        }
        'clear' {
            if (Test-Path -Path `$configPath -PathType Leaf) {
                Remove-Item -LiteralPath `$configPath -Force
                Write-Host "ipc-effort: config cleared (`$configPath)"
            } else {
                Write-Host "ipc-effort: (already empty)"
            }
        }
        default {
            Write-Output "usage:"
            Write-Output "  ipc-effort add <name>     # promote <name> to effort=max"
            Write-Output "  ipc-effort remove <name>  # demote <name> to effort=high"
            Write-Output "  ipc-effort list           # effective effort=max names (default + add - remove)"
            Write-Output "  ipc-effort show           # raw JSON config"
            Write-Output "  ipc-effort clear          # delete config"
        }
    }
}
"@

$ipcxFuncCode = @"
function ipcx {
    param(
        [Parameter(Mandatory)][string]`$Name,
        [Parameter()][switch]`$resume,
        [Parameter(ValueFromRemainingArguments=`$true)][object[]]`$rest
    )
    `$env:IPC_NAME = `$Name
    `$env:IPC_RUNTIME = 'codex'

    `$node = 'D:\software\ide\nodejs\node.exe'
    `$wrapper = 'D:\workspace\ai\research\xiheAi\xihe-jianmu-ipc\bin\codex-title-wrapper.mjs'
    `$codexBin = "`$env:APPDATA\npm\codex.cmd"
    `$projectRoot = 'D:\workspace\ai\research\xiheAi'
    `$codexOptions = @(
        '--dangerously-bypass-approvals-and-sandbox',
        '-c', 'model_reasoning_effort="xhigh"',
        '-c', ('mcp_servers.jianmu-ipc.env.IPC_NAME="' + `$Name + '"'),
        '-c', 'mcp_servers.jianmu-ipc.env.IPC_RUNTIME="codex"',
        '-c', 'mcp_servers.jianmu-ipc.startup_timeout_sec=30'
    )
    `$codexArgs = @()

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
            `$mergedRows = @(Merge-IpcxSessionRows -Name `$Name)
            if (`$mergedRows.Count -eq 0) {
                `$sessionsRoot = Get-CodexSessionsRoot
                Write-Error "Codex IPC name '`$Name' has no historical session (hub + `$sessionsRoot both empty). Use fresh: ipcx `$Name"
                return
            }
            if ((`$index -lt 0) -or (`$index -ge `$mergedRows.Count)) {
                Write-Error "-resume `$resumeValue is out of range for Codex IPC name '`$Name'. Found `$(`$mergedRows.Count) merged codex session(s) (hub + ipcx-session-map). Use 0 for latest, 1 for HEAD~1."
                return
            }
            `$sessionId = [string]`$mergedRows[`$index].SessionId
            if ([string]::IsNullOrWhiteSpace(`$sessionId)) {
                Write-Error "Codex merged row for IPC name '`$Name' has empty sessionId."
                return
            }
            `$codexArgs += @('resume', `$sessionId)
        } else {
            if (`$resumeValue -match '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`$') {
                `$codexArgs += @('resume', `$resumeValue)
            } else {
                Write-Error "-resume must be 0, a positive HEAD~N index, or a Codex session UUID. Negative indexes like -1 are not supported; use 0 for latest."
                return
            }
        }
    } else {
        if (`$rest.Count -gt 0) {
            Write-Error "Unexpected arguments: `$(`$rest -join ' ')"
            return
        }
    }

    `$codexArgs += `$codexOptions

    Push-Location `$projectRoot
    try {
        & `$node `$wrapper `$codexBin @codexArgs
    } finally {
        Pop-Location
    }
}

function Get-CodexHome {
    if (-not [string]::IsNullOrWhiteSpace(`$env:CODEX_HOME)) {
        return `$env:CODEX_HOME
    }
    if (-not [string]::IsNullOrWhiteSpace(`$env:USERPROFILE)) {
        return (Join-Path `$env:USERPROFILE '.codex')
    }
    if (-not [string]::IsNullOrWhiteSpace(`$env:HOME)) {
        return (Join-Path `$env:HOME '.codex')
    }
    return (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex')
}

function Get-CodexSessionsRoot {
    return (Join-Path (Get-CodexHome) 'sessions')
}

function Get-IpcxSessionMapDir {
    return (Join-Path (Get-CodexHome) 'ipcx-session-map')
}

function Get-CodexSessionIdFromPath {
    param([Parameter(Mandatory)][string]`$Path)

    `$baseName = [System.IO.Path]::GetFileNameWithoutExtension(`$Path)
    if (`$baseName -match '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})`$') {
        return `$matches[1]
    }
    return `$baseName
}

function New-IpcxSessionRow {
    param(
        [Parameter(Mandatory)][string]`$SessionId,
        [Parameter(Mandatory)][string]`$TranscriptPath,
        [Parameter()][long]`$LastSeenAt = 0
    )

    `$item = `$null
    if (-not [string]::IsNullOrWhiteSpace(`$TranscriptPath)) {
        `$item = Get-Item -LiteralPath `$TranscriptPath -ErrorAction SilentlyContinue
    }

    [pscustomobject]@{
        SessionId = `$SessionId
        FullName = `$TranscriptPath
        LastSeenAt = `$LastSeenAt
        LastWriteTime = if (`$null -ne `$item) { `$item.LastWriteTime } else { [datetime]::MinValue }
    }
}

function Get-IpcxSessionMapRows {
    param([Parameter(Mandatory)][string]`$Name)

    `$mapDir = Get-IpcxSessionMapDir
    if (-not (Test-Path -Path `$mapDir -PathType Container)) {
        return @()
    }

    `$safeName = `$Name -replace '[^A-Za-z0-9_.-]', '_'
    `$candidateFiles = @()
    `$specific = Join-Path `$mapDir "`${safeName}.jsonl"
    if (Test-Path -Path `$specific -PathType Leaf) {
        `$candidateFiles += (Get-Item -LiteralPath `$specific)
    }
    `$candidateFiles += @(Get-ChildItem -Path `$mapDir -Filter '*.jsonl' -File -ErrorAction SilentlyContinue)

    `$rows = @()
    foreach (`$file in (`$candidateFiles | Sort-Object FullName -Unique)) {
        foreach (`$line in (Get-Content -LiteralPath `$file.FullName -ErrorAction SilentlyContinue)) {
            if ([string]::IsNullOrWhiteSpace(`$line)) { continue }
            try {
                `$record = `$line | ConvertFrom-Json
                if (([string]`$record.name -ne `$Name) -or ([string]`$record.runtime -ne 'codex')) { continue }
                `$sessionId = [string]`$record.sessionId
                if ([string]::IsNullOrWhiteSpace(`$sessionId)) { continue }
                `$transcriptPath = [string]`$record.transcriptPath
                `$lastSeenAt = 0L
                try { `$lastSeenAt = [long]`$record.lastSeenAt } catch {}
                `$rows += (New-IpcxSessionRow -SessionId `$sessionId -TranscriptPath `$transcriptPath -LastSeenAt `$lastSeenAt)
            } catch {}
        }
    }

    return @(
        `$rows |
            Sort-Object SessionId -Unique |
            Sort-Object LastSeenAt, LastWriteTime -Descending
    )
}

function Get-IpcxSessionJsonls {
    param([Parameter(Mandatory)][string]`$Name)

    `$mappedRows = @(Get-IpcxSessionMapRows -Name `$Name)
    if (`$mappedRows.Count -gt 0) {
        return @(`$mappedRows)
    }

    `$sessionsRoot = Get-CodexSessionsRoot
    if (-not (Test-Path -Path `$sessionsRoot -PathType Container)) {
        return @()
    }

    `$markers = @(
        'mcp_servers.jianmu-ipc.env.IPC_NAME="' + `$Name + '"',
        'mcp_servers.jianmu-ipc.env.IPC_NAME=\"' + `$Name + '\"',
        'IPC_NAME="' + `$Name + '"',
        'IPC_NAME=\"' + `$Name + '\"',
        '"ipc_name":"' + `$Name + '"',
        '"IPC_NAME":"' + `$Name + '"'
    )

    `$paths = @()
    `$rg = Get-Command rg -ErrorAction SilentlyContinue
    if (`$null -ne `$rg) {
        `$rgArgs = @('--files-with-matches', '--fixed-strings', '--glob', '*.jsonl')
        foreach (`$marker in `$markers) {
            `$rgArgs += @('-e', `$marker)
        }
        `$rgArgs += @('--', `$sessionsRoot)
        `$paths = @(& `$rg.Source @rgArgs 2>`$null)
    }

    if (`$paths.Count -eq 0) {
        foreach (`$jsonl in (Get-ChildItem -Path `$sessionsRoot -Recurse -Filter '*.jsonl' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)) {
            try {
                `$bytes = [System.IO.File]::ReadAllBytes(`$jsonl.FullName)
                `$text = [System.Text.Encoding]::UTF8.GetString(`$bytes)
                foreach (`$marker in `$markers) {
                    if (`$text.Contains(`$marker)) {
                        `$paths += `$jsonl.FullName
                        break
                    }
                }
            } catch {}
        }
    }

    return @(
        `$paths |
            Where-Object { -not [string]::IsNullOrWhiteSpace(`$_) } |
            Sort-Object -Unique |
            ForEach-Object {
                `$item = Get-Item -LiteralPath `$_ -ErrorAction SilentlyContinue
                if (`$null -ne `$item) {
                    New-IpcxSessionRow -SessionId (Get-CodexSessionIdFromPath -Path `$item.FullName) -TranscriptPath `$item.FullName
                }
            } |
            Where-Object { `$null -ne `$_ } |
            Sort-Object LastWriteTime -Descending
    )
}

function Get-IpcxSessionsByNameFromHub {
    param(
        [Parameter(Mandatory)][string]`$Name,
        [Parameter()][int]`$Limit = 10
    )

    try {
        `$encodedName = [System.Uri]::EscapeDataString(`$Name)
        `$response = Invoke-WebRequest -Uri "http://127.0.0.1:3179/sessions-history?name=`$encodedName&limit=`$Limit" -TimeoutSec 2 -UseBasicParsing
        `$rows = `$response.Content | ConvertFrom-Json
        return @(`$rows | Where-Object {
            (`$_.name -eq `$Name) -and
            (`$_.runtime -eq 'codex') -and
            (-not ([string]::IsNullOrWhiteSpace([string]`$_.sessionId)))
        })
    } catch {}

    return @()
}

function Merge-IpcxSessionRows {
    param([Parameter(Mandatory)][string]`$Name)

    `$dict = @{}

    foreach (`$row in @(Get-IpcxSessionsByNameFromHub -Name `$Name -Limit 10)) {
        `$sid = [string]`$row.sessionId
        if ([string]::IsNullOrWhiteSpace(`$sid)) { continue }
        `$lastSeen = 0L
        try { `$lastSeen = [long]`$row.lastSeenAt } catch {}
        `$spawnAt = 0L
        try { `$spawnAt = [long]`$row.spawnAt } catch {}
        `$dict[`$sid] = [pscustomobject]@{
            SessionId = `$sid
            LastSeenAt = `$lastSeen
            SpawnAt = `$spawnAt
            Source = 'hub'
        }
    }

    foreach (`$row in @(Get-IpcxSessionMapRows -Name `$Name)) {
        `$sid = [string]`$row.SessionId
        if ([string]::IsNullOrWhiteSpace(`$sid)) { continue }
        `$rowLastSeen = 0L
        try { `$rowLastSeen = [long]`$row.LastSeenAt } catch {}
        if (`$dict.ContainsKey(`$sid)) {
            if (`$rowLastSeen -gt `$dict[`$sid].LastSeenAt) {
                `$dict[`$sid].LastSeenAt = `$rowLastSeen
            }
        } else {
            `$dict[`$sid] = [pscustomobject]@{
                SessionId = `$sid
                LastSeenAt = `$rowLastSeen
                SpawnAt = `$rowLastSeen
                Source = 'map'
            }
        }
    }

    return @(`$dict.Values | Sort-Object -Property LastSeenAt -Descending)
}
"@

$ipcPickFuncCode = @'
function ipc-pick {
    param()

    $rows = @(Get-IpcPickRows)
    if ($rows.Count -eq 0) {
        Write-Output "ipc-pick: no sessions found."
        return
    }

    $limit = 30
    $parsedLimit = 0
    if ((-not [string]::IsNullOrWhiteSpace($env:IPC_PICK_LIMIT)) -and [int]::TryParse($env:IPC_PICK_LIMIT, [ref]$parsedLimit) -and ($parsedLimit -gt 0)) {
        $limit = $parsedLimit
    }

    $visibleRows = @($rows | Select-Object -First $limit)
    Write-Output ("{0,3} {1,-7} {2,-18} {3,-19} {4,-24} {5}" -f '#', 'runtime', 'ipc-name', 'last-seen', 'cwd-tail', 'sessionId-prefix')
    for ($i = 0; $i -lt $visibleRows.Count; $i++) {
        $row = $visibleRows[$i]
        Write-Output ("{0,3} {1,-7} {2,-18} {3,-19} {4,-24} {5}" -f `
            ($i + 1),
            (Limit-IpcPickText -Text $row.Runtime -Length 7),
            (Limit-IpcPickText -Text $row.Name -Length 18),
            (Format-IpcPickLastSeen -Millis $row.SortTime),
            (Limit-IpcPickText -Text (Get-IpcPickCwdTail -Cwd $row.Cwd) -Length 24),
            (Get-IpcPickSessionPrefix -SessionId $row.SessionId))
    }

    while ($true) {
        $choice = Read-Host "Select session # (q to abort)"
        if ([string]::IsNullOrWhiteSpace($choice) -or ($choice.Trim().ToLowerInvariant() -eq 'q')) {
            Write-Output "ipc-pick: aborted."
            return
        }

        $selectedNumber = 0
        if ((-not [int]::TryParse($choice.Trim(), [ref]$selectedNumber)) -or ($selectedNumber -lt 1) -or ($selectedNumber -gt $visibleRows.Count)) {
            Write-Output "ipc-pick: invalid selection. Enter 1-$($visibleRows.Count), q to abort."
            continue
        }

        Invoke-IpcPickSelection -Row $visibleRows[$selectedNumber - 1]
        return
    }
}

function Invoke-IpcPickSelection {
    param([Parameter(Mandatory)]$Row)

    $runtime = ([string]$Row.Runtime).Trim().ToLowerInvariant()
    $name = ([string]$Row.Name).Trim()
    $sessionId = ([string]$Row.SessionId).Trim()

    if ([string]::IsNullOrWhiteSpace($sessionId)) {
        Write-Error "Selected row has empty sessionId."
        return
    }

    if ($runtime -eq 'codex') {
        if ([string]::IsNullOrWhiteSpace($name)) {
            $command = "codex resume $sessionId --dangerously-bypass-approvals-and-sandbox -c `"model_reasoning_effort=\`"xhigh\`"`""
            Write-Output "DISPATCH: $command"
            if ($env:IPC_PICK_DRYRUN -eq '1') { return }
            & codex resume $sessionId --dangerously-bypass-approvals-and-sandbox -c 'model_reasoning_effort="xhigh"'
            return
        }

        $command = "ipcx $name -resume $sessionId"
        Write-Output "DISPATCH: $command"
        if ($env:IPC_PICK_DRYRUN -eq '1') { return }
        & ipcx $name -resume $sessionId
        return
    }

    if (($runtime -eq 'claude') -or ($runtime -eq 'unknown')) {
        if ([string]::IsNullOrWhiteSpace($name)) {
            Write-Error "Selected Claude session has no IPC name marker; cannot resume with ipc."
            return
        }

        $command = "ipc $name -resume $sessionId"
        Write-Output "DISPATCH: $command"
        if ($env:IPC_PICK_DRYRUN -eq '1') { return }
        & ipc $name -resume $sessionId
        return
    }

    Write-Error "Unsupported runtime '$runtime' for session $sessionId."
}

function Get-IpcPickRows {
    $bySessionId = @{}
    foreach ($row in @(@(Get-IpcPickClaudeJsonls) + @(Get-IpcPickCodexJsonls))) {
        if ($null -eq $row) { continue }
        $sessionId = ([string]$row.SessionId).Trim()
        if ([string]::IsNullOrWhiteSpace($sessionId)) { continue }

        if (-not $bySessionId.ContainsKey($sessionId)) {
            $bySessionId[$sessionId] = $row
            continue
        }

        $existing = $bySessionId[$sessionId]
        if (([long]$row.SortTime) -gt ([long]$existing.SortTime)) {
            $bySessionId[$sessionId] = $row
        }
    }

    foreach ($row in @(Get-IpcPickHubRows)) {
        if ($null -eq $row) { continue }
        $sessionId = ([string]$row.SessionId).Trim()
        if ([string]::IsNullOrWhiteSpace($sessionId)) { continue }
        $bySessionId[$sessionId] = $row
    }

    return @($bySessionId.Values | Sort-Object SortTime -Descending)
}

function Get-IpcPickHubRows {
    try {
        $response = Invoke-WebRequest -Uri 'http://127.0.0.1:3179/sessions-history?limit=50' -UseBasicParsing -TimeoutSec 2
        $rows = $response.Content | ConvertFrom-Json
        $out = @()
        foreach ($row in $rows) {
            $sessionId = ([string]$row.sessionId).Trim()
            if ([string]::IsNullOrWhiteSpace($sessionId)) { continue }

            $runtime = ([string]$row.runtime).Trim().ToLowerInvariant()
            if ([string]::IsNullOrWhiteSpace($runtime)) { $runtime = 'unknown' }
            if (@('claude', 'codex', 'unknown') -notcontains $runtime) { continue }

            $lastSeenAt = ConvertTo-IpcPickEpochMillis -Value $row.lastSeenAt
            if ($lastSeenAt -le 0) {
                $lastSeenAt = ConvertTo-IpcPickEpochMillis -Value $row.spawnAt
            }

            $transcriptPath = [string]$row.transcriptPath
            $lastWriteTime = [datetime]::MinValue
            if (-not [string]::IsNullOrWhiteSpace($transcriptPath)) {
                $item = Get-Item -LiteralPath $transcriptPath -ErrorAction SilentlyContinue
                if ($null -ne $item) { $lastWriteTime = $item.LastWriteTime }
            }

            $out += (New-IpcPickRow `
                -Runtime $runtime `
                -Name ([string]$row.name) `
                -SessionId $sessionId `
                -Cwd ([string]$row.cwd) `
                -LastSeenAt $lastSeenAt `
                -LastWriteTime $lastWriteTime `
                -TranscriptPath $transcriptPath `
                -Source 'hub')
        }
        return @($out)
    } catch {}

    return @()
}

function Get-IpcPickClaudeJsonls {
    $userProfile = Get-IpcPickUserProfile
    if ([string]::IsNullOrWhiteSpace($userProfile)) { return @() }

    $projectRoot = Get-IpcPickProjectRoot
    $encodedCwd = Get-IpcPickEncodedProjectCwd -Cwd $projectRoot
    $jsonlDir = Join-Path (Join-Path $userProfile '.claude\projects') $encodedCwd
    if (-not (Test-Path -Path $jsonlDir -PathType Container)) { return @() }

    $out = @()
    foreach ($jsonl in (Get-ChildItem -Path $jsonlDir -Filter '*.jsonl' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)) {
        $sessionId = [System.IO.Path]::GetFileNameWithoutExtension($jsonl.FullName)
        if ([string]::IsNullOrWhiteSpace($sessionId)) { continue }

        $text = Get-IpcPickFileText -Path $jsonl.FullName
        $name = Get-IpcPickIpcNameFromText -Text $text
        $out += (New-IpcPickRow `
            -Runtime 'claude' `
            -Name $name `
            -SessionId $sessionId `
            -Cwd $projectRoot `
            -LastWriteTime $jsonl.LastWriteTime `
            -TranscriptPath $jsonl.FullName `
            -Source 'claude-jsonl')
    }

    return @($out)
}

function Get-IpcPickCodexJsonls {
    $codexHome = Get-IpcPickCodexHome
    if ([string]::IsNullOrWhiteSpace($codexHome)) { return @() }

    $files = @()
    $sessionsRoot = Join-Path $codexHome 'sessions'
    if (Test-Path -Path $sessionsRoot -PathType Container) {
        $files += @(Get-ChildItem -Path $sessionsRoot -Recurse -Filter '*.jsonl' -File -ErrorAction SilentlyContinue)
    }

    $archiveRoot = Join-Path $codexHome 'archived_sessions'
    if (Test-Path -Path $archiveRoot -PathType Container) {
        $files += @(Get-ChildItem -Path $archiveRoot -Filter '*.jsonl' -File -ErrorAction SilentlyContinue)
    }

    $seenPaths = @{}
    $out = @()
    foreach ($jsonl in ($files | Sort-Object LastWriteTime -Descending)) {
        $fullName = [string]$jsonl.FullName
        if ([string]::IsNullOrWhiteSpace($fullName)) { continue }
        $pathKey = $fullName.ToLowerInvariant()
        if ($seenPaths.ContainsKey($pathKey)) { continue }
        $seenPaths[$pathKey] = $true

        $meta = Get-IpcPickCodexSessionMeta -Path $fullName
        if ($null -eq $meta) { continue }

        $lastSeenAt = ConvertTo-IpcPickEpochMillis -Value $meta.Timestamp
        $text = Get-IpcPickFileText -Path $fullName
        $name = Get-IpcPickIpcNameFromText -Text $text
        $out += (New-IpcPickRow `
            -Runtime 'codex' `
            -Name $name `
            -SessionId ([string]$meta.SessionId) `
            -Cwd ([string]$meta.Cwd) `
            -LastSeenAt $lastSeenAt `
            -LastWriteTime $jsonl.LastWriteTime `
            -TranscriptPath $fullName `
            -Source 'codex-jsonl')
    }

    return @($out)
}

function Get-IpcPickCodexSessionMeta {
    param([Parameter(Mandatory)][string]$Path)

    $reader = $null
    try {
        $reader = [System.IO.File]::OpenText($Path)
        $line = $reader.ReadLine()
        if ([string]::IsNullOrWhiteSpace($line)) { return $null }
        $event = $line | ConvertFrom-Json
        if ([string]$event.type -ne 'session_meta') { return $null }
        $payload = $event.payload
        if ($null -eq $payload) { return $null }
        $sessionId = ([string]$payload.id).Trim()
        if ([string]::IsNullOrWhiteSpace($sessionId)) { return $null }

        $timestamp = [string]$payload.timestamp
        if ([string]::IsNullOrWhiteSpace($timestamp)) {
            $timestamp = [string]$event.timestamp
        }

        [pscustomobject]@{
            SessionId = $sessionId
            Cwd = [string]$payload.cwd
            Timestamp = $timestamp
        }
    } catch {
        return $null
    } finally {
        if ($null -ne $reader) { $reader.Dispose() }
    }
}

function New-IpcPickRow {
    param(
        [Parameter(Mandatory)][string]$Runtime,
        [Parameter()][string]$Name = '',
        [Parameter(Mandatory)][string]$SessionId,
        [Parameter()][string]$Cwd = '',
        [Parameter()][long]$LastSeenAt = 0,
        [Parameter()][datetime]$LastWriteTime = ([datetime]::MinValue),
        [Parameter()][string]$TranscriptPath = '',
        [Parameter()][string]$Source = ''
    )

    $sortTime = $LastSeenAt
    if (($sortTime -le 0) -and ($LastWriteTime -gt [datetime]::MinValue)) {
        $sortTime = ConvertTo-IpcPickEpochMillis -Value $LastWriteTime
    }

    [pscustomobject]@{
        Runtime = $Runtime
        Name = $Name
        SessionId = $SessionId
        Cwd = $Cwd
        LastSeenAt = $LastSeenAt
        LastWriteTime = $LastWriteTime
        SortTime = $sortTime
        TranscriptPath = $TranscriptPath
        Source = $Source
    }
}

function Get-IpcPickUserProfile {
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        return $env:USERPROFILE
    }
    if (-not [string]::IsNullOrWhiteSpace($env:HOME)) {
        return $env:HOME
    }
    return [Environment]::GetFolderPath('UserProfile')
}

function Get-IpcPickCodexHome {
    if (-not [string]::IsNullOrWhiteSpace($env:CODEX_HOME)) {
        return $env:CODEX_HOME
    }
    $userProfile = Get-IpcPickUserProfile
    if ([string]::IsNullOrWhiteSpace($userProfile)) {
        return ''
    }
    return (Join-Path $userProfile '.codex')
}

function Get-IpcPickProjectRoot {
    return 'D:\workspace\ai\research\xiheAi'
}

function Get-IpcPickEncodedProjectCwd {
    param([Parameter(Mandatory)][string]$Cwd)

    return ((($Cwd -replace ':', '-') -replace '[/\\]', '-') -replace '\s', '-')
}

function Get-IpcPickFileText {
    param([Parameter(Mandatory)][string]$Path)

    try {
        $bytes = [System.IO.File]::ReadAllBytes($Path)
        return [System.Text.Encoding]::UTF8.GetString($bytes)
    } catch {
        return ''
    }
}

function Get-IpcPickIpcNameFromText {
    param([Parameter()][string]$Text)

    if ([string]::IsNullOrWhiteSpace($Text)) { return '' }

    if ($Text -match '\[session-state-writer\]\s+throttle skip for (?:ipc_name|IPC_NAME)=([^\\\r\n" ]+)') {
        return $matches[1]
    }
    if ($Text -match 'IPC_NAME=\\?"([^"\\]+)\\?"') {
        return $matches[1]
    }
    if ($Text -match '"IPC_NAME"\s*:\s*"([^"]+)"') {
        return $matches[1]
    }
    if ($Text -match '"ipc_name"\s*:\s*"([^"]+)"') {
        return $matches[1]
    }

    return ''
}

function Get-IpcPickEpoch {
    return [datetime]::SpecifyKind(([datetime]'1970-01-01T00:00:00'), [System.DateTimeKind]::Utc)
}

function ConvertTo-IpcPickEpochMillis {
    param($Value)

    if ($null -eq $Value) { return 0L }

    $epoch = Get-IpcPickEpoch
    if ($Value -is [datetime]) {
        return [long]((([datetime]$Value).ToUniversalTime() - $epoch).TotalMilliseconds)
    }

    $text = ([string]$Value).Trim()
    if ([string]::IsNullOrWhiteSpace($text)) { return 0L }

    $number = 0L
    if ([long]::TryParse($text, [ref]$number)) {
        if (($number -gt 0) -and ($number -lt 100000000000)) {
            return ($number * 1000L)
        }
        return $number
    }

    $date = [datetime]::MinValue
    if ([datetime]::TryParse($text, [ref]$date)) {
        return [long](($date.ToUniversalTime() - $epoch).TotalMilliseconds)
    }

    return 0L
}

function Format-IpcPickLastSeen {
    param([Parameter()][long]$Millis = 0)

    if ($Millis -le 0) { return '-' }
    try {
        return (Get-IpcPickEpoch).AddMilliseconds([double]$Millis).ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss')
    } catch {
        return '-'
    }
}

function Limit-IpcPickText {
    param(
        [Parameter()][string]$Text = '',
        [Parameter(Mandatory)][int]$Length
    )

    if ([string]::IsNullOrWhiteSpace($Text)) { $Text = '-' }
    if ($Text.Length -le $Length) { return $Text }
    if ($Length -le 1) { return $Text.Substring(0, $Length) }
    return ($Text.Substring(0, $Length - 1) + '~')
}

function Get-IpcPickCwdTail {
    param([Parameter()][string]$Cwd = '')

    if ([string]::IsNullOrWhiteSpace($Cwd)) { return '-' }
    $parts = @($Cwd -split '[\\/]' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($parts.Count -ge 2) {
        return (($parts[($parts.Count - 2)..($parts.Count - 1)]) -join '\')
    }
    if ($parts.Count -eq 1) {
        return $parts[0]
    }
    return $Cwd
}

function Get-IpcPickSessionPrefix {
    param([Parameter()][string]$SessionId = '')

    if ([string]::IsNullOrWhiteSpace($SessionId)) { return '-' }
    if ($SessionId.Length -le 8) { return $SessionId }
    return $SessionId.Substring(0, 8)
}
'@

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
        if (-not $skip -and $line -match '^function (ipc|ipc-effort|Get-IpcSessionJsonls|Get-OnlineSessionId|Get-IpcSessionsByNameFromHub|Get-IpcEffortConfigPath|Update-IpcEffortConfig)\s*\{') {
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
        if (-not $skip -and $line -match '^function (ipcx|Get-CodexHome|Get-CodexSessionsRoot|Get-IpcxSessionMapDir|Get-CodexSessionIdFromPath|New-IpcxSessionRow|Get-IpcxSessionMapRows|Get-IpcxSessionJsonls|Get-IpcxSessionsByNameFromHub)\s*\{') {
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

function Remove-IpcPickProfileBlocks {
    param([string]$Content)

    if ([string]::IsNullOrEmpty($Content)) { return "" }

    $lines = $Content -split "`r?`n"
    $output = New-Object System.Collections.Generic.List[string]
    $skip = $false
    $depth = 0
    foreach ($line in $lines) {
        if (-not $skip -and $line -match '^function (ipc-pick|Invoke-IpcPickSelection|Get-IpcPickRows|Get-IpcPickHubRows|Get-IpcPickClaudeJsonls|Get-IpcPickCodexJsonls|Get-IpcPickCodexSessionMeta|New-IpcPickRow|Get-IpcPickUserProfile|Get-IpcPickCodexHome|Get-IpcPickProjectRoot|Get-IpcPickEncodedProjectCwd|Get-IpcPickFileText|Get-IpcPickIpcNameFromText|Get-IpcPickEpoch|ConvertTo-IpcPickEpochMillis|Format-IpcPickLastSeen|Limit-IpcPickText|Get-IpcPickCwdTail|Get-IpcPickSessionPrefix)\s*\{') {
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
        !(Select-String -Path $p -Pattern 'Get-IpcSessionsByNameFromHub' -Quiet -ErrorAction SilentlyContinue) -or
        !(Select-String -Path $p -Pattern 'governanceEffortRoles' -Quiet -ErrorAction SilentlyContinue) -or
        !(Select-String -Path $p -Pattern '--effort' -Quiet -ErrorAction SilentlyContinue) -or
        !(Select-String -Path $p -Pattern 'function ipc-effort' -Quiet -ErrorAction SilentlyContinue) -or
        !(Select-String -Path $p -Pattern 'Update-IpcEffortConfig' -Quiet -ErrorAction SilentlyContinue)
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
        (Select-String -Path $p -Pattern 'model_reasoning_effort' -Quiet -ErrorAction SilentlyContinue) -and
        (Select-String -Path $p -Pattern 'Get-IpcxSessionsByNameFromHub' -Quiet -ErrorAction SilentlyContinue) -and
        (Select-String -Path $p -Pattern 'startup_timeout_sec' -Quiet -ErrorAction SilentlyContinue) -and
        (Select-String -Path $p -Pattern 'ValueFromRemainingArguments' -Quiet -ErrorAction SilentlyContinue)
    )
    if ($needsIpcxUpgrade) {
        $cleanedProfile = Remove-IpcxProfileBlocks -Content (Get-Content -Path $p -Raw -ErrorAction SilentlyContinue)
        Set-Content -Path $p -Value $cleanedProfile -Encoding UTF8
        Add-Content -Path $p -Value "`n$ipcxFuncCode"
    } elseif (!($hasIpcx)) {
        Add-Content -Path $p -Value "`n$ipcxFuncCode"
    }
    $ipcPickMatches = @(Select-String -Path $p -Pattern '^function ipc-pick\s*\{' -ErrorAction SilentlyContinue)
    $hasIpcPick = $ipcPickMatches.Count -gt 0
    $needsIpcPickUpgrade = $hasIpcPick -and (
        ($ipcPickMatches.Count -gt 1) -or
        !(Select-String -Path $p -Pattern 'Get-IpcPickHubRows' -Quiet -ErrorAction SilentlyContinue) -or
        !(Select-String -Path $p -Pattern 'Get-IpcPickClaudeJsonls' -Quiet -ErrorAction SilentlyContinue) -or
        !(Select-String -Path $p -Pattern 'Get-IpcPickCodexJsonls' -Quiet -ErrorAction SilentlyContinue) -or
        !(Select-String -Path $p -Pattern '\$rows = \$response\.Content \| ConvertFrom-Json' -Quiet -ErrorAction SilentlyContinue) -or
        !(Select-String -Path $p -Pattern 'archived_sessions' -Quiet -ErrorAction SilentlyContinue) -or
        !(Select-String -Path $p -Pattern 'IPC_PICK_DRYRUN' -Quiet -ErrorAction SilentlyContinue)
    )
    if ($needsIpcPickUpgrade) {
        $cleanedProfile = Remove-IpcPickProfileBlocks -Content (Get-Content -Path $p -Raw -ErrorAction SilentlyContinue)
        Set-Content -Path $p -Value $cleanedProfile -Encoding UTF8
        Add-Content -Path $p -Value "`n$ipcPickFuncCode"
    } elseif (!($hasIpcPick)) {
        Add-Content -Path $p -Value "`n$ipcPickFuncCode"
    }
}

Invoke-Expression $funcCode
Invoke-Expression $ipcxFuncCode
Invoke-Expression $ipcPickFuncCode

Install-VSCodeTerminalTabTitle

Write-Output "Installed to: $($profilesToInstall -join ', ')"
Write-Output "Detected: PS5=$($shells['PS5']) PS7=$($shells['PS7'])"
