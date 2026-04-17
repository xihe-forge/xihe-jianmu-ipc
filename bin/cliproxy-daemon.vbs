' bin/cliproxy-daemon.vbs — CLIProxyAPI 自启自愈守护
' 每5分钟 curl /v1/models 验活，失败则拉起
' 由 Windows 任务计划（CliProxyDaemon）触发，wscript //B 隐藏运行

Set shell = CreateObject("WScript.Shell")
proxyDir = "D:\workspace\ai\opensource\CLIProxyAPI_6.9.19_windows_amd64"
shell.CurrentDirectory = proxyDir

Do
  Dim healthExit
  healthExit = shell.Run("cmd /c curl -s -f -m 3 http://127.0.0.1:8317/v1/models >nul 2>&1", 0, True)

  If healthExit <> 0 Then
    ' 不健康，先检查端口是否被僵尸进程占用
    Dim occupyExit
    occupyExit = shell.Run("cmd /c netstat -ano | findstr "":8317 "" | findstr ""LISTENING"" >nul 2>&1", 0, True)
    If occupyExit = 0 Then
      ' 端口被占但 /v1/models 不通：找 PID 杀掉（仅该 PID，绝不 taskkill by name）
      shell.Run "cmd /c for /f ""tokens=5"" %a in ('netstat -ano ^| findstr "":8317 "" ^| findstr ""LISTENING""') do taskkill /PID %a /F >nul 2>&1", 0, True
      WScript.Sleep 2000
    End If
    ' 拉起 CLIProxyAPI（隐藏窗口，不等待）
    shell.Run "cmd /c cli-proxy-api.exe", 0, False
  End If

  WScript.Sleep 300000  ' 5 分钟
Loop
