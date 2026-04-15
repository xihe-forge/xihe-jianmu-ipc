' 静默启动 JianmuHub，无弹窗
' 延迟30秒等待网络就绪，检查端口，启动Hub
WScript.Sleep 30000

Set shell = CreateObject("WScript.Shell")
projectDir = "D:\workspace\ai\research\xiheAi\xihe-jianmu-ipc"
shell.CurrentDirectory = projectDir

' 检查3179端口是否已占用
Dim ret
ret = shell.Run("cmd /c netstat -ano | findstr "":3179 "" | findstr ""LISTENING"" >nul 2>&1", 0, True)
If ret = 0 Then
    ' 端口已占用，跳过
    WScript.Quit 0
End If

' 直接启动node hub.mjs，0=隐藏窗口，False=不等待
shell.Run "cmd /c node hub.mjs >> data\hub.log 2>&1", 0, False
