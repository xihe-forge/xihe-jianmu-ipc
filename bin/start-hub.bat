@echo off
chcp 65001 >nul

:: 检查3179端口是否已被占用
netstat -ano | findstr ":3179 " | findstr "LISTENING" >nul 2>&1
if %errorlevel% == 0 (
    echo [JianmuHub] 端口 3179 已在监听，跳过启动
    exit /b 0
)

:: 切换到项目目录
cd /d "D:\workspace\ai\research\xiheAi\xihe-jianmu-ipc"

:: 确保日志目录存在
if not exist "data" mkdir data

:: 最小化窗口启动 node hub.mjs，日志追加到 data/hub.log
start /min "JianmuHub" cmd /c "node hub.mjs >> data\hub.log 2>&1"

echo [JianmuHub] 已启动，日志写入 data\hub.log
