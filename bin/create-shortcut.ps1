# [LEGACY] 此脚本已废弃，请使用 bin/install-daemon.ps1 注册任务计划
# install-daemon.ps1 会自动清理此脚本创建的 startup 快捷方式

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\JianmuHub.lnk")
$sc.TargetPath = "D:\workspace\ai\research\xiheAi\xihe-jianmu-ipc\bin\start-hub-silent.vbs"
$sc.WorkingDirectory = "D:\workspace\ai\research\xiheAi\xihe-jianmu-ipc"
$sc.Description = "Jianmu IPC Hub Auto Start"
$sc.Save()
Write-Host "[JianmuHub] Startup shortcut created successfully"
