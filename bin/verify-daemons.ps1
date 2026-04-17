#requires -version 5
# bin/verify-daemons.ps1 — 验证 Hub / CliProxy daemon 的自愈能力
# 用法：powershell -ExecutionPolicy Bypass -File bin\verify-daemons.ps1 [-Service Hub|CliProxy|Both]

param(
  [ValidateSet('Hub', 'CliProxy', 'Both')]
  [string]$Service = 'Both',
  [int]$MaxWaitSeconds = 360  # daemon 5 分钟循环 + 缓冲
)

$logDir = "D:\workspace\ai\research\xiheAi\temp\jianmu-ipc\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "verify-daemons.log"

function Write-Log {
  param($msg)
  $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
  Write-Host $line
  Add-Content -Path $logFile -Value $line
}

function Get-PidByPort {
  param([int]$Port)
  $line = netstat -ano | Select-String ":$Port\s+.*LISTENING" | Select-Object -First 1
  if (-not $line) { return $null }
  $parts = $line.ToString() -split '\s+' | Where-Object { $_ }
  return [int]$parts[-1]
}

function Test-Health {
  param([string]$Url)
  try {
    $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
    return $r.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Verify-Service {
  param(
    [string]$Name,
    [int]$Port,
    [string]$HealthUrl,
    [string]$TaskName
  )

  Write-Log "=== 验证 $Name (port $Port, task $TaskName) ==="

  # 1. 确认当前健康
  if (-not (Test-Health $HealthUrl)) {
    Write-Log "[$Name] 跳过：当前就不健康，请先确保服务跑着"
    return $false
  }
  $oldPid = Get-PidByPort $Port
  if (-not $oldPid) {
    Write-Log "[$Name] 跳过：找不到 PID"
    return $false
  }
  Write-Log "[$Name] 当前 PID=$oldPid，/health OK"

  # 2. kill 该 PID（只杀它，不用 node.exe 全杀）
  Write-Log "[$Name] 开始 kill PID=$oldPid"
  $killStart = Get-Date
  taskkill /PID $oldPid /F | Out-Null
  Start-Sleep -Seconds 2

  # 3. 确认 kill 成功
  if (Test-Health $HealthUrl) {
    Write-Log "[$Name] 警告：kill 后仍健康（可能有多实例）"
    return $false
  }
  Write-Log "[$Name] 已死，开始轮询恢复..."

  # 4. 轮询恢复
  $deadline = $killStart.AddSeconds($MaxWaitSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Health $HealthUrl) {
      $recoverSec = ((Get-Date) - $killStart).TotalSeconds
      $newPid = Get-PidByPort $Port
      Write-Log "[$Name] ✅ 恢复，耗时 $([math]::Round($recoverSec,1))秒，新 PID=$newPid"
      return $true
    }
    Start-Sleep -Seconds 5
  }

  Write-Log "[$Name] ❌ 超时 $MaxWaitSeconds 秒未恢复"
  return $false
}

Write-Log "=== daemon 自愈验证开始，max wait $MaxWaitSeconds 秒 ==="

$results = @{}
if ($Service -eq 'Hub' -or $Service -eq 'Both') {
  $results['Hub'] = Verify-Service -Name 'Hub' -Port 3179 -HealthUrl 'http://127.0.0.1:3179/health' -TaskName 'JianmuHubDaemon'
}
if ($Service -eq 'CliProxy' -or $Service -eq 'Both') {
  $results['CliProxy'] = Verify-Service -Name 'CliProxy' -Port 8317 -HealthUrl 'http://127.0.0.1:8317/v1/models' -TaskName 'CliProxyDaemon'
}

Write-Log "=== 验证结果 ==="
foreach ($k in $results.Keys) {
  $status = if ($results[$k]) { '✅ 通过' } else { '❌ 失败' }
  Write-Log "$k : $status"
}

if ($results.Values -contains $false) { exit 1 }
exit 0
