#requires -version 5
# bin/install-daemon.ps1 — 注册 JianmuHubDaemon 任务计划
# 用法：powershell -ExecutionPolicy Bypass -File bin\install-daemon.ps1

$logDir = "D:\workspace\ai\research\xiheAi\temp\jianmu-ipc\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Start-Transcript -Path (Join-Path $logDir "install.log") -Append

# 清理旧 startup 快捷方式（如果存在）
$oldLink = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup\JianmuHub.lnk"
if (Test-Path $oldLink) { Remove-Item $oldLink -Force; Write-Host "Removed old startup shortcut" }

# 清理旧任务（如果存在）
schtasks /query /tn JianmuHub 2>$null
if ($?) { schtasks /delete /tn JianmuHub /f; Write-Host "Removed old JianmuHub task" }
schtasks /query /tn JianmuHubDaemon 2>$null
if ($?) { schtasks /delete /tn JianmuHubDaemon /f; Write-Host "Removed existing JianmuHubDaemon task" }

# 注册新任务
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument '//B "D:\workspace\ai\research\xiheAi\xihe-jianmu-ipc\bin\hub-daemon.vbs"'
$trigger1 = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger2 = New-ScheduledTaskTrigger -AtStartup
$trigger3 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName "JianmuHubDaemon" -Action $action -Trigger @($trigger1, $trigger2, $trigger3) -Settings $settings -Principal $principal -Force

Write-Host "JianmuHubDaemon registered"
Stop-Transcript
