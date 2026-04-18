' bin/network-watchdog-daemon.vbs — network-watchdog 自启自愈守护
' 每5分钟检查 watchdog /status，失败则杀旧 PID 并重启
' 连续拉起失败 5 次 → 通过 Hub /send 告警 harness
' 由 Windows 任务计划（NetworkWatchdogDaemon）触发，wscript //B 隐藏运行

Set shell = CreateObject("WScript.Shell")
projectDir = "D:\workspace\ai\research\xiheAi\xihe-jianmu-ipc"
logDir = "D:\workspace\ai\research\xiheAi\temp\jianmu-ipc\logs"
shell.CurrentDirectory = projectDir

' 确保日志目录存在
shell.Run "cmd /c if not exist """ & logDir & """ mkdir """ & logDir & """", 0, True
logFile = logDir & "\network-watchdog-daemon.log"

Dim consecutiveFailures
consecutiveFailures = 0

Do
  Dim healthExit
  healthExit = shell.Run("cmd /c curl -s -f -m 3 http://127.0.0.1:3180/status >nul 2>&1", 0, True)

  If healthExit = 0 Then
    consecutiveFailures = 0
  Else
    Call AppendLog("health check failed, attempting restart (consecutive=" & (consecutiveFailures + 1) & ")")

    Dim occupyExit
    occupyExit = shell.Run("cmd /c netstat -ano | findstr "":3180 "" | findstr ""LISTENING"" >nul 2>&1", 0, True)
    If occupyExit = 0 Then
      shell.Run "cmd /c for /f ""tokens=5"" %a in ('netstat -ano ^| findstr "":3180 "" ^| findstr ""LISTENING""') do taskkill /PID %a /F >nul 2>&1", 0, True
      WScript.Sleep 2000
    End If

    shell.Run "cmd /c node bin\network-watchdog.mjs >> """ & logFile & """ 2>&1", 0, False

    WScript.Sleep 10000
    Dim verifyExit
    verifyExit = shell.Run("cmd /c curl -s -f -m 3 http://127.0.0.1:3180/status >nul 2>&1", 0, True)
    If verifyExit = 0 Then
      Call AppendLog("restart succeeded")
      consecutiveFailures = 0
    Else
      consecutiveFailures = consecutiveFailures + 1
      Call AppendLog("restart failed, consecutive=" & consecutiveFailures)

      If consecutiveFailures >= 5 Then
        Call SendIPCAlert("network-watchdog 拉起失败 " & consecutiveFailures & " 次，进程无法恢复。需要人工介入。")
        consecutiveFailures = 0
      End If
    End If
  End If

  WScript.Sleep 300000
Loop

Sub AppendLog(msg)
  On Error Resume Next
  Dim ts
  ts = Now
  Dim line
  line = "[" & ts & "] " & msg
  Dim cmd
  cmd = "cmd /c echo " & line & " >> """ & logFile & """"
  shell.Run cmd, 0, True
End Sub

Sub SendIPCAlert(alertMsg)
  On Error Resume Next
  Dim payload
  payload = "{""from"":""network-watchdog-daemon"",""to"":""harness"",""content"":""[Watchdog告警] " & alertMsg & """}"
  Dim payloadFile
  payloadFile = logDir & "\network-watchdog-alert-payload.json"
  shell.Run "cmd /c echo " & payload & " > """ & payloadFile & """", 0, True
  shell.Run "cmd /c curl -s -X POST -H ""Content-Type: application/json"" -d @""" & payloadFile & """ http://127.0.0.1:3179/send >> """ & logFile & """ 2>&1", 0, True
  Call AppendLog("IPC alert sent: " & alertMsg)
End Sub
