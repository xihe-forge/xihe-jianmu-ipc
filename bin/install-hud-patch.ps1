#requires -version 5
param(
  [string]$HudRoot = (Join-Path $env:USERPROFILE '.claude\plugins\cache\claude-hud\claude-hud'),
  [string]$PatchPath = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')).Path 'patches\claude-hud-jianmu-priority.patch'),
  [switch]$RegisterTask
)

$ErrorActionPreference = 'Stop'
$taskName = 'JianmuClaudeHudPatch'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logDir = 'D:\workspace\ai\research\xiheAi\temp\jianmu-ipc\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Has-JianmuPatch {
  param([string]$VersionDir)
  $src = Join-Path $VersionDir 'src\usage-api.ts'
  $dist = Join-Path $VersionDir 'dist\usage-api.js'
  $distIndex = Join-Path $VersionDir 'dist\index.js'
  $srcPatched = (Test-Path -LiteralPath $src) -and [bool](Select-String -LiteralPath $src -Pattern '127.0.0.1|Jianmu|jianmu|3179' -Quiet)
  $distPatched = (Test-Path -LiteralPath $dist) -and [bool](Select-String -LiteralPath $dist -Pattern '127.0.0.1|Jianmu|jianmu|3179' -Quiet)
  $distSuppressesDirect = (Test-Path -LiteralPath $dist) -and [bool](Select-String -LiteralPath $dist -Pattern 'direct Anthropic fallback suppressed' -Quiet)
  $distIndexPatched = (Test-Path -LiteralPath $distIndex) -and [bool](Select-String -LiteralPath $distIndex -Pattern '127.0.0.1:3179|jianmu|Jianmu' -Quiet)
  return ($srcPatched -and $distPatched -and $distSuppressesDirect -and $distIndexPatched)
}

function Invoke-Logged {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$WorkingDirectory
  )
  $resolvedFilePath = $FilePath
  if ($FilePath -eq 'npm') {
    $resolvedFilePath = 'npm.cmd'
  }
  Write-Host ">> $resolvedFilePath $($Arguments -join ' ')"
  $process = Start-Process -FilePath $resolvedFilePath -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory -NoNewWindow -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "$FilePath exited with $($process.ExitCode) in $WorkingDirectory"
  }
}

function Patch-Version {
  param([string]$VersionDir)

  $src = Join-Path $VersionDir 'src\usage-api.ts'
  if (-not (Test-Path -LiteralPath $src)) {
    Write-Host "Skip ${VersionDir}: missing src\usage-api.ts"
    return
  }

  if (Has-JianmuPatch $VersionDir) {
    Write-Host "Already patched: $VersionDir"
    return
  }

  $srcPatched = [bool](Select-String -LiteralPath $src -Pattern '127.0.0.1|Jianmu|jianmu|3179' -Quiet)
  if (-not $srcPatched) {
    Invoke-Logged -FilePath 'git' -Arguments @('apply', '--check', $PatchPath) -WorkingDirectory $VersionDir
    Invoke-Logged -FilePath 'git' -Arguments @('apply', $PatchPath) -WorkingDirectory $VersionDir
  } else {
    $srcText = Get-Content -LiteralPath $src -Raw
    if ($srcText -match 'falling back to Anthropic direct') {
      $srcText = $srcText -replace 'async function fetchUsageApiWithJianmu\(accessToken: string\): Promise<UsageApiResult> \{\s+const jianmuResult = await fetchJianmuUsageApi\(\);\s+if \(jianmuResult\.data\) \{\s+return jianmuResult;\s+\}\s+if \(\s+jianmuResult\.error === ''jianmu-network'' \|\|\s+jianmuResult\.error === ''jianmu-timeout'' \|\|\s+jianmuResult\.error === ''jianmu-parse''\s+\) \{\s+debug\(''Jianmu usage unavailable, falling back to Anthropic direct:'', jianmuResult\.error\);\s+return fetchUsageApi\(accessToken\);\s+\}\s+return jianmuResult;\s+\}', "async function fetchUsageApiWithJianmu(_accessToken: string): Promise<UsageApiResult> {`r`n  const jianmuResult = await fetchJianmuUsageApi();`r`n  if (jianmuResult.data) {`r`n    return jianmuResult;`r`n  }`r`n`r`n  debug('Jianmu usage unavailable, direct Anthropic fallback suppressed:', jianmuResult.error);`r`n  return jianmuResult;`r`n}"
      Set-Content -LiteralPath $src -Value $srcText -NoNewline -Encoding UTF8
    }
  }

  Invoke-Logged -FilePath 'npm' -Arguments @('ci') -WorkingDirectory $VersionDir
  Invoke-Logged -FilePath 'npm' -Arguments @('run', 'build') -WorkingDirectory $VersionDir

  if (-not (Has-JianmuPatch $VersionDir)) {
    throw "Patch verification failed for $VersionDir"
  }
  Write-Host "Patched and built: $VersionDir"
}

if ($RegisterTask) {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Hours 1)
  $trigger.Repetition.StopAtDurationEnd = $false
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  Write-Host "$taskName registered"
}

if (-not (Test-Path -LiteralPath $HudRoot)) {
  Write-Host "HUD root not found: $HudRoot"
  exit 0
}

$versions = Get-ChildItem -LiteralPath $HudRoot -Directory |
  Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } |
  Sort-Object Name

foreach ($version in $versions) {
  Patch-Version -VersionDir $version.FullName
}
