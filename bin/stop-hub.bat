@echo off
chcp 65001 >nul

echo [JianmuHub] 正在查找监听 3179 端口的进程...

:: 找到监听3179端口的PID
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3179 " ^| findstr "LISTENING"') do (
    set PID=%%a
)

if not defined PID (
    echo [JianmuHub] 未找到监听 3179 端口的进程，已停止或未启动
    exit /b 0
)

echo [JianmuHub] 找到 PID %PID%，正在终止...
taskkill /PID %PID% /F >nul 2>&1

if %errorlevel% == 0 (
    echo [JianmuHub] 进程 %PID% 已成功终止
) else (
    echo [JianmuHub] 终止失败，请手动检查进程 %PID%
)
