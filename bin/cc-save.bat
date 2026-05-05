@echo off
setlocal
if "%1"=="" (
    echo Usage: cc-save a    ^(saves current login as Account A^)
    echo        cc-save b    ^(saves current login as Account B^)
    exit /b 1
)

if /I not "%1"=="a" if /I not "%1"=="b" (
    echo [!] Account must be a or b.
    exit /b 1
)

set "SRC=%USERPROFILE%\.claude\.credentials.json"
set "DST=%USERPROFILE%\.claude\.creds-vault\account-%1.json"

if not exist "%SRC%" (
    echo [!] No current credentials found at %SRC%
    echo     Run 'claude' and /login first.
    exit /b 1
)

if not exist "%USERPROFILE%\.claude\.creds-vault" mkdir "%USERPROFILE%\.claude\.creds-vault"
copy /Y "%SRC%" "%DST%" >nul
echo [OK] Current login saved as Account %1 -^> %DST%
