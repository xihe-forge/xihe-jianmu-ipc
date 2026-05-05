@echo off
setlocal
set "VAULT=%USERPROFILE%\.claude\.creds-vault\account-a.json"
set "TARGET=%USERPROFILE%\.claude\.credentials.json"
set "MARKER=%USERPROFILE%\.claude\.current-account"

if not exist "%VAULT%" (
    echo [!] Account A credentials not saved yet.
    echo     First login normally with 'claude' then run:
    echo     copy "%TARGET%" "%VAULT%"
    exit /b 1
)

copy /Y "%VAULT%" "%TARGET%" >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\update-claude-account-identity.ps1" -Which a -VaultPath "%VAULT%" -CredentialsPath "%TARGET%" -MarkerPath "%MARKER%"
if errorlevel 1 exit /b 1
title Claude Code [Account A]
claude %*
