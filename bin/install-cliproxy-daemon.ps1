#requires -version 5
# bin/install-cliproxy-daemon.ps1 — 注册 CliProxyDaemon 任务计划
# 用法：powershell -ExecutionPolicy Bypass -File bin\install-cliproxy-daemon.ps1

$logDir = "D:\workspace\ai\research\xiheAi\temp\jianmu-ipc\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Start-Transcript -Path (Join-Path $logDir "install-cliproxy.log") -Append

# 清理旧任务（如果存在）
schtasks /query /tn CliProxyDaemon 2>$null
if ($?) { schtasks /delete /tn CliProxyDaemon /f; Write-Host "Removed existing CliProxyDaemon task" }

# 注册新任务（2026-04-24 改直接用 wscript.exe 不套 cmd /c，避免 cmd 窗口每 10min 闪一次；
# XiheMemWatch v1.2 实证 //B "path" 直接作为 Argument 不被吞）
$vbsPath = "D:\workspace\ai\research\xiheAi\xihe-jianmu-ipc\bin\cliproxy-daemon.vbs"
$argString = "//B `"$vbsPath`""
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument $argString
# 触发器：用户登录时 + 每10分钟重复（双保险）
# AtStartup 需要管理员权限，这里不用，改靠 AtLogOn + Repetition 覆盖
$trigger1 = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger2 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "CliProxyDaemon" -Action $action -Trigger @($trigger1, $trigger2) -Settings $settings -Force

Write-Host "CliProxyDaemon registered"
Stop-Transcript
