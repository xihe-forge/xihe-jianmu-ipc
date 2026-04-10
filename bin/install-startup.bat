@echo off
chcp 65001 >nul

:: 检查管理员权限
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [JianmuHub] 错误：此脚本需要管理员权限运行
    echo [JianmuHub] 请右键点击此脚本，选择"以管理员身份运行"
    pause
    exit /b 1
)

echo [JianmuHub] 正在注册开机自启动任务计划...

:: 如果任务已存在，先删除
schtasks /query /tn "JianmuHub" >nul 2>&1
if %errorlevel% == 0 (
    echo [JianmuHub] 检测到已有任务，先删除旧任务...
    schtasks /delete /tn "JianmuHub" /f >nul 2>&1
)

:: 创建任务计划：用户登录时触发，延迟30秒启动
schtasks /create ^
    /tn "JianmuHub" ^
    /tr "\"D:\workspace\ai\research\xiheAi\xihe-jianmu-ipc\bin\start-hub.bat\"" ^
    /sc onlogon ^
    /delay 0000:30 ^
    /rl highest ^
    /f

if %errorlevel% == 0 (
    echo [JianmuHub] 任务计划 "JianmuHub" 注册成功
    echo [JianmuHub] 下次登录时将在 30 秒后自动启动 Hub（端口 3179）
) else (
    echo [JianmuHub] 任务计划注册失败，错误码 %errorlevel%
)

pause
