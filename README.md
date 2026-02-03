# StorageTo Desktop

A lightweight menu bar app for quickly uploading and sharing files via [storage.to](https://storage.to).

## Download

**[Download the latest release →](https://github.com/storageto/desktop/releases/latest)**

- **macOS**: Download the `.dmg` file, open it, and drag StorageTo to your Applications folder
- **Windows**: Download the `.msi` installer and run it

## Features

- **Menu bar access** - Lives in your menu bar (macOS) or system tray (Windows)
- **Drag and drop** - Drop files or folders to upload instantly
- **Screenshot capture** - Press `Cmd+Shift+S` (macOS) or `Ctrl+Shift+S` (Windows)
- **Auto-copy links** - Share URLs are copied to your clipboard automatically
- **Upload history** - Quick access to recent uploads
- **Password protection** - Optionally protect uploads with a password
- **Expiry control** - Set custom expiration times

## Usage

1. Click the StorageTo icon in your menu bar
2. Drag files or folders onto the window
3. The share link is automatically copied to your clipboard

## Requirements

- macOS 10.15+ or Windows 10+

---

<details>
<summary>Development</summary>

```bash
npm install
npm run tauri dev
```

Build: `npm run tauri build`

</details>
