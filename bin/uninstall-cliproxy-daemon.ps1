#requires -version 5
# bin/uninstall-cliproxy-daemon.ps1 — 卸载 CliProxyDaemon 任务计划
# 用法：powershell -ExecutionPolicy Bypass -File bin\uninstall-cliproxy-daemon.ps1

$logDir = "D:\workspace\ai\research\xiheAi\temp\jianmu-ipc\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Start-Transcript -Path (Join-Path $logDir "install-cliproxy.log") -Append

schtasks /query /tn CliProxyDaemon 2>$null
if ($?) { schtasks /delete /tn CliProxyDaemon /f; Write-Host "Removed CliProxyDaemon" }

Stop-Transcript
