import { useEffect, useState, useCallback } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { sendNotification, isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { DropZone } from "./components/DropZone";
import { History, HistoryItem, UploadItem } from "./components/History";
import { Settings } from "./components/Settings";
import { ToastContainer, useToast } from "./components/Toast";
import { Tooltip } from "./components/Tooltip";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { reportError } from "./errorReporter";
import { trackUploadComplete, trackScreenshotComplete } from "./analyticsReporter";
import { generateThumbnailIcons, uploadThumbnails } from "./videoThumbnail";

interface UploadProgress {
  file_id: string;
  filename: string;
  bytes_uploaded: number;
  total_bytes: number;
  percentage: number;
  status: string;
  collection_id?: string;
  collection_name?: string;
}

interface UploadResult {
  url: string;
  filename: string;
  size: number;
  is_collection: boolean;
  file_count?: number;
}

// Parse error messages from Rust backend, extracting human-readable parts
function parseErrorMessage(rawError: string): string {
  // Try to extract JSON from error message (handles "Upload init failed: {json}")
  const jsonMatch = rawError.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.error) {
        return parsed.error;
      }
    } catch {
      // JSON parse failed, continue to other methods
    }
  }

  // Try parsing the whole string as JSON
  try {
    const parsed = JSON.parse(rawError);
    if (parsed.error) {
      return parsed.error;
    }
  } catch {
    // Not JSON
  }

  // Clean up common prefixes if no JSON found
  const prefixes = ["Upload init failed: ", "Upload failed: ", "Upload confirmation failed: "];
  for (const prefix of prefixes) {
    if (rawError.startsWith(prefix)) {
      return rawError.slice(prefix.length);
    }
  }

  return rawError;
}

function App() {
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [updateReady, setUpdateReady] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { toasts, addToast, dismissToast } = useToast();

  // Derived: are there active uploads in progress?
  const hasActiveUploads = uploads.some(
    (u) => u.status === "queued" || u.status === "initializing" || u.status === "uploading" || u.status === "confirming"
  );

  // Cancel upload - signals Rust to stop and resets UI
  const cancelUpload = useCallback(async () => {
    console.log("[Upload] Cancel requested");
    try {
      await invoke("cancel_upload");
    } catch (e) {
      console.error("[Upload] Failed to signal cancel:", e);
    }
    setUploads([]);
  }, []);

  // Load history and version on mount
  useEffect(() => {
    loadHistory();
    getVersion().then(setAppVersion).catch(() => {});
  }, []);

  // Listen for update-ready event from Rust
  useEffect(() => {
    const unlisten = listen<string>("update-ready", (event) => {
      console.log("[Updater] Update ready:", event.payload);
      setUpdateReady(event.payload);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Listen for open-settings event from tray menu
  useEffect(() => {
    const unlisten = listen("open-settings", () => {
      setSettingsOpen(true);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Handle restart to apply update
  const handleRestartForUpdate = useCallback(async () => {
    try {
      await invoke("restart_app");
    } catch (e) {
      console.error("[Updater] Failed to restart:", e);
    }
  }, []);

  // Set up screenshot listener
  useEffect(() => {
    const unsubscribe = listen("screenshot-requested", async () => {
      await handleScreenshot();
    });

    return () => {
      unsubscribe.then((fn) => fn());
    };
  }, []);

  // Request notification permission
  useEffect(() => {
    async function requestNotificationPermission() {
      const granted = await isPermissionGranted();
      if (!granted) {
        await requestPermission();
      }
    }
    requestNotificationPermission();
  }, []);

  const loadHistory = async () => {
    try {
      const items = await invoke<HistoryItem[]>("get_upload_history");

      // Filter out items that expired more than 24 hours ago
      const now = new Date();
      const twentyFourHoursMs = 24 * 60 * 60 * 1000;

      const validItems = items.filter(item => {
        if (!item.expires_at) return true; // No expiry = keep
        const expiryDate = new Date(item.expires_at);
        const expiredForMs = now.getTime() - expiryDate.getTime();
        // Keep if not expired yet, or expired less than 24 hours ago
        return expiredForMs < twentyFourHoursMs;
      });

      // If we filtered any items, persist the cleanup
      if (validItems.length < items.length) {
        const removedUrls = items
          .filter(item => !validItems.includes(item))
          .map(item => item.url);

        // Remove from persistent storage
        for (const url of removedUrls) {
          await invoke("remove_from_history", { url }).catch(() => {});
        }
      }

      setHistory(validItems);
    } catch (err) {
      console.error("Failed to load history:", err);
    }
  };

  const showNotification = async (title: string, body: string) => {
    try {
      const granted = await isPermissionGranted();
      if (granted) {
        await sendNotification({ title, body });
      }
    } catch (err) {
      console.error("Failed to show notification:", err);
    }
  };

  const copyToClipboard = async (url: string) => {
    try {
      await writeText(url);
    } catch (err) {
      console.error("Failed to copy to clipboard:", err);
    }
  };

  const handleProgress = useCallback((progress: UploadProgress) => {
    setUploads((prev) => {
      const item: UploadItem = {
        id: progress.file_id,
        filename: progress.filename,
        bytesUploaded: progress.bytes_uploaded,
        totalBytes: progress.total_bytes,
        percentage: progress.percentage,
        status: progress.status as UploadItem["status"],
        collectionId: progress.collection_id,
        collectionName: progress.collection_name,
      };

      const existing = prev.find((u) => u.id === progress.file_id);
      if (existing) {
        return prev.map((u) => (u.id === progress.file_id ? item : u));
      }
      return [...prev, item];
    });
  }, []);

  const handleFilesSelected = async (paths: string[]) => {
    console.log("[Upload] handleFilesSelected called, paths:", paths);

    try {
      // First, try as folder upload (Rust will check if it's actually a directory)
      if (paths.length === 1) {
        try {
          const channel = new Channel<UploadProgress>();
          channel.onmessage = handleProgress;

          const result = await invoke<UploadResult>("upload_folder", {
            folderPath: paths[0],
            onProgress: channel,
          });

          // Success - was a folder
          await copyToClipboard(result.url);
          await showNotification(
            "Collection uploaded",
            `${result.file_count} files uploaded - URL copied!`
          );

          // Track analytics
          trackUploadComplete({
            fileCount: result.file_count || 1,
            totalSize: result.size,
            isCollection: true,
          });

          // Refresh history first, then clear uploads so file doesn't vanish
          await loadHistory();
          setUploads([]);
          return;
        } catch {
          // Not a folder, continue with file upload
        }
      }

      // Upload as files (single file or multiple files as collection)
      const channel = new Channel<UploadProgress>();
      channel.onmessage = handleProgress;

      const results = await invoke<UploadResult[]>("upload_files", {
        paths,
        onProgress: channel,
      });

      if (results.length > 0) {
        // Separate individual file results from the collection result
        const fileResults = results.filter(r => !r.is_collection);
        const lastResult = results[results.length - 1];
        await copyToClipboard(lastResult.url);

        if (fileResults.length <= 1 && !lastResult.is_collection) {
          await showNotification("Upload complete", `${lastResult.filename} - URL copied!`);
        } else {
          const count = lastResult.file_count || fileResults.length;
          await showNotification(
            "Uploads complete",
            `${count} files uploaded - URL copied!`
          );
        }

        // Track analytics (use file results to avoid double-counting collection)
        const totalSize = fileResults.reduce((sum, r) => sum + r.size, 0) || lastResult.size;
        trackUploadComplete({
          fileCount: fileResults.length || 1,
          totalSize,
          isCollection: lastResult.is_collection,
        });

        // Generate thumbnail icons locally (fast) before loading history
        const fileUrls = fileResults.map(r => r.url);
        let thumbnailBlobs = new Map<string, Blob>();
        if (fileUrls.length > 0) {
          thumbnailBlobs = await generateThumbnailIcons(paths, fileUrls).catch((e) => {
            reportError({ type: "thumbnail", message: `generateThumbnailIcons crashed: ${e}`, stack: e instanceof Error ? e.stack : undefined, context: { step: "app_catch", fileCount: paths.length } });
            return new Map();
          });
        }

        // Refresh history (icons already saved, so thumbnails show immediately)
        await loadHistory();
        setUploads([]);

        // Upload full thumbnails to API in background (slow, fire-and-forget)
        if (thumbnailBlobs.size > 0) {
          uploadThumbnails(thumbnailBlobs).catch(() => {});
        }
      }
    } catch (err) {
      console.error("Upload failed:", err);

      // Parse error message - extract human-readable part from JSON if present
      const errorMsg = parseErrorMessage(String(err));

      // Report to error tracking
      reportError({
        type: "upload_error",
        message: errorMsg,
        stack: err instanceof Error ? err.stack : undefined,
        context: {
          fileCount: paths.length,
        },
      });

      // Mark all pending/uploading items as error
      setUploads((prev) =>
        prev.map((u) =>
          u.status === "queued" || u.status === "initializing" || u.status === "uploading"
            ? { ...u, status: "error" as const, error: errorMsg }
            : u
        )
      );

      await showNotification("Upload failed", errorMsg);
    }
  };

  const handleScreenshot = async () => {
    // Hide our window so it's not in the screenshot
    const window = getCurrentWindow();
    await window.hide();

    // Small delay to ensure window is hidden
    await new Promise((resolve) => setTimeout(resolve, 200));

    try {
      // Take screenshot using native OS tool (region selection on macOS)
      const screenshotPath = await invoke<string>("take_screenshot");

      // Show window again before uploading
      await window.show();

      // Upload the screenshot
      const channel = new Channel<UploadProgress>();
      channel.onmessage = handleProgress;

      const result = await invoke<UploadResult>("upload_single_file", {
        path: screenshotPath,
        onProgress: channel,
      });

      await copyToClipboard(result.url);
      await showNotification("Screenshot uploaded", "URL copied to clipboard!");

      // Track analytics
      trackScreenshotComplete();

      // Generate and upload thumbnail (same as regular image uploads)
      const thumbnailBlobs = await generateThumbnailIcons([screenshotPath], [result.url]).catch(() => new Map<string, Blob>());

      // Refresh history first, then clear uploads so file doesn't vanish
      await loadHistory();
      setUploads([]);

      if (thumbnailBlobs.size > 0) {
        uploadThumbnails(thumbnailBlobs).catch(() => {});
      }
    } catch (err) {
      console.error("[Screenshot] Error:", err);
      const rawError = String(err);

      // Show window again if hidden
      await window.show();

      // "Screenshot cancelled" is user-initiated, not an error
      if (rawError.includes("cancelled")) {
        console.log("[Screenshot] User cancelled screenshot");
        return;
      }

      // Report to error tracking (but not permission/unsupported errors)
      if (!rawError.includes("not supported") && !rawError.includes("not yet supported")) {
        reportError({
          type: "screenshot_error",
          message: rawError,
          stack: err instanceof Error ? err.stack : undefined,
        });
      }

      const errorMsg = parseErrorMessage(rawError);
      await showNotification("Screenshot failed", errorMsg);
    }
  };

  const handleDeleteFile = async (fileId: string, url: string, isCollection: boolean) => {
    try {
      await invoke("delete_uploaded_file", { fileId, url, isCollection });
      // Remove from local state
      setHistory((prev) => prev.filter((item) => item.url !== url));
      addToast({ title: "Deleted", description: "File removed from storage.to", type: "success" });
    } catch (err) {
      console.error("Failed to delete file:", err);
      addToast({ title: "Failed to delete", type: "error" });
      throw err;
    }
  };

  // Helper to construct URL from file ID
  const getUrlFromFileId = (fileId: string, isCollection: boolean): string => {
    return isCollection
      ? `https://storage.to/c/${fileId}`
      : `https://storage.to/${fileId}`;
  };

  // Update local history item state
  const updateHistoryItem = (url: string, updates: Partial<HistoryItem>) => {
    setHistory((prev) =>
      prev.map((item) =>
        item.url === url ? { ...item, ...updates } : item
      )
    );
  };

  // Optimistic UI update, but only show toast after API confirms
  const handleRemovePassword = async (fileId: string, isCollection: boolean) => {
    const url = getUrlFromFileId(fileId, isCollection);

    // Optimistic: update UI immediately (no toast yet)
    updateHistoryItem(url, { password_protected: false });

    try {
      // Wait for API confirmation
      await invoke("remove_file_password", { fileId, isCollection });

      // Success - update local storage and show toast
      await invoke("update_history_protection", {
        url,
        passwordProtected: false,
        burnAfterReading: null,
        expiresAt: null,
      });
      addToast({ title: "Password removed", type: "success" });
    } catch (err) {
      console.error("Failed to remove password:", err);
      // Revert on failure
      updateHistoryItem(url, { password_protected: true });
      addToast({ title: "Failed to remove password", description: "Please try again", type: "error" });
    }
  };

  const handleRemoveBurnAfterReading = async (fileId: string, isCollection: boolean) => {
    const url = getUrlFromFileId(fileId, isCollection);

    // Optimistic: update UI immediately (no toast yet)
    updateHistoryItem(url, { burn_after_reading: false });

    try {
      // Wait for API confirmation
      await invoke("remove_file_burn_after_reading", { fileId, isCollection });

      // Success - update local storage and show toast
      await invoke("update_history_protection", {
        url,
        passwordProtected: null,
        burnAfterReading: false,
        expiresAt: null,
      });
      addToast({ title: "Burn after reading disabled", type: "success" });
    } catch (err) {
      console.error("Failed to remove burn after reading:", err);
      const errorStr = String(err);

      // Check if file was already downloaded and deleted
      if (errorStr.includes("404") || errorStr.includes("not found") || errorStr.includes("expired")) {
        // File is gone - remove from history
        setHistory((prev) => prev.filter((item) => item.url !== url));
        addToast({ title: "File already downloaded", description: "Removed from history", type: "info" });
      } else {
        // Revert on other failures
        updateHistoryItem(url, { burn_after_reading: true });
        addToast({ title: "Failed to disable burn after reading", description: "Please try again", type: "error" });
      }
    }
  };

  const handleSetPassword = async (fileId: string, isCollection: boolean, password: string) => {
    const url = getUrlFromFileId(fileId, isCollection);

    // Optimistic: update UI immediately (no toast yet)
    updateHistoryItem(url, { password_protected: true });

    try {
      // Wait for API confirmation
      await invoke("set_file_password", { fileId, isCollection, password });

      // Success - update local storage and show toast
      await invoke("update_history_protection", {
        url,
        passwordProtected: true,
        burnAfterReading: null,
        expiresAt: null,
      });
      addToast({ title: "Password set", description: "File is now password protected", type: "success" });
    } catch (err) {
      console.error("Failed to set password:", err);
      // Revert on failure
      updateHistoryItem(url, { password_protected: false });
      addToast({ title: "Failed to set password", description: "Please try again", type: "error" });
    }
  };

  const handleSetExpiry = async (fileId: string, isCollection: boolean, days: number) => {
    const url = getUrlFromFileId(fileId, isCollection);

    // Calculate expiry date
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + days);
    const expiresAtStr = expiresAt.toISOString();

    // Optimistic: update UI immediately (no toast yet)
    updateHistoryItem(url, { expires_at: expiresAtStr });

    try {
      // Wait for API confirmation
      await invoke("set_file_expiry", { fileId, isCollection, days });

      // Success - update local storage and show toast
      await invoke("update_history_protection", {
        url,
        passwordProtected: null,
        burnAfterReading: null,
        expiresAt: expiresAtStr,
      });
      addToast({ title: "Expiry updated", description: `Expires in ${days} day${days > 1 ? 's' : ''}`, type: "success" });
    } catch (err) {
      console.error("Failed to set expiry:", err);
      // Revert on failure
      updateHistoryItem(url, { expires_at: undefined });
      addToast({ title: "Failed to set expiry", description: "Please try again", type: "error" });
    }
  };

  const handleSetBurnAfterReading = async (fileId: string, isCollection: boolean) => {
    const url = getUrlFromFileId(fileId, isCollection);

    // Optimistic: update UI immediately (no toast yet)
    updateHistoryItem(url, { burn_after_reading: true });

    try {
      // Wait for API confirmation
      await invoke("set_file_burn_after_reading", { fileId, isCollection });

      // Success - update local storage and show toast
      await invoke("update_history_protection", {
        url,
        passwordProtected: null,
        burnAfterReading: true,
        expiresAt: null,
      });
      addToast({ title: "Burn after reading", description: "Deleted after first download", type: "success" });
    } catch (err) {
      console.error("Failed to set burn after reading:", err);
      // Revert on failure
      updateHistoryItem(url, { burn_after_reading: false });
      addToast({ title: "Failed to set burn after reading", description: "Please try again", type: "error" });
    }
  };

  const isWindows = navigator.userAgent.includes("Windows");

  return (
    <div className="flex flex-col h-screen">
      {/* Small notch pointing to tray - top on macOS, bottom on Windows */}
      {!isWindows && (
        <div className="flex justify-center h-2 relative z-10">
          <svg width="16" height="8" viewBox="0 0 16 8" className="drop-shadow-sm">
            <path d="M0 8 L6 2 Q8 0 10 2 L16 8 Z" fill="#1c1917" />
          </svg>
        </div>
      )}

      {/* Main window */}
      <div className={`flex-1 flex flex-col bg-[#0c0a09] rounded-2xl overflow-hidden border border-[#292524] shadow-2xl relative ${isWindows ? '-mb-px' : '-mt-px'}`}>
        {/* Header */}
        <div
          className="flex items-center justify-between px-3 py-2 bg-[#1c1917] border-b border-[#292524]"
          data-tauri-drag-region
        >
          <div className="flex items-center gap-1.5" data-tauri-drag-region>
            <span className="font-semibold text-white text-base tracking-tight" data-tauri-drag-region>
              storage<span className="text-pink-400">.to</span>
            </span>
            {appVersion && (
              <span className="text-[10px] text-stone-500" data-tauri-drag-region>
                v{appVersion}
              </span>
            )}
            {updateReady && (
              <Tooltip text={`v${updateReady} ready - click to restart`} position="bottom">
                <button
                  onClick={handleRestartForUpdate}
                  className="ml-1 px-1.5 py-0.5 text-[10px] font-medium bg-pink-500/20 text-pink-400 hover:bg-pink-500/30 hover:text-pink-300 rounded transition-colors cursor-pointer"
                >
                  Update
                </button>
              </Tooltip>
            )}
          </div>

          <div className="flex items-center gap-1">
            {hasActiveUploads ? (
              <Tooltip text="Cancel upload" position="bottom">
                <button
                  onClick={cancelUpload}
                  className="h-8 px-3 flex items-center justify-center gap-1.5 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-400 hover:text-red-300 transition-colors cursor-pointer text-xs font-medium"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                  Cancel
                </button>
              </Tooltip>
            ) : (
              <>
                <Tooltip text="Settings" position="bottom">
                  <button
                    onClick={() => setSettingsOpen(true)}
                    className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-[#292524] text-[#a8a29e] hover:text-white transition-colors cursor-pointer"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  </button>
                </Tooltip>
                <Tooltip text="Screenshot" position="bottom">
                  <button
                    onClick={handleScreenshot}
                    className="w-8 h-8 flex items-center justify-center rounded-lg bg-[#292524] hover:bg-[#3f3f46] text-[#a8a29e] hover:text-white transition-colors cursor-pointer"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  </button>
                </Tooltip>
              </>
            )}
          </div>
        </div>

        {/* Drop Zone */}
        <DropZone onFilesSelected={handleFilesSelected} disabled={false} />

        {/* Uploads & History (unified list) */}
        <History
          items={history}
          uploads={uploads}
          onDelete={handleDeleteFile}
          onClearUploads={() => { setUploads([]); }}
          onSetPassword={handleSetPassword}
          onRemovePassword={handleRemovePassword}
          onSetExpiry={handleSetExpiry}
          onSetBurnAfterReading={handleSetBurnAfterReading}
          onRemoveBurnAfterReading={handleRemoveBurnAfterReading}
        />

        {/* Settings panel (slides over content) */}
        <Settings
          isOpen={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          appVersion={appVersion}
          addToast={addToast}
        />

        {/* In-app toast notifications */}
        <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      </div>

      {/* Notch pointing down to taskbar on Windows */}
      {isWindows && (
        <div className="flex justify-center h-2 relative z-10">
          <svg width="16" height="8" viewBox="0 0 16 8" className="drop-shadow-sm">
            <path d="M0 0 L6 6 Q8 8 10 6 L16 0 Z" fill="#1c1917" />
          </svg>
        </div>
      )}
    </div>
  );
}

export default App;
