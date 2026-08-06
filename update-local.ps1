<#
.SYNOPSIS
    Automated plugin installer/updater for Vencord (from source).
.DESCRIPTION
    This script automates installing or updating a Vencord plugin.
    IMPORTANT: Requires Vencord built from source (not the official installer).

    - First-time install: Copies plugin to correct directory
    - Updates: Pulls latest from Git and rebuilds

    USAGE: Double-click "Run Update.bat" (recommended)
.PARAMETER VencordPath
    Optional. The path to your Vencord source installation directory.
.NOTES
    Requires: PowerShell 5.1+, Node.js v18+, Git, pnpm
    Author: completeDiscordQuest
#>

param(
    [string]$VencordPath = ""
)

$ErrorActionPreference = "Stop"
$PluginName = "completeDiscordQuest"
$GitRepoUrl = "https://github.com/h1z1z1h16584/completeDiscordQues.git"

#region Helper Functions
function Write-SectionHeader {
    param([string]$Message, [string]$Color = "Yellow")
    Write-Host ""
    Write-Host $Message -ForegroundColor $Color
}

function Write-Success {
    param([string]$Message)
    Write-Host "  [OK] $Message" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host "  [WARN] $Message" -ForegroundColor Yellow
}

function Write-Err {
    param([string]$Message)
    Write-Host "  [ERROR] $Message" -ForegroundColor Red
}

function Write-Info {
    param([string]$Message)
    Write-Host "  $Message" -ForegroundColor Gray
}

function Test-Cmd {
    param([string]$Command)
    $oldPref = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    try {
        if (Get-Command $Command -ErrorAction SilentlyContinue) { return $true }
    }
    catch { }
    finally { $ErrorActionPreference = $oldPref }
    return $false
}

function Wait-KeyPress {
    Write-Host ""
    Write-Host "Press any key to continue..." -ForegroundColor Gray
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
}

function Test-IsInsideVencord {
    param([string]$Path)
    # Check if we're inside a Vencord source installation
    # Look for package.json two levels up (src/userplugins/pluginName -> Vencord)
    $parentPath = Split-Path -Parent $Path
    $grandparentPath = Split-Path -Parent $parentPath
    $vencordRoot = Split-Path -Parent $grandparentPath

    if ((Test-Path (Join-Path $vencordRoot "package.json"))) {
        try {
            $packageJson = Get-Content (Join-Path $vencordRoot "package.json") -Raw | ConvertFrom-Json
            if ($packageJson.name -eq "vencord") {
                return $vencordRoot
            }
        }
        catch { }
    }
    return $null
}

function Test-IsVencordSource {
    param([string]$Path)
    # Verify this is a Vencord source installation (not official installer)
    if (-not (Test-Path (Join-Path $Path "package.json"))) { return $false }
    if (-not (Test-Path (Join-Path $Path "src"))) { return $false }
    if (-not (Test-Path (Join-Path $Path "pnpm-lock.yaml"))) { return $false }

    try {
        $packageJson = Get-Content (Join-Path $Path "package.json") -Raw | ConvertFrom-Json
        return $packageJson.name -eq "vencord"
    }
    catch {
        return $false
    }
}

function Find-VencordInstallation {
    $searchPaths = @(
        "$env:USERPROFILE\Documents\Vencord",
        "$env:USERPROFILE\Vencord",
        "C:\Vencord",
        "$env:LOCALAPPDATA\Vencord",
        "$env:APPDATA\Vencord"
    )

    foreach ($p in $searchPaths) {
        if (Test-IsVencordSource $p) {
            return $p
        }
    }
    return $null
}
#endregion

#region Main Script
try {
    # Get script location
    $ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
    if ([string]::IsNullOrEmpty($ScriptDir)) { $ScriptDir = $PWD.Path }

    Write-Host ""
    Write-Host "================================================" -ForegroundColor Cyan
    Write-Host "  completeDiscordQuest Plugin Installer/Updater" -ForegroundColor Cyan
    Write-Host "================================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  NOTE: Requires Vencord built from source" -ForegroundColor Yellow
    Write-Host "  (Official installer doesn't support userplugins)" -ForegroundColor Gray
    Write-Host ""

    # Determine if we're already inside a Vencord installation
    $existingVencord = Test-IsInsideVencord $ScriptDir
    $isFirstTimeInstall = $null -eq $existingVencord

    if ($isFirstTimeInstall) {
        Write-Info "Running from: $ScriptDir"
        Write-Info "Mode: First-time installation"
    }
    else {
        Write-Info "Running from: $ScriptDir"
        Write-Info "Mode: Update existing installation"
        $VencordPath = $existingVencord
    }

    # Step 1: Check for Node.js
    Write-SectionHeader "[1/8] Checking for Node.js..."

    if (Test-Cmd "node") {
        try {
            $nodeVer = node --version 2>&1
            $nodeVerNum = [int]($nodeVer -replace 'v(\d+)\..*', '$1')
            if ($nodeVerNum -ge 18) {
                Write-Success "Node.js $nodeVer installed"
            }
            else {
                Write-Err "Node.js $nodeVer is too old. v18+ required."
                Write-Host ""
                Write-Host "  Download from: https://nodejs.org/" -ForegroundColor Gray
                Wait-KeyPress
                exit 1
            }
        }
        catch {
            Write-Success "Node.js is installed."
        }
    }
    else {
        Write-Err "Node.js is not installed."
        Write-Host ""
        Write-Host "  Please install Node.js v18+ from: https://nodejs.org/" -ForegroundColor Gray
        Wait-KeyPress
        exit 1
    }

    # Step 2: Check for pnpm
    Write-SectionHeader "[2/8] Checking for pnpm..."

    if (Test-Cmd "pnpm") {
        try {
            $pnpmVer = pnpm --version 2>&1
            Write-Success "pnpm v$pnpmVer installed"
        }
        catch {
            Write-Success "pnpm is installed."
        }
    }
    else {
        Write-Warn "pnpm is not installed. Attempting to install..."
        try {
            $result = Start-Process -FilePath "npm" -ArgumentList "install -g pnpm" -NoNewWindow -Wait -PassThru
            if ($result.ExitCode -eq 0) {
                Write-Success "pnpm installed successfully."
                Write-Info "You may need to restart this script for pnpm to be in PATH."
            }
            else {
                throw "npm install failed"
            }
        }
        catch {
            Write-Err "Failed to install pnpm."
            Write-Host ""
            Write-Host "  Run this command manually: npm install -g pnpm" -ForegroundColor Gray
            Wait-KeyPress
            exit 1
        }
    }

    # Step 3: Check for Git
    Write-SectionHeader "[3/8] Checking for Git..."

    if (Test-Cmd "git") {
        try {
            $gitVer = git --version 2>&1
            Write-Success "Git installed: $gitVer"
        }
        catch {
            Write-Success "Git is installed."
        }
    }
    else {
        Write-Warn "Git is not installed. Attempting to install using winget..."

        if (-not (Test-Cmd "winget")) {
            Write-Err "winget not available. Please install Git from https://git-scm.com/download/win"
            Wait-KeyPress
            exit 1
        }

        try {
            $result = Start-Process -FilePath "winget" -ArgumentList "install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements" -NoNewWindow -Wait -PassThru
            if ($result.ExitCode -eq 0) {
                Write-Success "Git installed. Please restart this script."
                Wait-KeyPress
                exit 0
            }
            else {
                throw "winget exit code: $($result.ExitCode)"
            }
        }
        catch {
            Write-Err "Failed to install Git. Please install from https://git-scm.com/download/win"
            Wait-KeyPress
            exit 1
        }
    }

    # Step 4: Find/verify Vencord source installation
    Write-SectionHeader "[4/8] Locating Vencord source directory..."

    if ([string]::IsNullOrEmpty($VencordPath)) {
        $VencordPath = Find-VencordInstallation
    }

    if ([string]::IsNullOrEmpty($VencordPath) -or -not (Test-IsVencordSource $VencordPath)) {
        Write-Warn "Could not find Vencord source installation."
        Write-Host ""
        Write-Host "  Enter path to your Vencord source folder:" -ForegroundColor White
        Write-Host "  (e.g., C:\Users\YourName\Documents\Vencord)" -ForegroundColor Gray
        Write-Host ""
        $VencordPath = Read-Host "  Path"
        $VencordPath = $VencordPath.Trim()
        if ($VencordPath.StartsWith('"')) { $VencordPath = $VencordPath.Substring(1) }
        if ($VencordPath.EndsWith('"')) { $VencordPath = $VencordPath.Substring(0, $VencordPath.Length - 1) }

        if ([string]::IsNullOrEmpty($VencordPath) -or -not (Test-IsVencordSource $VencordPath)) {
            Write-Err "Invalid path or not a Vencord source installation."
            Write-Host ""
            Write-Host "  You need to clone Vencord from source first:" -ForegroundColor Yellow
            Write-Host "    cd `$HOME\Documents" -ForegroundColor Gray
            Write-Host "    git clone https://github.com/Vendicated/Vencord.git" -ForegroundColor Gray
            Write-Host "    cd Vencord" -ForegroundColor Gray
            Write-Host "    pnpm install --frozen-lockfile" -ForegroundColor Gray
            Write-Host ""
            Write-Host "  The official Vencord installer does NOT support userplugins." -ForegroundColor Red
            Wait-KeyPress
            exit 1
        }
    }

    Write-Success "Vencord source found: $VencordPath"

    $PluginDestDir = Join-Path $VencordPath "src\userplugins\$PluginName"
    $userpluginDir = Join-Path $VencordPath "src\userplugins"

    # Ensure userplugins directory exists
    if (-not (Test-Path $userpluginDir)) {
        Write-Info "Creating userplugins directory..."
        New-Item -ItemType Directory -Path $userpluginDir -Force | Out-Null
    }

    # Step 5: Install or update plugin files
    if ($isFirstTimeInstall) {
        Write-SectionHeader "[5/8] Installing plugin to Vencord..."

        # Copy plugin files to destination
        if (Test-Path $PluginDestDir) {
            Write-Info "Plugin directory exists. Updating files..."
            # Remove old files but keep .git if exists
            Get-ChildItem $PluginDestDir -Exclude ".git" | Remove-Item -Recurse -Force
        }
        else {
            Write-Info "Creating plugin directory..."
            New-Item -ItemType Directory -Path $PluginDestDir -Force | Out-Null
        }

        # Copy all files from source to destination
        Write-Info "Copying plugin files..."
        Get-ChildItem $ScriptDir -Exclude ".git" | Copy-Item -Destination $PluginDestDir -Recurse -Force

        Write-Success "Plugin files installed to: $PluginDestDir"

        # Update ScriptDir to point to the new location for git operations
        $ScriptDir = $PluginDestDir
    }
    else {
        Write-SectionHeader "[5/8] Plugin already in place."
        Write-Success "Plugin directory: $PluginDestDir"
    }

    # Step 6: Git operations (pull latest)
    Write-SectionHeader "[6/8] Syncing plugin with Git repository..."

    $origLoc = Get-Location
    try {
        Set-Location $ScriptDir

        if (-not (Test-Path ".git")) {
            Write-Info "Initializing Git repository..."
            $null = git init 2>&1
            $null = git remote add origin $GitRepoUrl 2>&1
            $null = git fetch origin 2>&1

            $branch = "main"
            try {
                $headRef = git symbolic-ref refs/remotes/origin/HEAD 2>&1
                if ($headRef -match "origin/(.+)$") { $branch = $Matches[1] }
            }
            catch { }

            $null = git checkout -f $branch 2>&1
            Write-Success "Git repository initialized."
        }
        else {
            Write-Info "Pulling latest changes..."

            $stashOut = git stash 2>&1
            $hasStash = $stashOut -notmatch "No local changes"

            try {
                $null = git pull --rebase 2>&1
                Write-Success "Updated to latest version."
            }
            catch {
                Write-Warn "Pull failed, resetting to latest..."
                $null = git fetch origin 2>&1
                $currentBranch = git rev-parse --abbrev-ref HEAD 2>&1
                $null = git reset --hard "origin/$currentBranch" 2>&1
                Write-Success "Updated via reset."
            }

            if ($hasStash) {
                try {
                    $null = git stash pop 2>&1
                    Write-Info "Restored stashed changes."
                }
                catch {
                    Write-Warn "Could not restore stash."
                }
            }
        }
    }
    catch {
        Write-Warn "Git sync warning: $($_.Exception.Message)"
        Write-Info "Continuing with existing files..."
    }
    finally {
        Set-Location $origLoc
    }

    # Step 7: Build Vencord
    Write-SectionHeader "[7/8] Building Vencord..."

    $origLoc = Get-Location
    try {
        Set-Location $VencordPath

        Write-Info "Running pnpm build..."
        $buildProc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c pnpm build" -NoNewWindow -PassThru -Wait

        if ($buildProc.ExitCode -ne 0) {
            throw "Build failed with exit code: $($buildProc.ExitCode)"
        }

        Write-Success "Build completed."
    }
    catch {
        Write-Err "Build error: $($_.Exception.Message)"
        Write-Host ""
        Write-Host "  Try running manually:" -ForegroundColor Gray
        Write-Host "    cd $VencordPath" -ForegroundColor Gray
        Write-Host "    pnpm install --frozen-lockfile" -ForegroundColor Gray
        Write-Host "    pnpm build" -ForegroundColor Gray
        Set-Location $origLoc
        Wait-KeyPress
        exit 1
    }
    finally {
        Set-Location $origLoc
    }

    # Step 8: Inject Vencord
    Write-SectionHeader "[8/8] Injecting Vencord into Discord..."

    $origLoc = Get-Location
    try {
        Set-Location $VencordPath

        Write-Info "Running pnpm inject..."
        $injectProc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c pnpm inject" -NoNewWindow -PassThru
        Start-Sleep -Milliseconds 2000

        if ($injectProc -and -not $injectProc.HasExited) {
            try {
                Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
                [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
            }
            catch { }
            $injectProc | Wait-Process -Timeout 60 -ErrorAction SilentlyContinue
        }

        if ($null -ne $injectProc.ExitCode -and $injectProc.ExitCode -ne 0) {
            throw "Inject failed with exit code: $($injectProc.ExitCode)"
        }

        Write-Success "Injected into Discord."
    }
    catch {
        Write-Err "Inject error: $($_.Exception.Message)"
        Write-Host ""
        Write-Host "  Try running manually:" -ForegroundColor Gray
        Write-Host "    cd $VencordPath" -ForegroundColor Gray
        Write-Host "    pnpm inject" -ForegroundColor Gray
        Set-Location $origLoc
        Wait-KeyPress
        exit 1
    }
    finally {
        Set-Location $origLoc
    }

    # Success!
    Write-Host ""
    Write-Host "================================================" -ForegroundColor Green
    if ($isFirstTimeInstall) {
        Write-Host "   Plugin installed successfully!" -ForegroundColor Green
    }
    else {
        Write-Host "   Plugin updated successfully!" -ForegroundColor Green
    }
    Write-Host "================================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Plugin location: $PluginDestDir" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  Next steps:" -ForegroundColor White
    Write-Host "    1. Restart Discord completely (close from system tray)" -ForegroundColor Gray
    Write-Host "    2. Go to Settings > Vencord > Plugins" -ForegroundColor Gray
    Write-Host "    3. Search for 'completeDiscordQuest' and enable it" -ForegroundColor Gray
    Write-Host ""

    if ($isFirstTimeInstall) {
        Write-Host "  For future updates, run 'Run Update.bat' from:" -ForegroundColor Yellow
        Write-Host "    $PluginDestDir" -ForegroundColor Gray
        Write-Host ""
    }

}
catch {
    Write-Err "Unexpected error: $($_.Exception.Message)"
    Write-Host ""
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
}
#endregion
