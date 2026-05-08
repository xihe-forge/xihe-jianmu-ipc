param(
    [Parameter(Mandatory)][string]$ShellName,
    [Parameter()][string]$ShellExe = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ShellExe)) {
    if ($ShellName -eq 'PS5') {
        $ShellExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    } else {
        $pwsh = Get-Command pwsh.exe -ErrorAction SilentlyContinue
        if ($null -ne $pwsh) {
            $ShellExe = $pwsh.Source
        } else {
            $ShellExe = Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'
        }
    }
}

if (-not (Test-Path -Path $ShellExe -PathType Leaf)) {
    Write-Output "$ShellName`tmissing-shell`tFAIL`t$ShellExe not found"
    exit 1
}

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$tempRoot = Join-Path $env:TEMP ("ipc-pick-dogfood-" + [guid]::NewGuid().ToString('n'))
$installUserProfile = Join-Path $tempRoot 'install-user'
$appData = Join-Path $tempRoot 'AppData\Roaming'

function New-TestHome {
    param([Parameter(Mandatory)][string]$Name)

    $userProfile = Join-Path $tempRoot "homes\$Name\user"
    $codexHome = Join-Path $tempRoot "homes\$Name\codex"
    New-Item -ItemType Directory -Path $userProfile, $codexHome -Force | Out-Null
    [pscustomobject]@{
        UserProfile = $userProfile
        CodexHome = $codexHome
    }
}

function ConvertTo-HubJson {
    param([Parameter()][object[]]$Rows = @())

    return (ConvertTo-Json -InputObject @($Rows) -Compress -Depth 8)
}

function Add-ClaudeJsonl {
    param(
        [Parameter(Mandatory)][string]$UserProfile,
        [Parameter(Mandatory)][string]$SessionId,
        [Parameter(Mandatory)][string]$Name,
        [Parameter()][int]$MinutesAgo = 0
    )

    $jsonlDir = Join-Path (Join-Path $UserProfile '.claude\projects') 'D--workspace-ai-research-xiheAi'
    New-Item -ItemType Directory -Path $jsonlDir -Force | Out-Null
    $path = Join-Path $jsonlDir "$SessionId.jsonl"
    Set-Content -Path $path -Encoding UTF8 -Value "{`"type`":`"system`",`"stderr`":`"[session-state-writer] throttle skip for ipc_name=$Name\r\n`"}"
    (Get-Item -LiteralPath $path).LastWriteTime = (Get-Date).AddMinutes(-1 * $MinutesAgo)
    return $path
}

function Add-CodexJsonl {
    param(
        [Parameter(Mandatory)][string]$CodexHome,
        [Parameter(Mandatory)][string]$SessionId,
        [Parameter()][string]$Name = '',
        [Parameter()][switch]$Archived,
        [Parameter()][int]$MinutesAgo = 0
    )

    if ($Archived) {
        $dir = Join-Path $CodexHome 'archived_sessions'
        $path = Join-Path $dir "rollout-2026-05-08T10-00-00-$SessionId.jsonl"
    } else {
        $dir = Join-Path $CodexHome 'sessions\2026\05\08'
        $path = Join-Path $dir "rollout-2026-05-08T10-00-00-$SessionId.jsonl"
    }

    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $meta = @{
        type = 'session_meta'
        payload = @{
            id = $SessionId
            cwd = 'D:\workspace\ai\research\xiheAi'
            timestamp = '2026-05-08T10:00:00Z'
            source = 'cli'
            originator = 'codex-tui'
        }
    } | ConvertTo-Json -Compress -Depth 8

    $lines = @($meta)
    if (-not [string]::IsNullOrWhiteSpace($Name)) {
        $lines += "mcp_servers.jianmu-ipc.env.IPC_NAME=`"$Name`""
    }

    Set-Content -Path $path -Encoding UTF8 -Value $lines
    (Get-Item -LiteralPath $path).LastWriteTime = (Get-Date).AddMinutes(-1 * $MinutesAgo)
    return $path
}

function Invoke-IpcPickCase {
    param(
        [Parameter(Mandatory)][string]$UserProfile,
        [Parameter(Mandatory)][string]$CodexHome,
        [Parameter(Mandatory)][string]$HubJson,
        [Parameter()][string[]]$Inputs = @(''),
        [Parameter()][switch]$ViaIpcSwitch
    )

    $invokeLine = if ($ViaIpcSwitch) { 'ipc -pick' } else { 'ipc-pick' }

    $escapedHubJson = $HubJson -replace "'", "''"
    $quotedInputs = @($Inputs | ForEach-Object { "'" + ($_ -replace "'", "''") + "'" })
    if ($quotedInputs.Count -eq 0) {
        $inputArray = '@()'
    } else {
        $inputArray = '@(' + ($quotedInputs -join ',') + ')'
    }

    $quotedProfilePath = "'" + ($script:profilePath -replace "'", "''") + "'"
    $command = @"
function Invoke-WebRequest {
    param([string]`$Uri, [int]`$TimeoutSec, [switch]`$UseBasicParsing)
    if (`$Uri -ne 'http://127.0.0.1:3179/sessions-history?limit=50') {
        throw "unexpected hub uri: `$Uri"
    }
    if (`$TimeoutSec -ne 2) {
        throw "unexpected timeout: `$TimeoutSec"
    }
    [pscustomobject]@{ Content = '$escapedHubJson' }
}
`$script:IpcPickInputs = $inputArray
function Read-Host {
    param([string]`$Prompt)
    if (`$script:IpcPickInputs.Count -eq 0) { return '' }
    `$value = [string]`$script:IpcPickInputs[0]
    if (`$script:IpcPickInputs.Count -gt 1) {
        `$script:IpcPickInputs = @(`$script:IpcPickInputs[1..(`$script:IpcPickInputs.Count - 1)])
    } else {
        `$script:IpcPickInputs = @()
    }
    return `$value
}
`$env:IPC_PICK_DRYRUN = '1'
. $quotedProfilePath
$invokeLine
"@

    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $env:APPDATA = $script:appData
    $env:USERPROFILE = $UserProfile
    $env:CODEX_HOME = $CodexHome
    $output = & $script:ShellExe -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded 2>&1 | Out-String
    return $output
}

function Normalize-Output {
    param([Parameter()][string]$Text = '')

    return (($Text -replace "`e\[[0-9;]*m", '') -replace '\s+', ' ').Trim()
}

function Count-Needle {
    param(
        [Parameter(Mandatory)][string]$Text,
        [Parameter(Mandatory)][string]$Needle
    )

    return ([regex]::Matches($Text, [regex]::Escape($Needle))).Count
}

function Write-CaseResult {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][bool]$Passed,
        [Parameter()][string]$Output = ''
    )

    if (-not $Passed) {
        $script:failed = $true
    }
    $status = if ($Passed) { 'PASS' } else { 'FAIL' }
    $singleLineOutput = (Normalize-Output -Text $Output)
    Write-Output "$ShellName`t$Name`t$status`t$singleLineOutput"
}

New-Item -ItemType Directory -Path $installUserProfile, $appData -Force | Out-Null

try {
    $env:APPDATA = $appData
    $env:USERPROFILE = $installUserProfile
    $env:CODEX_HOME = Join-Path $tempRoot 'install-codex'

    & $ShellExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'bin\install.ps1') | Out-Null

    if ($ShellName -eq 'PS5') {
        $script:profilePath = Join-Path $installUserProfile 'Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1'
    } else {
        $script:profilePath = Join-Path $installUserProfile 'Documents\PowerShell\Microsoft.PowerShell_profile.ps1'
    }

    $emptyHome = New-TestHome -Name 'empty'
    $orphanHome = New-TestHome -Name 'orphan'
    $dedupHome = New-TestHome -Name 'dedup'

    $orphanId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    Add-CodexJsonl -CodexHome $orphanHome.CodexHome -SessionId $orphanId | Out-Null

    $dedupId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    Add-ClaudeJsonl -UserProfile $dedupHome.UserProfile -SessionId $dedupId -Name 'fs-dedup' | Out-Null

    $emptyJson = ConvertTo-HubJson
    $failed = $false

    $output = Invoke-IpcPickCase -UserProfile $emptyHome.UserProfile -CodexHome $emptyHome.CodexHome -HubJson $emptyJson
    Write-CaseResult -Name 'empty-everywhere' -Passed ((Normalize-Output $output) -match 'ipc-pick: no sessions found\.') -Output $output

    $hubClaudeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    $hubClaudeJson = ConvertTo-HubJson -Rows @(@{ name = 'hub-claude'; runtime = 'claude'; sessionId = $hubClaudeId; cwd = 'D:\workspace\ai\research\xiheAi'; lastSeenAt = 1778200000000 })
    $output = Invoke-IpcPickCase -UserProfile $emptyHome.UserProfile -CodexHome $emptyHome.CodexHome -HubJson $hubClaudeJson -Inputs @('1')
    Write-CaseResult -Name 'hub-claude-dispatch' -Passed ((Normalize-Output $output) -match [regex]::Escape("DISPATCH: ipc hub-claude -resume $hubClaudeId")) -Output $output

    $hubCodexId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    $hubCodexJson = ConvertTo-HubJson -Rows @(@{ name = 'codex-known'; runtime = 'codex'; sessionId = $hubCodexId; cwd = 'D:\workspace\ai\research\xiheAi'; lastSeenAt = 1778200000000 })
    $output = Invoke-IpcPickCase -UserProfile $emptyHome.UserProfile -CodexHome $emptyHome.CodexHome -HubJson $hubCodexJson -Inputs @('1')
    Write-CaseResult -Name 'hub-codex-ipcx-dispatch' -Passed ((Normalize-Output $output) -match [regex]::Escape("DISPATCH: ipcx codex-known -resume $hubCodexId")) -Output $output

    $output = Invoke-IpcPickCase -UserProfile $orphanHome.UserProfile -CodexHome $orphanHome.CodexHome -HubJson $emptyJson -Inputs @('1')
    $normalized = Normalize-Output $output
    $orphanPass = ($normalized -match [regex]::Escape("DISPATCH: codex resume $orphanId --dangerously-bypass-approvals-and-sandbox")) -and ($normalized -match 'model_reasoning_effort')
    Write-CaseResult -Name 'orphan-codex-direct-dispatch' -Passed $orphanPass -Output $output

    $dedupJson = ConvertTo-HubJson -Rows @(@{ name = 'hub-dedup'; runtime = 'claude'; sessionId = $dedupId; cwd = 'D:\workspace\ai\research\xiheAi'; lastSeenAt = 1778200000000 })
    $output = Invoke-IpcPickCase -UserProfile $dedupHome.UserProfile -CodexHome $dedupHome.CodexHome -HubJson $dedupJson -Inputs @('q')
    Write-CaseResult -Name 'merged-dedup-renders-once' -Passed ((Count-Needle -Text $output -Needle 'dddddddd') -eq 1) -Output $output

    $sortJson = ConvertTo-HubJson -Rows @(
        @{ name = 'older'; runtime = 'claude'; sessionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'; cwd = 'D:\workspace\ai\research\xiheAi'; lastSeenAt = 1778200000000 },
        @{ name = 'newer'; runtime = 'claude'; sessionId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'; cwd = 'D:\workspace\ai\research\xiheAi'; lastSeenAt = 1778203600000 }
    )
    $output = Invoke-IpcPickCase -UserProfile $emptyHome.UserProfile -CodexHome $emptyHome.CodexHome -HubJson $sortJson -Inputs @('q')
    $newerIndex = $output.IndexOf('newer')
    $olderIndex = $output.IndexOf('older')
    Write-CaseResult -Name 'sort-most-recent-first' -Passed (($newerIndex -ge 0) -and ($olderIndex -gt $newerIndex)) -Output $output

    $output = Invoke-IpcPickCase -UserProfile $emptyHome.UserProfile -CodexHome $emptyHome.CodexHome -HubJson $hubClaudeJson -Inputs @('q')
    $qPass = ((Normalize-Output $output) -match 'ipc-pick: aborted\.') -and ((Normalize-Output $output) -notmatch 'DISPATCH:')
    Write-CaseResult -Name 'q-aborts' -Passed $qPass -Output $output

    $output = Invoke-IpcPickCase -UserProfile $emptyHome.UserProfile -CodexHome $emptyHome.CodexHome -HubJson $hubClaudeJson -Inputs @('99', '1')
    $retryNormalized = Normalize-Output $output
    $retryPass = ($retryNormalized -match 'ipc-pick: invalid selection') -and ($retryNormalized -match [regex]::Escape("DISPATCH: ipc hub-claude -resume $hubClaudeId"))
    Write-CaseResult -Name 'out-of-range-reprompts' -Passed $retryPass -Output $output

    $output = Invoke-IpcPickCase -UserProfile $emptyHome.UserProfile -CodexHome $emptyHome.CodexHome -HubJson $hubClaudeJson -Inputs @('1') -ViaIpcSwitch
    Write-CaseResult -Name 'ipc-switch-pick-equivalent' -Passed ((Normalize-Output $output) -match [regex]::Escape("DISPATCH: ipc hub-claude -resume $hubClaudeId")) -Output $output

    if ($failed) {
        exit 1
    }
} finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
