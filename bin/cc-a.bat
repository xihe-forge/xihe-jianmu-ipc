@echo off
setlocal
set "VAULT=%USERPROFILE%\.claude\.creds-vault\account-a.json"
set "TARGET=%USERPROFILE%\.claude\.credentials.json"
set "MARKER=%USERPROFILE%\.claude\.current-account"

powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\start-claude-account.ps1" -Which a -VaultPath "%VAULT%" -CredentialsPath "%TARGET%" -MarkerPath "%MARKER%" %*
