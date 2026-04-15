$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\JianmuHub.lnk")
$sc.TargetPath = "D:\workspace\ai\research\xiheAi\xihe-jianmu-ipc\bin\start-hub-silent.vbs"
$sc.WorkingDirectory = "D:\workspace\ai\research\xiheAi\xihe-jianmu-ipc"
$sc.Description = "Jianmu IPC Hub Auto Start"
$sc.Save()
Write-Host "[JianmuHub] Startup shortcut created successfully"
