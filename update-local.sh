#!/usr/bin/env bash

# ================================================
# Automated plugin installer/updater for Vencord on Linux
# ================================================

set -e

PLUGIN_NAME="completeDiscordQuest"
GIT_REPO_URL="https://github.com/h1z1z1h16584/completeDiscordQues.git"

# Helper Functions
write_section() { echo -e "\n\033[1;33m$1\033[0m"; }
write_success() { echo -e "  \033[0;32m[OK]\033[0m $1"; }
write_warn()    { echo -e "  \033[0;33m[WARN]\033[0m $1"; }
write_err()     { echo -e "  \033[0;31m[ERROR]\033[0m $1"; }
write_info()    { echo -e "  \033[0;37m$1\033[0m"; }

test_cmd() {
    command -v "$1" >/dev/null 2>&1
}

test_is_vencord_source() {
    local dir="$1"
    if [[ -f "$dir/package.json" && -d "$dir/src" && -f "$dir/pnpm-lock.yaml" ]]; then
        if grep -q '"name": "vencord"' "$dir/package.json"; then
            return 0
        fi
    fi
    return 1
}

test_is_inside_vencord() {
    local script_dir="$1"
    local vencord_root
    vencord_root=$(cd "$script_dir/../../.." 2>/dev/null && pwd || true)
    if [[ -n "$vencord_root" ]] && test_is_vencord_source "$vencord_root"; then
        echo "$vencord_root"
    fi
}

find_vencord_installation() {
    local search_paths=(
        "$HOME/Documents/Vencord"
        "$HOME/Vencord"
        "$HOME/.local/share/Vencord"
        "/home/$USER/Vencord"
    )
    for p in "${search_paths[@]}"; do
        if test_is_vencord_source "$p"; then
            echo "$p"
            return 0
        fi
    done
}

# Main Execution
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo -e "\033[1;36m================================================\033[0m"
echo -e "\033[1;36m  completeDiscordQuest Plugin Installer/Updater\033[0m"
echo -e "\033[1;36m================================================\033[0m\n"
echo -e "\033[1;33m  NOTE: Requires Vencord built from source\033[0m"
echo -e "  (Official installer does not support userplugins)\n"

EXISTING_VENCORD=$(test_is_inside_vencord "$SCRIPT_DIR")

if [[ -z "$EXISTING_VENCORD" ]]; then
    write_info "Running from: $SCRIPT_DIR"
    write_info "Mode: First-time installation"
    IS_FIRST_TIME=true
else
    write_info "Running from: $SCRIPT_DIR"
    write_info "Mode: Update existing installation"
    VENCORD_PATH="$EXISTING_VENCORD"
    IS_FIRST_TIME=false
fi

# Step 1: Node.js
write_section "[1/8] Checking for Node.js..."
if test_cmd node; then
    NODE_VER=$(node -v | sed 's/v\([0-9]*\).*/\1/')
    if [[ "$NODE_VER" -ge 18 ]]; then
        write_success "Node.js $(node -v) installed"
    else
        write_err "Node.js $(node -v) is too old. v18+ required."
        exit 1
    fi
else
    write_err "Node.js is not installed. Please install Node.js v18+."
    exit 1
fi

# Step 2: pnpm
write_section "[2/8] Checking for pnpm..."
if test_cmd pnpm; then
    write_success "pnpm v$(pnpm -v) installed"
else
    write_warn "pnpm is not installed. Attempting installation via npm..."
    if sudo npm install -g pnpm || npm install -g pnpm; then
        write_success "pnpm installed successfully."
    else
        write_err "Failed to install pnpm. Run: npm install -g pnpm"
        exit 1
    fi
fi

# Step 3: Git
write_section "[3/8] Checking for Git..."
if test_cmd git; then
    write_success "Git installed: $(git --version)"
else
    write_err "Git is not installed. Please install Git using your Linux package manager (e.g., sudo apt install git)."
    exit 1
fi

# Step 4: Locate Vencord
write_section "[4/8] Locating Vencord source directory..."
if [[ -z "$VENCORD_PATH" ]]; then
    VENCORD_PATH=$(find_vencord_installation)
fi

if [[ -z "$VENCORD_PATH" ]] || ! test_is_vencord_source "$VENCORD_PATH"; then
    write_warn "Could not find Vencord source installation automatically."
    read -rp "  Enter path to your Vencord source folder: " VENCORD_PATH
    VENCORD_PATH=$(eval echo "$VENCORD_PATH") # Expand ~ if used

    if [[ -z "$VENCORD_PATH" ]] || ! test_is_vencord_source "$VENCORD_PATH"; then
        write_err "Invalid path or not a Vencord source directory."
        echo -e "  Clone Vencord first:\n    cd ~/Documents\n    git clone https://github.com/Vendicated/Vencord.git\n    cd Vencord\n    pnpm install --frozen-lockfile"
        exit 1
    fi
fi

write_success "Vencord source found: $VENCORD_PATH"

PLUGIN_DEST_DIR="$VENCORD_PATH/src/userplugins/$PLUGIN_NAME"
USERPLUGIN_DIR="$VENCORD_PATH/src/userplugins"

mkdir -p "$USERPLUGIN_DIR"

# Step 5: Install/Copy Plugin
if [[ "$IS_FIRST_TIME" == true ]]; then
    write_section "[5/8] Installing plugin to Vencord..."
    mkdir -p "$PLUGIN_DEST_DIR"
    rsync -av --exclude='.git' "$SCRIPT_DIR/" "$PLUGIN_DEST_DIR/"
    write_success "Plugin files installed to: $PLUGIN_DEST_DIR"
    SCRIPT_DIR="$PLUGIN_DEST_DIR"
else
    write_section "[5/8] Plugin already in place."
    write_success "Plugin directory: $PLUGIN_DEST_DIR"
fi

# Step 6: Git Pull/Sync
write_section "[6/8] Syncing plugin with Git repository..."
cd "$SCRIPT_DIR"
if [[ ! -d ".git" ]]; then
    write_info "Initializing Git repository..."
    git init
    git remote add origin "$GIT_REPO_URL" || true
    git fetch origin
    git checkout -f main || git checkout -f master
    write_success "Git repository initialized."
else
    write_info "Pulling latest changes..."
    git stash
    git pull --rebase || git reset --hard origin/main
    git stash pop || true
    write_success "Updated to latest version."
fi

# Step 7: Build
write_section "[7/8] Building Vencord..."
cd "$VENCORD_PATH"
if pnpm build; then
    write_success "Build completed."
else
    write_err "Build failed. Run 'pnpm install --frozen-lockfile && pnpm build' manually."
    exit 1
fi

# Step 8: Inject
write_section "[8/8] Injecting Vencord into Discord..."
cd "$VENCORD_PATH"
if pnpm inject; then
    write_success "Injected into Discord."
else
    write_err "Inject failed. Try running 'pnpm inject' manually."
    exit 1
fi

echo -e "\n\033[1;32m================================================\033[0m"
echo -e "\033[1;32m   Plugin installed/updated successfully!\033[0m"
echo -e "\033[1;32m================================================\033[0m\n"
echo "Next steps:"
echo "  1. Restart Discord completely (killall -9 Discord discord vesktop)"
echo "  2. Go to Settings > Vencord > Plugins"
echo "  3. Search for '$PLUGIN_NAME' and enable it"
