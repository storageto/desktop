import { useEffect, useState, useCallback } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { sendNotification, isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { DropZone } from "./components/DropZone";
import { History, HistoryItem, UploadItem } from "./components/History";
import { ToastContainer, useToast } from "./components/Toast";
import { Tooltip } from "./components/Tooltip";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getScreenshotableMonitors, getMonitorScreenshot } from "tauri-plugin-screenshots-api";
import { checkScreenRecordingPermission, requestScreenRecordingPermission } from "tauri-plugin-macos-permissions-api";

interface UploadProgress {
  file_id: string;
  filename: string;
  bytes_uploaded: number;
  total_bytes: number;
  percentage: number;
  status: string;
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
  const [isUploading, setIsUploading] = useState(false);
  const { toasts, addToast, dismissToast } = useToast();

  // Load history on mount
  useEffect(() => {
    loadHistory();
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
      };

      const existing = prev.find((u) => u.id === progress.file_id);
      if (existing) {
        return prev.map((u) => (u.id === progress.file_id ? item : u));
      }
      return [...prev, item];
    });
  }, []);

  const handleFilesSelected = async (paths: string[]) => {
    console.log("[Upload] handleFilesSelected called, isUploading:", isUploading, "paths:", paths);
    if (isUploading) {
      console.log("[Upload] Blocked - already uploading");
      return;
    }

    setIsUploading(true);
    console.log("[Upload] Starting upload...");

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

          // Clear uploads and refresh history
          setUploads([]);
          await loadHistory();
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
        // Copy the first (or only) URL to clipboard
        const lastResult = results[results.length - 1];
        await copyToClipboard(lastResult.url);

        if (results.length === 1) {
          await showNotification("Upload complete", `${lastResult.filename} - URL copied!`);
        } else {
          await showNotification(
            "Uploads complete",
            `${results.length} files uploaded - Last URL copied!`
          );
        }

        // Clear uploads and refresh history
        setUploads([]);
        await loadHistory();
      }
    } catch (err) {
      console.error("Upload failed:", err);

      // Parse error message - extract human-readable part from JSON if present
      const errorMsg = parseErrorMessage(String(err));

      // Mark all pending/uploading items as error
      setUploads((prev) =>
        prev.map((u) =>
          u.status === "queued" || u.status === "initializing" || u.status === "uploading"
            ? { ...u, status: "error" as const, error: errorMsg }
            : u
        )
      );

      await showNotification("Upload failed", errorMsg);
    } finally {
      console.log("[Upload] Finally block - resetting isUploading to false");
      setIsUploading(false);
    }
  };

  const handleScreenshot = async () => {
    if (isUploading) return;

    setIsUploading(true);

    try {
      // Check screen recording permission on macOS
      try {
        const hasPermission = await checkScreenRecordingPermission();

        if (!hasPermission) {
          // Request permission - this opens System Settings
          await requestScreenRecordingPermission();
          await showNotification(
            "Permission required",
            "Enable Screen Recording for StorageTo in System Settings, then try again."
          );
          setIsUploading(false);
          return;
        }
      } catch {
        // Permission check failed (maybe not on macOS), continue anyway
      }

      // Hide our window so it's not in the screenshot
      const window = getCurrentWindow();
      await window.hide();

      // Small delay to ensure window is hidden
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Get available monitors
      const monitors = await getScreenshotableMonitors();

      if (monitors.length === 0) {
        throw new Error("No monitors found. Please grant Screen Recording permission.");
      }

      // Capture the primary monitor (first one)
      const screenshotPath = await getMonitorScreenshot(monitors[0].id);

      // Show window again
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

      // Clear uploads and refresh history
      setUploads([]);
      await loadHistory();
    } catch (err) {
      console.error("[Screenshot] Error:", err);
      const rawError = String(err);
      // Show helpful error for permission issues
      if (rawError.includes("No monitors") || rawError.includes("permission")) {
        await showNotification("Screenshot failed", "Grant Screen Recording permission in System Settings.");
      } else {
        const errorMsg = parseErrorMessage(rawError);
        await showNotification("Screenshot failed", errorMsg);
      }
      // Show window again
      const window = getCurrentWindow();
      await window.show();
    } finally {
      setIsUploading(false);
    }
  };

  const handleClearHistory = async () => {
    try {
      await invoke("clear_upload_history");
      setHistory([]);
    } catch (err) {
      console.error("Failed to clear history:", err);
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

  return (
    <div className="flex flex-col h-screen">
      {/* Small notch pointing to tray */}
      <div className="flex justify-center h-2 relative z-10">
        <svg width="16" height="8" viewBox="0 0 16 8" className="drop-shadow-sm">
          <path d="M0 8 L6 2 Q8 0 10 2 L16 8 Z" fill="#1c1917" />
        </svg>
      </div>

      {/* Main window */}
      <div className="flex-1 flex flex-col bg-[#0c0a09] rounded-2xl overflow-hidden border border-[#292524] shadow-2xl -mt-px relative">
        {/* Header */}
        <div
          className="flex items-center justify-between px-3 py-2 bg-[#1c1917] border-b border-[#292524]"
          data-tauri-drag-region
        >
          <div className="flex items-center" data-tauri-drag-region>
            <span className="font-semibold text-white text-base tracking-tight" data-tauri-drag-region>
              storage<span className="text-pink-400">.to</span>
            </span>
          </div>

          <Tooltip text="Screenshot" position="bottom">
            <button
              onClick={handleScreenshot}
              disabled={isUploading}
              className="w-8 h-8 flex items-center justify-center rounded-lg bg-[#292524] hover:bg-[#3f3f46] text-[#a8a29e] hover:text-white transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
          </Tooltip>
        </div>

        {/* Drop Zone */}
        <DropZone onFilesSelected={handleFilesSelected} disabled={isUploading} />

        {/* Uploads & History (unified list) */}
        <History
          items={history}
          uploads={uploads}
          onClear={handleClearHistory}
          onDelete={handleDeleteFile}
          onClearUploads={() => { setUploads([]); setIsUploading(false); }}
          onSetPassword={handleSetPassword}
          onRemovePassword={handleRemovePassword}
          onSetExpiry={handleSetExpiry}
          onSetBurnAfterReading={handleSetBurnAfterReading}
          onRemoveBurnAfterReading={handleRemoveBurnAfterReading}
        />

        {/* In-app toast notifications */}
        <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      </div>
    </div>
  );
}

export default App;
