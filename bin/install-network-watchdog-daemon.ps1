#requires -version 5
# bin/install-network-watchdog-daemon.ps1 — 注册 NetworkWatchdogDaemon 任务计划
# 用法：powershell -File bin\install-network-watchdog-daemon.ps1

$logDir = "D:\workspace\ai\research\xiheAi\temp\jianmu-ipc\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Start-Transcript -Path (Join-Path $logDir "install-network-watchdog.log") -Append

schtasks /query /tn NetworkWatchdogDaemon 2>$null
if ($?) { schtasks /delete /tn NetworkWatchdogDaemon /f; Write-Host "Removed existing NetworkWatchdogDaemon task" }

$vbsPath = "D:\workspace\ai\research\xiheAi\xihe-jianmu-ipc\bin\network-watchdog-daemon.vbs"
$argString = '/c wscript.exe //B "' + $vbsPath + '"'
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $argString
$trigger1 = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger2 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "NetworkWatchdogDaemon" -Action $action -Trigger @($trigger1, $trigger2) -Settings $settings -Force

Write-Host "NetworkWatchdogDaemon registered"
Stop-Transcript
