' bin/hub-daemon.vbs — Hub 自启自愈守护
' 每5分钟检查Hub真实健康（端口+health），不健康则杀旧进程+拉起新进程
' 无限循环，由Windows任务计划每10分钟重复触发一次（双保险）

Set shell = CreateObject("WScript.Shell")
projectDir = "D:\workspace\ai\research\xiheAi\xihe-jianmu-ipc"
shell.CurrentDirectory = projectDir

Do
  ' 用 curl 检测 Hub 健康。-s 静默 -f 失败非0 -m 3 超时3秒
  Dim healthExit
  healthExit = shell.Run("cmd /c curl -s -f -m 3 http://127.0.0.1:3179/health >nul 2>&1", 0, True)

  If healthExit <> 0 Then
    ' Hub 不健康，先检查端口是否被占用（假活进程）
    Dim occupyExit
    occupyExit = shell.Run("cmd /c netstat -ano | findstr "":3179 "" | findstr ""LISTENING"" >nul 2>&1", 0, True)
    If occupyExit = 0 Then
      ' 端口被占但 /health 不通：找 PID 杀掉（仅该 PID，绝不 taskkill node.exe）
      shell.Run "cmd /c for /f ""tokens=5"" %a in ('netstat -ano ^| findstr "":3179 "" ^| findstr ""LISTENING""') do taskkill /PID %a /F >> data\hub.log 2>&1", 0, True
      WScript.Sleep 2000
    End If
    ' 拉起 Hub（隐藏窗口，不等待）
    shell.Run "cmd /c node hub.mjs >> data\hub.log 2>&1", 0, False
  End If

  WScript.Sleep 300000  ' 5 分钟
Loop
