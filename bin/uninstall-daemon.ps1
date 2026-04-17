#requires -version 5
# bin/uninstall-daemon.ps1 — 卸载 JianmuHubDaemon 任务计划
# 用法：powershell -ExecutionPolicy Bypass -File bin\uninstall-daemon.ps1

$logDir = "D:\workspace\ai\research\xiheAi\temp\jianmu-ipc\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Start-Transcript -Path (Join-Path $logDir "uninstall.log") -Append

# 删除新任务
schtasks /query /tn JianmuHubDaemon 2>$null
if ($?) { schtasks /delete /tn JianmuHubDaemon /f; Write-Host "Removed JianmuHubDaemon" }

# 顺手清理旧任务（防止留垃圾）
schtasks /query /tn JianmuHub 2>$null
if ($?) { schtasks /delete /tn JianmuHub /f; Write-Host "Removed legacy JianmuHub" }

# 清理旧 startup 快捷方式
$oldLink = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup\JianmuHub.lnk"
if (Test-Path $oldLink) { Remove-Item $oldLink -Force; Write-Host "Removed legacy startup shortcut" }

Stop-Transcript
