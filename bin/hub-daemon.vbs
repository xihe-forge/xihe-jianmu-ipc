' bin/hub-daemon.vbs — Hub 时间盒守护（exit-after-once）
' 单次健康检查 + 必要重拉 + housekeeping log + WScript.Quit 0
' 周期性依赖 schtasks AtLogOn + Repetition 10min 触发器

Set shell = CreateObject("WScript.Shell")
projectDir = "D:\workspace\ai\research\xiheAi\xihe-jianmu-ipc"
shell.CurrentDirectory = projectDir

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
  ' 拉起 Hub（隐藏窗口，不等待，不占用 housekeeping log 文件锁）
  shell.Run "cmd /c start ""JianmuHub"" /min node hub.mjs", 0, False
End If

WScript.Sleep 2000

' 写 housekeeping log（ISO-8601 时间戳格式 YYYY-MM-DDTHH:mm:ss）
Dim ts
ts = Year(Now) & "-" & Right("0" & Month(Now), 2) & "-" & Right("0" & Day(Now), 2) & _
     "T" & Right("0" & Hour(Now), 2) & ":" & Right("0" & Minute(Now), 2) & ":" & Right("0" & Second(Now), 2)

Set fso = CreateObject("Scripting.FileSystemObject")
If Not fso.FolderExists("data") Then
  fso.CreateFolder("data")
End If
Set logFile = fso.OpenTextFile("data\hub.log", 8, True)
logFile.WriteLine "[housekeeping] " & ts & " OK"
logFile.Close

WScript.Quit 0
