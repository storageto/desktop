#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}=== StorageTo Desktop Release Script ===${NC}"
echo ""

# Get version from tauri.conf.json
VERSION=$(grep '"version"' src-tauri/tauri.conf.json | head -1 | sed 's/.*"\([0-9.]*\)".*/\1/')
echo -e "Version: ${GREEN}$VERSION${NC}"
echo ""

# Step 1: Check for uncommitted changes
echo -e "${YELLOW}[1/5] Checking for uncommitted changes...${NC}"
if [[ -n $(git status -s) ]]; then
    echo -e "${RED}ERROR: You have uncommitted changes. Commit or stash them first.${NC}"
    git status -s
    exit 1
fi
echo -e "${GREEN}OK${NC}"

# Step 2: Build release
echo ""
echo -e "${YELLOW}[2/5] Building release (this may take a few minutes)...${NC}"
npm run tauri build 2>&1 | tail -20

if [[ $? -ne 0 ]]; then
    echo -e "${RED}ERROR: Build failed!${NC}"
    exit 1
fi
echo -e "${GREEN}Build complete${NC}"

# Step 3: Launch the built app for manual testing
echo ""
echo -e "${YELLOW}[3/5] Launching built app for testing...${NC}"
echo -e "${YELLOW}Please verify the app:${NC}"
echo "  - Does it appear in the menu bar?"
echo "  - Can you click the tray icon?"
echo "  - Does it show the correct version ($VERSION)?"
echo "  - Can you upload a file?"
echo ""

# Find the app (handles both Intel and ARM)
APP_PATH="src-tauri/target/release/bundle/macos/StorageTo.app"
if [[ -d "$APP_PATH" ]]; then
    open "$APP_PATH"
else
    echo -e "${RED}ERROR: Built app not found at $APP_PATH${NC}"
    exit 1
fi

# Wait for user confirmation
echo -e "${YELLOW}Press ENTER after testing the app (or Ctrl+C to abort)...${NC}"
read

# Step 4: Ask for confirmation
echo ""
echo -e "${YELLOW}[4/5] Ready to release v$VERSION${NC}"
echo -e "${RED}WARNING: This will push to GitHub and trigger auto-updates for ALL users!${NC}"
echo ""
read -p "Are you sure you want to release v$VERSION? (type 'yes' to confirm): " CONFIRM

if [[ "$CONFIRM" != "yes" ]]; then
    echo -e "${YELLOW}Release cancelled.${NC}"
    exit 0
fi

# Step 5: Tag and push
echo ""
echo -e "${YELLOW}[5/5] Pushing release...${NC}"
git push origin main
git tag "v$VERSION"
git push origin "v$VERSION"

echo ""
echo -e "${GREEN}=== Release v$VERSION pushed! ===${NC}"
echo "Monitor the build at: https://github.com/storageto/desktop/actions"
echo ""
echo -e "${YELLOW}IMPORTANT: Watch the build and verify the release before closing this terminal.${NC}"
