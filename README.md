# completeDiscordQuest

A Vencord plugin that automatically completes Discord quests in the background on Windows and Linux.

> **Note:** This plugin requires building Vencord from source. The official Vencord installer won't work with userplugins.

---

## Quick Install

### Prerequisites
You need these installed first:
- **Node.js v18+** - [Download](https://nodejs.org/) (LTS version recommended)
- **Git** - [Download](https://git-scm.com/)
- **pnpm** - Run `npm install -g pnpm` after installing Node.js

---

### Linux Setup

#### Option A: Automated Install (Recommended)

1. **Clone Vencord** (if you haven't already):
   ```
   cd ~/Documents
   git clone [https://github.com/Vendicated/Vencord.git](https://github.com/Vendicated/Vencord.git)
   cd Vencord
   pnpm install --frozen-lockfile
2. **Clone completeDiscordQuest into userplugins**:
   ```
   cd src/userplugins
   git clone [https://github.com/h1z1z1h16584/completeDiscordQuest.git](https://github.com/h1z1z1h16584/completeDiscordQuest.git) completeDiscordQuest
   cd completeDiscordQuest
3. **Run the Installer Script**:
   ```
   chmod +x update-local.sh
   ./update-local.sh
4. **Enable the Plugin**:
   ```
   # Kill active Discord processes to ensure fresh load
   killall -9 Discord discord vesktop 2>/dev/null || true
   
   - Open Discord
   - Go to **Settings → Vencord → Plugins**
   - Search for **completeDiscordQuest** and enable it
#### Option B: Manual Install
    # Clone Vencord
    cd ~/Documents
    git clone [https://github.com/Vendicated/Vencord.git](https://github.com/Vendicated/Vencord.git)
    cd Vencord
    pnpm install --frozen-lockfile

    # Clone completeDiscordQuest plugin
    cd src/userplugins
    git clone [https://github.com/h1z1z1h16584/completeDiscordQuest.git](https://github.com/h1z1z1h16584/completeDiscordQuest.git) completeDiscordQuest

    # Build and inject Vencord
    cd ../..
    pnpm build
    pnpm inject
---

### Windows Setup

#### Option A: Automated Install (Recommended)

1. **Clone Vencord** (if you haven't already):
   ```
   cd $HOME\Documents
   git clone [https://github.com/Vendicated/Vencord.git](https://github.com/Vendicated/Vencord.git)
   cd Vencord
   pnpm install --frozen-lockfile
2. **Download completeDiscordQuest**:
   - [Download the latest release](https://github.com/h1z1z1h16584/completeDiscordQuest/archive/refs/heads/main.zip)
   - Extract the ZIP to a temporary location

3. **Run the Installer**:
   - Double-click **`Run Update.bat`** (or execute `./update-local.ps1` in PowerShell)
   - The script will copy the plugin, build Vencord, and inject it automatically.

4. **Enable the Plugin**:
   - Restart Discord completely (close from system tray)
   - Go to **Settings → Vencord → Plugins**
   - Search for **completeDiscordQuest** and enable it

#### Option B: Manual Install
    # Clone Vencord
    cd $HOME\Documents
    git clone [https://github.com/Vendicated/Vencord.git](https://github.com/Vendicated/Vencord.git)
    cd Vencord
    pnpm install --frozen-lockfile

    # Add completeDiscordQuest plugin
    cd src\userplugins
    git clone [https://github.com/h1z1z1h16584/completeDiscordQuest.git](https://github.com/h1z1z1h16584/completeDiscordQuest.git) completeDiscordQuest

    # Build and inject
    cd ..\..
    pnpm build
    pnpm inject
---

## Updating

### On Linux:
Run the update script inside your plugin directory:

    cd ~/Documents/Vencord/src/userplugins/completeDiscordQuest
    chmod +x update-online.sh
    ./update-online.sh
Or manually:
    
    cd ~/Documents/Vencord/src/userplugins/completeDiscordQuest
    git pull
    cd ../../../
    pnpm build
---

### On Windows:
Double-click **`Run Update.bat`** inside:
   
    Documents\Vencord\src\userplugins\completeDiscordQuest\Run Update.bat
Or manually:
    
    cd $HOME\Documents\Vencord\src\userplugins\completeDiscordQuest
    git pull
    cd ..\..\..\
    pnpm build
    pnpm inject
---

## Supported Quest Types

| Quest Type | Desktop |
|------------|----------|
| Video Quests | ✅ |
| Desktop Gameplay | ✅ |
| Stream Quests | ✅ |
| Activity Quests | ✅ |



---

## Troubleshooting

**Plugin doesn't appear?**
- Make sure you built from source: `pnpm build`
- Restart Discord completely (`killall -9 Discord discord` on Linux or system tray on Windows)
- The official Vencord installer doesn't support userplugins

**Build errors / Webpack proxy failures?**
- Ensure Node.js v18+ is installed: `node --version`
- Ensure pnpm is installed: `pnpm --version`
- Try `pnpm install --frozen-lockfile` before running `pnpm build`

**"pnpm: command not found"?**
- Install pnpm: `npm install -g pnpm`
- Restart your terminal application after installing

---

## Uninstalling

### Linux:
    
    cd ~/Documents/Vencord
    rm -rf src/userplugins/completeDiscordQuest
    pnpm build
### Windows:
    
    cd $HOME\Documents\Vencord
    rm -r src\userplugins\completeDiscordQuest
    pnpm build
    pnpm inject
Restart Discord after uninstalling.
