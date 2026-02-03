# StorageTo Desktop

A lightweight menu bar/system tray app for macOS and Windows that allows drag-and-drop file uploads to storage.to.

## Features

- **System tray icon** - Lives in menu bar (macOS) / system tray (Windows)
- **Drag-and-drop upload** - Drop files onto the popup window
- **Folder upload** - Drop a folder to upload as a collection
- **Screenshot capture** - Global hotkey (Cmd+Shift+S / Ctrl+Shift+S)
- **Upload progress** - Visual progress indicator
- **Auto-copy URL** - Copies share link to clipboard on completion
- **Notifications** - Native OS notifications for upload status
- **Upload history** - List of recent uploads with quick actions

## Prerequisites

- [Rust](https://www.rust-lang.org/learn/get-started#installing-rust) (for building)
- [Node.js](https://nodejs.org/) 18+
- macOS 10.15+ or Windows 10+

## Development

```bash
# Install dependencies
npm install

# Start development server
npm run tauri dev
```

## Building

```bash
# Build for production
npm run tauri build

# Outputs:
# - macOS: src-tauri/target/release/bundle/dmg/StorageTo.dmg
# - Windows: src-tauri/target/release/bundle/msi/StorageTo.msi
```

## Project Structure

```
desktop/
├── src/                    # React frontend
│   ├── components/
│   │   ├── DropZone.tsx   # Drag-drop area
│   │   ├── UploadList.tsx # Active uploads with progress
│   │   └── History.tsx    # Upload history
│   ├── App.tsx            # Main app component
│   └── main.tsx           # Entry point
├── src-tauri/             # Rust backend
│   ├── src/
│   │   ├── main.rs        # Entry point
│   │   ├── lib.rs         # Tauri commands
│   │   ├── upload.rs      # Upload logic
│   │   └── storage.rs     # Config & history persistence
│   └── tauri.conf.json    # Tauri configuration
└── package.json
```

## Configuration

Config is stored in:
- macOS: `~/Library/Application Support/storageto/storageto.json`
- Windows: `%APPDATA%\storageto\storageto.json`

## Usage

1. Click the tray icon to open the upload window
2. Drag files or folders onto the drop zone
3. Or click "Upload Folder" to select a folder
4. URL is automatically copied to clipboard when upload completes
5. Click history items to copy URLs or open in browser

### Screenshot Capture

Press `Cmd+Shift+S` (macOS) or `Ctrl+Shift+S` (Windows) to capture a screenshot and automatically upload it.

## API Integration

Uses the same storage.to API as the CLI:

| Endpoint | Purpose |
|----------|---------|
| `POST /api/upload/init` | Get presigned URL |
| `POST /api/upload/confirm` | Create file record |
| `POST /api/collection` | Create collection |
| `POST /api/collection/{id}/ready` | Finalize collection |

Authentication uses `X-Visitor-Token` header (stored locally).
