param(
    [Parameter(Mandatory)][string]$ShellName,
    [Parameter(Mandatory)][string]$ShellExe
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$tempRoot = Join-Path $env:TEMP ("ipc-resume-dogfood-" + [guid]::NewGuid().ToString('n'))
$appData = Join-Path $tempRoot 'AppData\Roaming'
$userProfile = Join-Path $tempRoot 'Users\test-user'

New-Item -ItemType Directory -Path $appData, $userProfile -Force | Out-Null

try {
    $env:APPDATA = $appData
    $env:USERPROFILE = $userProfile

    & $ShellExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'bin\install.ps1') | Out-Null

    if ($ShellName -eq 'PS5') {
        $profilePath = Join-Path $userProfile 'Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1'
    } else {
        $profilePath = Join-Path $userProfile 'Documents\PowerShell\Microsoft.PowerShell_profile.ps1'
    }

    $profileContent = Get-Content -Path $profilePath -Raw
    $profileContent = $profileContent -replace '& \$node \$helper \$claudeBin @claudeArgs', 'Write-Output ("CLAUDE_ARGS=" + ($claudeArgs -join "|"))'
    Set-Content -Path $profilePath -Value $profileContent -Encoding UTF8

    $jsonlDir = Join-Path (Join-Path $userProfile '.claude\projects') 'D--workspace-ai-research-xiheAi'
    New-Item -ItemType Directory -Path $jsonlDir -Force | Out-Null

    $directorOldId = '11111111-1111-1111-1111-111111111111'
    $directorNewId = '22222222-2222-2222-2222-222222222222'
    $directorOnlineId = '7ef7424e-0000-0000-0000-000000000000'
    $testerNewId = '33333333-3333-3333-3333-333333333333'
    $unrelatedId = '44444444-4444-4444-4444-444444444444'

    $directorOldPath = Join-Path $jsonlDir "$directorOldId.jsonl"
    $directorNewPath = Join-Path $jsonlDir "$directorNewId.jsonl"
    $testerNewPath = Join-Path $jsonlDir "$testerNewId.jsonl"
    $unrelatedPath = Join-Path $jsonlDir "$unrelatedId.jsonl"

    Set-Content -Path $directorOldPath -Encoding UTF8 -Value '{"type":"system","stderr":"[session-state-writer] throttle skip for ipc_name=taiwei-director\r\n"}'
    Set-Content -Path $directorNewPath -Encoding UTF8 -Value '{"type":"system","stderr":"[session-state-writer] throttle skip for ipc_name=taiwei-director\r\n"}'
    Set-Content -Path $testerNewPath -Encoding UTF8 -Value '{"type":"system","stderr":"[session-state-writer] throttle skip for ipc_name=taiwei-tester\r\n"}'
    Set-Content -Path $unrelatedPath -Encoding UTF8 -Value '{"type":"system","stderr":"[session-state-writer] throttle skip for ipc_name=other-name\r\n"}'

    (Get-Item $directorOldPath).LastWriteTime = (Get-Date).AddMinutes(-30)
    (Get-Item $directorNewPath).LastWriteTime = (Get-Date).AddMinutes(-20)
    (Get-Item $testerNewPath).LastWriteTime = Get-Date
    (Get-Item $unrelatedPath).LastWriteTime = (Get-Date).AddMinutes(5)

    $ErrorActionPreference = 'Continue'
    $quotedProfilePath = "'" + ($profilePath -replace "'", "''") + "'"
    $hubOnline = @"
function Invoke-WebRequest {
    param([string]`$Uri, [int]`$TimeoutSec, [switch]`$UseBasicParsing)
    Write-Output "HUB_TIMEOUT=`$TimeoutSec"
    if (`$Uri -like '*sessions-history*') {
        return [pscustomobject]@{ Content = '[]' }
    }
    [pscustomobject]@{ Content = '[{"name":"taiwei-director","sessionId":"$directorOnlineId","transcriptPath":"D:/tmp/current-director.jsonl"},{"name":"taiwei-tester","sessionId":"99999999-9999-9999-9999-999999999999","transcriptPath":null}]' }
}
"@
    $hubEmpty = @"
function Invoke-WebRequest {
    param([string]`$Uri, [int]`$TimeoutSec, [switch]`$UseBasicParsing)
    Write-Output "HUB_TIMEOUT=`$TimeoutSec"
    [pscustomobject]@{ Content = '[]' }
}
"@
    $hubOffline = @"
function Invoke-WebRequest {
    param([string]`$Uri, [int]`$TimeoutSec, [switch]`$UseBasicParsing)
    Write-Output "HUB_TIMEOUT=`$TimeoutSec"
    throw 'hub offline'
}
"@
    $cases = @(
        @{ Name = 'fresh'; Command = "$hubOnline`n. $quotedProfilePath; ipc taiwei-director"; Expect = "--effort|max|--dangerously-skip-permissions"; ExtraReject = '--resume' },
        @{ Name = 'role-only-harness'; Command = "$hubOnline`n. $quotedProfilePath; ipc -Role harness"; Expect = "--effort|max|--dangerously-skip-permissions"; ExtraReject = '--resume' },
        @{ Name = 'role-designer-high'; Command = "$hubOnline`n. $quotedProfilePath; ipc dogfood-designer -Role designer"; Expect = "--effort|high|--dangerously-skip-permissions"; ExtraReject = '--resume' },
        @{ Name = 'hub-latest'; Command = "$hubOnline`n. $quotedProfilePath; ipc taiwei-director -resume"; Expect = "--resume|$directorOnlineId" },
        @{ Name = 'hub-head1-marker-latest'; Command = "$hubOnline`n. $quotedProfilePath; ipc taiwei-director -resume 1"; Expect = "--resume|$directorNewId" },
        @{ Name = 'offline-fallback-latest'; Command = "$hubOffline`n. $quotedProfilePath; ipc taiwei-director -resume 0"; Expect = "--resume|$directorNewId" },
        @{ Name = 'offline-fallback-head1'; Command = "$hubOffline`n. $quotedProfilePath; ipc taiwei-director -resume 1"; Expect = "--resume|$directorOldId" },
        @{ Name = 'empty-fallback-tester'; Command = "$hubEmpty`n. $quotedProfilePath; ipc taiwei-tester -resume 0"; Expect = "--resume|$testerNewId" },
        @{ Name = 'guid'; Command = "$hubOnline`n. $quotedProfilePath; ipc taiwei-director -resume $testerNewId"; Expect = "--resume|$testerNewId"; ExtraReject = 'HUB_TIMEOUT=' },
        @{ Name = 'missing-name'; Command = "$hubEmpty`n. $quotedProfilePath; ipc missing-name -resume 0"; Expect = 'has no historical session' }
    )

    $failed = $false
    foreach ($case in $cases) {
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($case.Command))
        $env:APPDATA = $appData
        $env:USERPROFILE = $userProfile
        $output = & $ShellExe -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded 2>&1 | Out-String
        $normalizedOutput = ($output -replace "`e\[[0-9;]*m", '') -replace '\s+', ' '

        $pass = $false
        $pass = $normalizedOutput -match [regex]::Escape($case.Expect)
        if ($pass -and $case.ContainsKey('ExtraExpect')) {
            $pass = $normalizedOutput -match [regex]::Escape($case.ExtraExpect)
        }
        if ($pass -and $case.ContainsKey('ExtraReject')) {
            $pass = $normalizedOutput -notmatch [regex]::Escape($case.ExtraReject)
        }

        if (-not $pass) {
            $failed = $true
        }

        $status = if ($pass) { 'PASS' } else { 'FAIL' }
        $singleLineOutput = $output.Trim() -replace "`r?`n", ' '
        Write-Output "$ShellName`t$($case.Name)`t$status`t$singleLineOutput"
    }

    if ($failed) {
        exit 1
    }
} finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
