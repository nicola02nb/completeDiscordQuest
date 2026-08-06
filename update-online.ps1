$PluginName = "completeDiscordQuest"
$GitRepoUrl = "https://github.com/h1z1z1h16584/completeDiscordQuest.git"
$ErrorActionPreference = "Stop"

try {
    # 1. Kill Discord
    Write-Host "Closing Discord to release file locks..." -ForegroundColor Yellow
    Stop-Process -Name "Discord" -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2

    Write-Host "--- ONLINE UPDATER ---" -ForegroundColor Magenta

    # 2. Setup Paths
    $VencordPath = "$env:USERPROFILE\Documents\Vencord"
    $PluginDestDir = Join-Path $VencordPath "src\userplugins\$PluginName"

    # 3. Git Logic
    if (-not (Test-Path $PluginDestDir)) {
        Write-Host "Plugin not found. Initializing..." -ForegroundColor Yellow
        New-Item -ItemType Directory -Path $PluginDestDir -Force | Out-Null
        Set-Location $PluginDestDir
        git clone $GitRepoUrl .
    } else {
        Set-Location $PluginDestDir
        Write-Host "Checking GitHub for updates..." -ForegroundColor Yellow
        
        git fetch origin
        $LocalHash = git rev-parse HEAD
        $RemoteHash = git rev-parse "@{u}"

        if ($LocalHash -eq $RemoteHash) {
            Write-Host "Already up to date with GitHub." -ForegroundColor Green
        } else {
            Write-Host "New version found! Pulling..." -ForegroundColor Cyan
            git pull --rebase
        }
    }

    # 4. Build
    Write-Host "Building Vencord..." -ForegroundColor Gray
    Set-Location $VencordPath
    cmd /c "pnpm build"
    
    Write-Host "[SUCCESS] Online update finished!" -ForegroundColor Green
    exit 0
}
catch {
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}