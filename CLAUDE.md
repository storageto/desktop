# StorageTo Desktop - Claude Instructions

## ⛔ CRITICAL: NEVER PUSH UNTESTED CODE ⛔

**Auto-updates can BRICK the app for ALL users.** A broken release means:
- Users can't open the app
- They can't receive the fix via auto-update
- They must manually download from GitHub releases
- This is a CATASTROPHIC failure mode

### MANDATORY Before ANY Release:

1. **Build locally first:**
   ```bash
   npm run tauri build
   ```

2. **Test the BUILT app (not dev mode):**
   ```bash
   open src-tauri/target/release/bundle/macos/StorageTo.app
   ```

3. **Verify the app starts and basic functions work**

4. **Only then push and tag**

Or better, use the release script:
```bash
./scripts/release.sh
```

### Past Mistakes (NEVER REPEAT):

- **v0.2.9**: Used `tokio::spawn()` in Tauri setup - crashed on startup for ALL users
  - Fix: Use `tauri::async_runtime::spawn()` instead
  - Lesson: Tauri's setup runs before tokio runtime is ready

## Technical Notes

### Tauri Async Runtime

- In `setup()` callback, use `tauri::async_runtime::spawn()` NOT `tokio::spawn()`
- In `#[tauri::command]` async functions, `tokio::spawn()` is fine
- The difference: setup runs during app initialization before runtime is fully ready

### Webview fetch() To Remote Hosts Does Not Work

WKWebView enforces CORS for the `tauri://` origin and the storage.to API has no
preflight handling, so a webview `fetch()` to any remote API **silently never
delivers** (this is how analytics/error reporting was dead until v0.2.42, #18).
All remote HTTP belongs in Rust (`post_app_report` / reqwest via
`upload::api_client_builder`), exposed to the frontend as Tauri commands. The
CSP pins `connect-src 'self'` to make this structural - do not widen it.

### JavaScript Timers Don't Work When Hidden

This is a **menu bar app** - the window is hidden most of the time.
- `setInterval` and `setTimeout` do NOT fire reliably when window is hidden
- For background tasks (heartbeat, update checks), use Rust with `tauri::async_runtime::spawn()`

### Version Bumping

Update version in BOTH files (must match):
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`

### Auto-Update Flow

1. App checks `https://github.com/storageto/desktop/releases/latest/download/latest.json`
2. If newer version, downloads and installs
3. Calls `relaunch()` to restart
4. If new version crashes on startup → user is stuck

### Signing Keys

- Location: `~/.tauri/storageto.key` and `~/.tauri/storageto.key.pub`
- Password: stored in GitHub secrets (TAURI_SIGNING_PRIVATE_KEY_PASSWORD)
- **CRITICAL**: If keys are lost, auto-updates break for all existing users

## Project Structure

```
desktop/
├── src/                    # Frontend (React + TypeScript)
│   ├── App.tsx            # Main UI component
│   ├── main.tsx           # Entry point, update checker
│   ├── analyticsReporter.ts  # Usage tracking
│   └── errorReporter.ts   # Error tracking
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs         # Main Rust code, Tauri commands
│   │   ├── storage.rs     # Config persistence, visitor token
│   │   └── upload.rs      # Upload logic
│   ├── Cargo.toml         # Rust dependencies + VERSION
│   └── tauri.conf.json    # Tauri config + VERSION
├── scripts/
│   └── release.sh         # Safe release script (USE THIS)
└── RELEASING.md           # Release documentation
```

## Analytics

- Endpoint: `POST https://storage.to/api/app-analytics`
- Events: `app_launch`, `heartbeat`, `upload_complete`, `screenshot_complete`
- Visitor token stored in Rust config (`~/.config/storageto/storageto.json`)
- Heartbeat runs in Rust background task (every 60 min)

## Common Commands

```bash
# Development
npm run tauri dev

# Build release
npm run tauri build

# Safe release (ALWAYS USE THIS)
./scripts/release.sh
```
