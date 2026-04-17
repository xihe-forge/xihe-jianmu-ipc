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
$vbsPath = "D:\workspace\ai\research\xiheAi\xihe-jianmu-ipc\bin\hub-daemon.vbs"
$argString = '//B "' + $vbsPath + '"'
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument $argString
# 触发器：用户登录时 + 每10分钟重复（双保险）
# 注意：AtStartup 需要管理员权限，这里不用，改靠 AtLogOn + Repetition 覆盖
$trigger1 = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger2 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "JianmuHubDaemon" -Action $action -Trigger @($trigger1, $trigger2) -Settings $settings -Force

Write-Host "JianmuHubDaemon registered"
Stop-Transcript
