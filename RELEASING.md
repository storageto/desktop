# Releasing StorageTo Desktop

## CRITICAL: Never Push Untested Code

Auto-updates mean **every user gets your changes immediately**. A broken release can brick the app for all users with no recovery path (they can't even open the app to get the fix).

## Release Checklist

### Option A: Use the Release Script (Recommended)

```bash
./scripts/release.sh
```

This script will:
1. Check for uncommitted changes
2. Build the release locally
3. Launch the app for manual testing
4. Ask for confirmation before pushing
5. Tag and push the release

### Option B: Manual Process

1. **Build locally first:**
   ```bash
   npm run tauri build
   ```

2. **Test the built app (NOT dev mode):**
   ```bash
   open src-tauri/target/release/bundle/macos/StorageTo.app
   ```

3. **Verify these work:**
   - [ ] App appears in menu bar
   - [ ] Tray icon is clickable
   - [ ] Window opens correctly
   - [ ] Version number is correct
   - [ ] Can upload a file
   - [ ] Settings work

4. **Only after testing passes:**
   ```bash
   git push origin main
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

## Version Bumping

Update version in BOTH files:
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`

## If a Bad Release Goes Out

1. **Immediately** push a fix with a new version
2. Users with broken apps must manually download from GitHub releases:
   https://github.com/storageto/desktop/releases
3. Consider posting on social media/support channels

## Common Crash Causes

- Using `tokio::spawn` in setup (use `tauri::async_runtime::spawn`)
- Missing native dependencies
- Incorrect plugin initialization order
- Panics in synchronous code paths
