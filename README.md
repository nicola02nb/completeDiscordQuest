# completeDiscordQuest

A Vencord plugin that automatically completes Discord quests in the background.

> **Note:** This plugin requires building Vencord from source. The official Vencord installer won't work with userplugins.

---

## Quick Install (Windows)

### Prerequisites
You need these installed first:
- **Node.js v18+** - [Download](https://nodejs.org/) (LTS version recommended)
- **Git** - [Download](https://git-scm.com/download/win)
- **pnpm** - Run `npm install -g pnpm` after installing Node.js

### First Time Setup

**Option A: Automated Install (Recommended)**

1. **Clone Vencord** (if you haven't already):
   ```powershell
   cd $HOME\Documents
   git clone https://github.com/Vendicated/Vencord.git
   cd Vencord
   pnpm install --frozen-lockfile
   ```

2. **Download completeDiscordQuest**:
   - [Download the latest release](https://github.com/h1z1z1h16584/completeDiscordQuest/archive/refs/heads/main.zip)
   - Extract the ZIP to a temporary location

3. **Run the Installer**:
   - Double-click **`Run Update.bat`**
   - The script will:
     - Find your Vencord installation
     - Copy the plugin to `src/userplugins/completeDiscordQuest/`
     - Build Vencord with the plugin
     - Inject into Discord

4. **Enable the Plugin**:
   - Restart Discord completely (close from system tray)
   - Go to **Settings → Vencord → Plugins**
   - Search for **completeDiscordQuest** and enable it

**Option B: Manual Install**

```powershell
# Clone Vencord (skip if you already have it)
cd $HOME\Documents
git clone https://github.com/Vendicated/Vencord.git
cd Vencord
pnpm install --frozen-lockfile

# Add completeDiscordQuest plugin
cd src\userplugins
git clone https://github.com/h1z1z1h16584/completeDiscordQuest.git completeDiscordQuest

# Build and inject
cd ..\..
pnpm build
pnpm inject
```

---

## Updating

Navigate to your plugin folder and double-click **`Run Update.bat`**:
```
Documents\Vencord\src\userplugins\completeDiscordQuest\Run Update.bat
```

Or manually:
```powershell
cd $HOME\Documents\Vencord\src\userplugins\completeDiscordQuest
git pull
cd ..\..\..\
pnpm build
pnpm inject
```

Restart Discord after updating.

---

## Supported Quest Types

| Quest Type | Browser | Desktop |
|------------|---------|---------|
| Video Quests | ✅ | ✅ |
| Desktop Gameplay | ❌ | ✅ |
| Stream Quests | ❌ | ✅* |
| Activity Quests | ✅ | ✅ |

*Stream quests require at least one other person in a voice channel.

---

## Troubleshooting

**Plugin doesn't appear?**
- Make sure you built from source: `pnpm build`
- Restart Discord completely (close from system tray too)
- The official Vencord installer doesn't support userplugins

**Build errors?**
- Ensure Node.js v18+ is installed: `node --version`
- Ensure pnpm is installed: `pnpm --version`
- Try `pnpm install --frozen-lockfile` before building

**"pnpm: command not found"?**
- Install pnpm: `npm install -g pnpm`
- Restart your terminal after installing

---

## Uninstalling

```powershell
cd $HOME\Documents\Vencord
rm -r src\userplugins\completeDiscordQuest
pnpm build
pnpm inject
```

Restart Discord after uninstalling.

