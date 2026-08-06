#!/usr/bin/env bash

# ================================================
# Online Updater for Vencord Plugin (Linux)
# ================================================

set -e

PLUGIN_NAME="completeDiscordQuest"
GIT_REPO_URL="https://github.com/h1z1z1h16584/completeDiscordQuest.git"
VENCORD_PATH="$HOME/Documents/Vencord"
PLUGIN_DEST_DIR="$VENCORD_PATH/src/userplugins/$PLUGIN_NAME"

echo -e "\033[1;33mClosing active Discord processes...\033[0m"
killall -9 Discord discord Vesktop vesktop 2>/dev/null || true
sleep 2

echo -e "\033[1;35m--- ONLINE UPDATER ---\033[0m"

if [[ ! -d "$PLUGIN_DEST_DIR" ]]; then
    echo -e "\033[1;33mPlugin directory not found. Initializing...\033[0m"
    mkdir -p "$PLUGIN_DEST_DIR"
    git clone "$GIT_REPO_URL" "$PLUGIN_DEST_DIR"
else
    cd "$PLUGIN_DEST_DIR"
    echo -e "\033[1;33mChecking GitHub for updates...\033[0m"
    git fetch origin
    
    LOCAL_HASH=$(git rev-parse HEAD)
    REMOTE_HASH=$(git rev-parse "@{u}")

    if [[ "$LOCAL_HASH" == "$REMOTE_HASH" ]]; then
        echo -e "\033[1;32mAlready up to date with GitHub.\033[0m"
    else
        echo -e "\033[1;36mNew version found! Pulling...\033[0m"
        git pull --rebase
    fi
fi

echo -e "\033[1;37mBuilding Vencord...\033[0m"
cd "$VENCORD_PATH"
pnpm build

echo -e "\033[1;32m[SUCCESS] Online update finished!\033[0m"
