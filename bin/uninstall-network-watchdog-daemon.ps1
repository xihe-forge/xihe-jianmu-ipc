#requires -version 5
# bin/uninstall-network-watchdog-daemon.ps1 — 卸载 NetworkWatchdogDaemon 任务计划
# 用法：powershell -File bin\uninstall-network-watchdog-daemon.ps1

$logDir = "D:\workspace\ai\research\xiheAi\temp\jianmu-ipc\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Start-Transcript -Path (Join-Path $logDir "uninstall-network-watchdog.log") -Append

schtasks /query /tn NetworkWatchdogDaemon 2>$null
if ($?) { schtasks /delete /tn NetworkWatchdogDaemon /f; Write-Host "Removed NetworkWatchdogDaemon" }

Stop-Transcript
