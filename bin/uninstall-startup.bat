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

echo [JianmuHub] 正在删除任务计划 "JianmuHub"...

schtasks /query /tn "JianmuHub" >nul 2>&1
if %errorlevel% neq 0 (
    echo [JianmuHub] 任务计划 "JianmuHub" 不存在，无需删除
    pause
    exit /b 0
)

schtasks /delete /tn "JianmuHub" /f

if %errorlevel% == 0 (
    echo [JianmuHub] 任务计划 "JianmuHub" 已成功删除
) else (
    echo [JianmuHub] 删除失败，错误码 %errorlevel%
)

pause
