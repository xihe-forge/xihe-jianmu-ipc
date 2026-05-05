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
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c=Get-Content -Raw -LiteralPath '%VAULT%' | ConvertFrom-Json; $t=[string]$c.claudeAiOauth.refreshToken; if (-not $t) { throw 'missing refreshToken in Account A vault' }; $tail=$t.Substring([Math]::Max(0, $t.Length - 16)); $sha=[Security.Cryptography.SHA256]::Create(); $hash=[BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($tail))).Replace('-', '').ToLowerInvariant().Substring(0,16); @{ which='a'; fingerprint=$hash } | ConvertTo-Json -Compress | Set-Content -LiteralPath '%MARKER%' -NoNewline -Encoding UTF8"
if errorlevel 1 exit /b 1
title Claude Code [Account A]
claude %*
