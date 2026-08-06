@echo off
setlocal enabledelayedexpansion

:: ============================================================================
:: completeDiscordQuest Vencord Plugin Updater (Auto-Restart)
:: ============================================================================

title completeDiscordQuest Plugin Updater
set "SCRIPT_DIR=%~dp0"

:MENU
cls
echo =================================================
echo   completeDiscordQuest Vencord Plugin Updater
echo =================================================
echo.
echo  [1] Local Update  (Sync files from this folder)
echo  [2] Online Update (Pull latest from GitHub)
echo  [3] Exit
echo.
choice /c 123 /n /m "Select an option (1-3): "
set "choice=%errorlevel%"

if "%choice%"=="1" set "PS_FILE=update-local.ps1"
if "%choice%"=="2" set "PS_FILE=update-online.ps1"
if "%choice%"=="3" exit /b 0

if not exist "%SCRIPT_DIR%%PS_FILE%" (
    echo [ERROR] %PS_FILE% not found.
    pause
    goto MENU
)

:: Run the selected PowerShell script
where pwsh >nul 2>&1
if %errorlevel% equ 0 (
    pwsh -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%%PS_FILE%"
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%%PS_FILE%"
)

:: If successful, restart Discord automatically
if %errorlevel% equ 0 (
    echo.
    echo [SUCCESS] Update complete! Restarting Discord...
    
    :: Logic to find and start Discord
    if exist "%LOCALAPPDATA%\Discord\Update.exe" (
        start "" "%LOCALAPPDATA%\Discord\Update.exe" --processStart Discord.exe
    ) else if exist "%APPDATA%\Discord\Update.exe" (
        start "" "%APPDATA%\Discord\Update.exe" --processStart Discord.exe
    ) else if exist "%PROGRAMFILES%\Discord\Discord.exe" (
        start "" "%PROGRAMFILES%\Discord\Discord.exe"
    ) else (
        echo [WARNING] Could not find Discord installation to restart.
    )
    
    timeout /t 3 >nul
    exit
) else (
    echo.
    echo [ERROR] Script failed. Discord will not be restarted.
    pause
    goto MENU
)