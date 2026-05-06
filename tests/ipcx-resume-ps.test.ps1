param(
    [Parameter(Mandatory)][string]$ShellName,
    [Parameter(Mandatory)][string]$ShellExe
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$tempRoot = Join-Path $env:TEMP ("ipcx-resume-dogfood-" + [guid]::NewGuid().ToString('n'))
$appData = Join-Path $tempRoot 'AppData\Roaming'
$userProfile = Join-Path $tempRoot 'Users\test-user'
$codexHome = Join-Path $tempRoot '.codex'

New-Item -ItemType Directory -Path $appData, $userProfile, $codexHome -Force | Out-Null

try {
    $env:APPDATA = $appData
    $env:USERPROFILE = $userProfile
    $env:CODEX_HOME = $codexHome

    & $ShellExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'bin\install.ps1') | Out-Null

    if ($ShellName -eq 'PS5') {
        $profilePath = Join-Path $userProfile 'Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1'
    } else {
        $profilePath = Join-Path $userProfile 'Documents\PowerShell\Microsoft.PowerShell_profile.ps1'
    }

    $profileContent = Get-Content -Path $profilePath -Raw
    $profileContent = $profileContent -replace '& \$node \$wrapper \$codexBin @codexArgs', 'Write-Output ("CODEX_ARGS=" + ($codexArgs -join "|"))'
    Set-Content -Path $profilePath -Value $profileContent -Encoding UTF8

    $mapDir = Join-Path $codexHome 'ipcx-session-map'
    $sessionDir = Join-Path $codexHome 'sessions\2026\05\06'
    New-Item -ItemType Directory -Path $mapDir, $sessionDir -Force | Out-Null

    $oldId = '11111111-1111-4111-8111-111111111111'
    $newId = '22222222-2222-4222-8222-222222222222'
    $hubNewId = '33333333-3333-4333-8333-333333333333'
    $hubOldId = '44444444-4444-4444-8444-444444444444'
    $otherRuntimeId = '55555555-5555-4555-8555-555555555555'
    $guidId = '66666666-6666-4666-8666-666666666666'

    $oldPath = Join-Path $sessionDir "rollout-2026-05-06T06-00-00-$oldId.jsonl"
    $newPath = Join-Path $sessionDir "rollout-2026-05-06T07-00-00-$newId.jsonl"
    Set-Content -Path $oldPath -Encoding UTF8 -Value (@{ type = 'session_meta'; payload = @{ id = $oldId; cwd = 'D:\workspace\ai\research\xiheAi'; source = 'cli'; originator = 'codex-tui' } } | ConvertTo-Json -Compress)
    Set-Content -Path $newPath -Encoding UTF8 -Value (@{ type = 'session_meta'; payload = @{ id = $newId; cwd = 'D:\workspace\ai\research\xiheAi'; source = 'cli'; originator = 'codex-tui' } } | ConvertTo-Json -Compress)

    $mapPath = Join-Path $mapDir 'test-resume.jsonl'
    @(
        (@{ name = 'test-resume'; runtime = 'codex'; sessionId = $oldId; transcriptPath = $oldPath; lastSeenAt = 1000 } | ConvertTo-Json -Compress)
        (@{ name = 'test-resume'; runtime = 'codex'; sessionId = $newId; transcriptPath = $newPath; lastSeenAt = 2000 } | ConvertTo-Json -Compress)
        (@{ name = 'test-resume'; runtime = 'claude'; sessionId = $otherRuntimeId; transcriptPath = $newPath; lastSeenAt = 3000 } | ConvertTo-Json -Compress)
    ) | Set-Content -Path $mapPath -Encoding UTF8

    $ErrorActionPreference = 'Continue'
    $quotedProfilePath = "'" + ($profilePath -replace "'", "''") + "'"
    $hubOnline = @"
function Invoke-WebRequest {
    param([string]`$Uri, [int]`$TimeoutSec, [switch]`$UseBasicParsing)
    Write-Output "HUB_TIMEOUT=`$TimeoutSec"
    [pscustomobject]@{ Content = '[{"name":"test-resume","sessionId":"$hubNewId","runtime":"codex"},{"name":"test-resume","sessionId":"$otherRuntimeId","runtime":"claude"},{"name":"test-resume","sessionId":"$hubOldId","runtime":"codex"}]' }
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
        @{ Name = 'fresh'; Command = "$hubOnline`n. $quotedProfilePath; ipcx test-resume"; Expect = 'NO_RESUME' },
        @{ Name = 'hub-latest'; Command = "$hubOnline`n. $quotedProfilePath; ipcx test-resume -resume"; Expect = "resume|$hubNewId" },
        @{ Name = 'hub-head1'; Command = "$hubOnline`n. $quotedProfilePath; ipcx test-resume -resume 1"; Expect = "resume|$hubOldId" },
        @{ Name = 'offline-fallback-latest'; Command = "$hubOffline`n. $quotedProfilePath; ipcx test-resume -resume 0"; Expect = "resume|$newId" },
        @{ Name = 'empty-fallback-head1'; Command = "$hubEmpty`n. $quotedProfilePath; ipcx test-resume -resume 1"; Expect = "resume|$oldId" },
        @{ Name = 'guid'; Command = "$hubOnline`n. $quotedProfilePath; ipcx test-resume -resume $guidId"; Expect = "resume|$guidId"; ExtraReject = 'HUB_TIMEOUT=' },
        @{ Name = 'missing-name'; Command = "$hubEmpty`n. $quotedProfilePath; ipcx missing-name -resume 0"; Expect = 'has no historical session' }
    )

    $failed = $false
    foreach ($case in $cases) {
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($case.Command))
        $env:APPDATA = $appData
        $env:USERPROFILE = $userProfile
        $env:CODEX_HOME = $codexHome
        $output = & $ShellExe -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded 2>&1 | Out-String

        $pass = $false
        if ($case.Expect -eq 'NO_RESUME') {
            $pass = ($output -match 'CODEX_ARGS=--dangerously-bypass-approvals-and-sandbox') -and ($output -notmatch 'CODEX_ARGS=resume')
        } else {
            $pass = $output -match [regex]::Escape($case.Expect)
        }
        if ($pass -and $case.ContainsKey('ExtraReject')) {
            $pass = $output -notmatch [regex]::Escape($case.ExtraReject)
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
