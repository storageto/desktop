import { useEffect, useState, useCallback, useRef } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { sendNotification, isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { openUrl } from "@tauri-apps/plugin-opener";
import { DropZone } from "./components/DropZone";
import { StatusBar } from "./components/StatusBar";
import { History, HistoryItem, UploadItem, QrModal } from "./components/History";
import { Settings } from "./components/Settings";
import { ToastContainer, useToast } from "./components/Toast";
import { Tooltip } from "./components/Tooltip";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { reportError } from "./errorReporter";
import { trackUploadComplete, trackScreenshotComplete } from "./analyticsReporter";

interface UploadProgress {
  file_id: string;
  filename: string;
  bytes_uploaded: number;
  total_bytes: number;
  percentage: number;
  status: string;
  collection_id?: string;
  collection_name?: string;
  /** Set when the server refused the file, so the row can say why. */
  error?: string;
}

interface UploadResult {
  url: string;
  filename: string;
  size: number;
  is_collection: boolean;
  file_count?: number;
  /** Files the user asked for, when the Rust side counted them (folders). */
  attempted_count?: number;
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
  // Monotonic counter so out-of-order server responses (e.g. slow q="a"
  // landing after fast q="ab") can be ignored — we only apply a result if
  // its sequence number is still the most recent request we issued.
  const fetchSeqRef = useRef(0);
  // Parent owns the search box so focus-refreshes, debounced search, and the
  // initial load all flow through a single fetcher.
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  // Cached last "no-query" list so clearing the search restores the full list
  // instantly instead of flashing an empty state while the network catches up.
  const fullListRef = useRef<HistoryItem[]>([]);
  // True once we've got at least one successful server response, so we don't
  // flash the "No recent uploads" splash before the first fetch has returned.
  const hasLoadedRef = useRef(false);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [updateReady, setUpdateReady] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isPremium, setIsPremium] = useState(false);
  // Auto-show-on-complete QR modal (opt-in setting). Null when hidden.
  const [qrModal, setQrModal] = useState<{ url: string; filename: string } | null>(null);
  // Bumped whenever quota state may have changed (upload done/failed, login),
  // so the status bar re-fetches /api/limits.
  const [limitsRefresh, setLimitsRefresh] = useState(0);
  const bumpLimits = useCallback(() => setLimitsRefresh((n) => n + 1), []);
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

  // Unified fetcher. Honours whatever's currently in the search box, ignores
  // out-of-order responses, and leaves state untouched on failure so offline
  // users keep seeing their last good list.
  const fetchHistory = useCallback(async (query: string | null) => {
    const seq = ++fetchSeqRef.current;
    setIsSearching(true);
    try {
      const items = await invoke<HistoryItem[]>("fetch_remote_history", { query });
      if (seq !== fetchSeqRef.current) return;
      if (!query) fullListRef.current = items;
      setHistory(items);
      hasLoadedRef.current = true;
    } catch (err) {
      if (seq === fetchSeqRef.current) console.warn("history fetch failed:", err);
    } finally {
      if (seq === fetchSeqRef.current) setIsSearching(false);
    }
  }, []);

  // First paint: show local cache instantly, then swap in server truth.
  // After the first successful fetch the local cache is never shown again.
  const hydrateFromLocalCache = useCallback(async () => {
    try {
      const items = await invoke<HistoryItem[]>("get_upload_history");
      const now = Date.now();
      const cutoff = 24 * 60 * 60 * 1000;
      const valid = items.filter((item) => {
        if (!item.expires_at) return true;
        return now - new Date(item.expires_at).getTime() < cutoff;
      });
      if (valid.length < items.length) {
        for (const it of items) {
          if (!valid.includes(it)) await invoke("remove_from_history", { url: it.url }).catch(() => {});
        }
      }
      setHistory((prev) => (prev.length ? prev : valid));
    } catch (err) {
      console.warn("local history load failed:", err);
    }
  }, []);

  // Load history and version on mount
  useEffect(() => {
    hydrateFromLocalCache();
    fetchHistory(null);
    getVersion().then(setAppVersion).catch(() => {});
    invoke<{ logged_in: boolean; is_premium?: boolean }>("get_auth_status")
      .then((s) => setIsPremium(s.logged_in && (s.is_premium ?? false)))
      .catch(() => {});
  }, [hydrateFromLocalCache, fetchHistory]);

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

  // Any auth change (login via deep link, logout from Settings) swaps which
  // history the server returns (account files vs visitor files), so refresh
  // premium state, the limits bar AND the list immediately - not on next focus.
  const handleAuthChanged = useCallback(() => {
    invoke<{ logged_in: boolean; is_premium?: boolean }>("get_auth_status")
      .then((s) => setIsPremium(s.logged_in && (s.is_premium ?? false)))
      .catch(() => {});
    bumpLimits();
    fullListRef.current = [];
    fetchHistory(searchQuery.trim() || null);
  }, [bumpLimits, fetchHistory, searchQuery]);

  // Refresh after login
  useEffect(() => {
    const unlisten = listen("auth-token-received", handleAuthChanged);
    return () => { unlisten.then((fn) => fn()); };
  }, [handleAuthChanged]);

  // Listen for open-settings event from tray menu
  useEffect(() => {
    const unlisten = listen("open-settings", () => {
      setSettingsOpen(true);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Refresh history when the window gains focus (user reopened the menu bar
  // panel) so web/CLI uploads made while it was hidden show up. Respects the
  // current search so focus doesn't clobber filtered results.
  useEffect(() => {
    const onFocus = () => { fetchHistory(searchQuery.trim() || null); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [fetchHistory, searchQuery]);

  // Debounced search: whenever the user pauses typing, fetch with the current
  // query (or null to restore the full list). Clearing the query does an
  // instant restore from the cached full list so the panel doesn't flash
  // the empty splash while the re-fetch is in flight.
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q && fullListRef.current.length) {
      setHistory(fullListRef.current);
    }
    const timer = setTimeout(() => fetchHistory(q || null), 250);
    return () => clearTimeout(timer);
  }, [searchQuery, fetchHistory]);

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

  // When the "Show QR code on upload complete" setting is on, pop the QR modal
  // front-and-center the instant an upload finishes so the user can scan it on
  // their phone. Reads the setting fresh each time so a toggle mid-session is
  // respected without extra wiring.
  const maybeShowQrOnComplete = async (url: string, filename: string) => {
    try {
      const cfg = await invoke<{ show_qr_on_complete: boolean }>("get_config");
      if (cfg.show_qr_on_complete) {
        setQrModal({ url, filename });
      }
    } catch (err) {
      console.error("Failed to read QR-on-complete setting:", err);
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
        error: progress.error,
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
          // A shortfall has to be in the headline. Saying "382 files uploaded"
          // when 425 were asked for is how 43 missing files stayed unnoticed
          // until a customer counted them by hand.
          const landed = result.file_count ?? 0;
          const asked = result.attempted_count ?? landed;
          const short = asked - landed;
          await showNotification(
            short > 0 ? "Collection uploaded, some files failed" : "Collection uploaded",
            short > 0
              ? `${landed} of ${asked} files uploaded, ${short} failed - URL copied!`
              : `${landed} files uploaded - URL copied!`
          );

          // Track analytics
          trackUploadComplete({
            fileCount: result.file_count || 1,
            // The folder's own count, not paths.length - a folder drop hands
            // over ONE path, so paths.length is 1 no matter how many files.
            attemptedCount: result.attempted_count ?? result.file_count ?? 1,
            totalSize: result.size,
            isCollection: true,
          });

          // Refresh history first, then clear uploads so file doesn't vanish.
          // Failed rows STAY: they carry the only per-file reason the user ever
          // sees, and clearing them the instant the collection finishes threw
          // that away at exactly the moment it was worth reading.
          await fetchHistory(searchQuery.trim() || null);
          setUploads((prev) => prev.filter((u) => u.status === "error"));
          bumpLimits();
          await maybeShowQrOnComplete(result.url, result.filename);
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
          // Same rule as the folder path: a shortfall belongs in the headline,
          // not only in the rows behind it.
          const asked = lastResult.attempted_count ?? paths.length;
          const short = asked - count;
          await showNotification(
            short > 0 ? "Uploads complete, some files failed" : "Uploads complete",
            short > 0
              ? `${count} of ${asked} files uploaded, ${short} failed - URL copied!`
              : `${count} files uploaded - URL copied!`
          );
        }

        // Track analytics (use file results to avoid double-counting collection)
        const totalSize = fileResults.reduce((sum, r) => sum + r.size, 0) || lastResult.size;
        trackUploadComplete({
          fileCount: fileResults.length || 1,
          // A multi-file selection: one path per file, so paths.length is the
          // real attempted count. lastResult carries it too when Rust counted.
          attemptedCount: lastResult.attempted_count ?? paths.length,
          totalSize,
          isCollection: lastResult.is_collection,
        });

        // Refresh history — server generates thumbnails async, will appear on next focus.
        // Failed rows stay, so their reasons survive the success.
        await fetchHistory(searchQuery.trim() || null);
        setUploads((prev) => prev.filter((u) => u.status === "error"));
        bumpLimits();
        await maybeShowQrOnComplete(lastResult.url, lastResult.filename);
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

      // The anonymous daily cap (429): prompt to create a free account instead
      // of a generic failure. The status bar turns red via bumpLimits below.
      if (errorMsg.startsWith("Daily upload limit reached")) {
        addToast({
          title: "Daily limit reached",
          description: errorMsg,
          type: "error",
          action: {
            label: "Create free account",
            onClick: () => {
              openUrl("https://storage.to/register?desktop=1").catch(() => {});
            },
          },
        });
      }

      bumpLimits();
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

      // Refresh history — server generates thumbnails async, will appear on next focus
      await fetchHistory(searchQuery.trim() || null);
      setUploads([]);
      bumpLimits();
      await maybeShowQrOnComplete(result.url, result.filename);
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

  const handleSetExpiry = async (fileId: string, isCollection: boolean, days: number | null) => {
    const url = getUrlFromFileId(fileId, isCollection);
    const isPermanent = days === null;

    // Optimistic UI update
    if (isPermanent) {
      updateHistoryItem(url, { expires_at: undefined });
    } else {
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + days!);
      updateHistoryItem(url, { expires_at: expiresAt.toISOString() });
    }

    try {
      await invoke("set_file_expiry", { fileId, isCollection, days });

      const expiresAtStr = isPermanent ? null : (() => {
        const d = new Date();
        d.setDate(d.getDate() + days!);
        return d.toISOString();
      })();

      await invoke("update_history_protection", {
        url,
        passwordProtected: null,
        burnAfterReading: null,
        expiresAt: expiresAtStr,
      });

      addToast({
        title: "Expiry updated",
        description: isPermanent ? "File will never expire" : `Expires in ${days} day${days! > 1 ? 's' : ''}`,
        type: "success",
      });
    } catch (err) {
      console.error("Failed to set expiry:", err);
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
                    className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-[#292524] text-[#a8a29e] hover:text-white transition-colors cursor-pointer"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  </button>
                </Tooltip>
                <Tooltip text="Close" position="bottom">
                  <button
                    onClick={() => getCurrentWindow().hide()}
                    className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-[#292524] text-[#a8a29e] hover:text-white transition-colors cursor-pointer"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
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
          isPremium={isPremium}
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          isSearching={isSearching}
        />

        {/* Account/limits status bar (Dropbox-style, pinned to the bottom) */}
        <StatusBar refreshKey={limitsRefresh} />

        {/* Settings panel (slides over content) */}
        <Settings
          isOpen={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          appVersion={appVersion}
          addToast={addToast}
          onAuthChanged={handleAuthChanged}
        />

        {/* Auto-shown QR code (on upload complete, when the setting is on) */}
        {qrModal && (
          <QrModal url={qrModal.url} filename={qrModal.filename} onClose={() => setQrModal(null)} />
        )}

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
