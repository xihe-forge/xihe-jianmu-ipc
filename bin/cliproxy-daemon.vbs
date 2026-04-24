' bin/cliproxy-daemon.vbs — CLIProxyAPI 自启自愈守护（方案A + 告警分工）
' 每5分钟 GET /v1/models 测进程存活（本地路由，不消耗token）
' 进程死了→杀僵尸PID→拉起；累计拉起失败5次→IPC告警到 jianmu-pm + harness
' 上游功能问题（/v1/responses 502）不归 daemon 管，由各 session 主动 IPC 告警
' 由 Windows 任务计划（CliProxyDaemon）触发，wscript //B 隐藏运行

Set shell = CreateObject("WScript.Shell")
proxyDir = "D:\workspace\ai\opensource\CLIProxyAPI_6.9.36_windows_amd64"
logDir = "D:\workspace\ai\research\xiheAi\temp\jianmu-ipc\logs"
shell.CurrentDirectory = proxyDir

' 确保日志目录存在
shell.Run "cmd /c if not exist """ & logDir & """ mkdir """ & logDir & """", 0, True
logFile = logDir & "\cliproxy-daemon.log"

Dim consecutiveFailures
consecutiveFailures = 0

Do
  Dim healthExit
  healthExit = shell.Run("cmd /c curl -s -f -m 3 http://127.0.0.1:8317/v1/models >nul 2>&1", 0, True)

  If healthExit = 0 Then
    ' 健康，重置失败计数
    consecutiveFailures = 0
  Else
    ' 进程活检失败
    Call AppendLog("health check failed, attempting restart (consecutive=" & (consecutiveFailures + 1) & ")")

    ' 先清理僵尸进程（端口被占但不响应）
    Dim occupyExit
    occupyExit = shell.Run("cmd /c netstat -ano | findstr "":8317 "" | findstr ""LISTENING"" >nul 2>&1", 0, True)
    If occupyExit = 0 Then
      shell.Run "cmd /c for /f ""tokens=5"" %a in ('netstat -ano ^| findstr "":8317 "" ^| findstr ""LISTENING""') do taskkill /PID %a /F >nul 2>&1", 0, True
      WScript.Sleep 2000
    End If

    ' 拉起 CLIProxyAPI
    shell.Run "cmd /c cli-proxy-api.exe >> """ & logFile & """ 2>&1", 0, False

    ' 等10秒再验证拉起结果
    WScript.Sleep 10000
    Dim verifyExit
    verifyExit = shell.Run("cmd /c curl -s -f -m 3 http://127.0.0.1:8317/v1/models >nul 2>&1", 0, True)
    If verifyExit = 0 Then
      Call AppendLog("restart succeeded")
      consecutiveFailures = 0
    Else
      consecutiveFailures = consecutiveFailures + 1
      Call AppendLog("restart failed, consecutive=" & consecutiveFailures)

      ' 累计5次拉起失败→IPC告警
      If consecutiveFailures >= 5 Then
        Call SendIPCAlert("CliProxyAPI 拉起失败 " & consecutiveFailures & " 次，进程无法恢复。需要人工介入。")
        consecutiveFailures = 0  ' 告警后重置，避免刷屏
      End If
    End If
  End If

  WScript.Sleep 300000  ' 5 分钟
Loop

' 追加日志
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

' 通过 Hub HTTP API 发 IPC 告警
Sub SendIPCAlert(alertMsg)
  On Error Resume Next
  ' 分别发给 jianmu-pm 和 harness
  Dim targets
  targets = Array("jianmu-pm", "harness")
  Dim i
  For i = 0 To UBound(targets)
    Dim payload
    payload = "{""from"":""cliproxy-daemon"",""to"":""" & targets(i) & """,""content"":""[CliProxy告警] " & alertMsg & """}"
    ' 写入临时文件避免shell转义问题
    Dim payloadFile
    payloadFile = logDir & "\cliproxy-alert-payload.json"
    shell.Run "cmd /c echo " & payload & " > """ & payloadFile & """", 0, True
    shell.Run "cmd /c curl -s -X POST -H ""Content-Type: application/json"" -d @""" & payloadFile & """ http://127.0.0.1:3179/send >> """ & logFile & """ 2>&1", 0, True
  Next
  Call AppendLog("IPC alert sent: " & alertMsg)
End Sub
