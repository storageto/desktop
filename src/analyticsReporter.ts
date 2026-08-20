/**
 * Analytics Reporter - Usage tracking for StorageTo Desktop
 *
 * Tracks app usage events like launches, uploads, and screenshots.
 * Queues events locally and delivers via the Rust backend (send_app_event),
 * which attaches identity headers and stamps app/version. Delivery must NOT
 * use webview fetch(): WKWebView enforces CORS for the tauri:// origin and
 * the API has no preflight handling, so fetch() here never delivered (#18).
 *
 * NOTE: Heartbeat is handled by Rust backend (see lib.rs) since JavaScript
 * setInterval doesn't fire reliably when the Tauri window is hidden (menu bar app).
 */

import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";

const MAX_QUEUE_SIZE = 100;
const RETRY_DELAY_MS = 5000;
const MAX_RETRIES = 3;

interface AnalyticsEvent {
  app: "desktop";
  version: string | null;
  event: string;
  context?: Record<string, unknown>;
  timestamp: number;
  retries: number;
}

// Queue for offline/failed events
let eventQueue: AnalyticsEvent[] = [];
let isProcessingQueue = false;
let appVersion: string | null = null;
let osInfo: { platform: string } | null = null;

/**
 * Get OS info from userAgent (simple approach without extra plugin)
 */
function getOsFromUserAgent(): { platform: string } {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("mac")) return { platform: "macos" };
  if (ua.includes("win")) return { platform: "windows" };
  if (ua.includes("linux")) return { platform: "linux" };
  return { platform: "unknown" };
}

/**
 * Initialize the analytics reporter - call once at app startup
 */
export async function initAnalyticsReporter(): Promise<void> {
  // Get app version
  try {
    appVersion = await getVersion();
  } catch (e) {
    console.warn("[Analytics] Failed to get app version:", e);
  }

  // Get OS info from userAgent
  osInfo = getOsFromUserAgent();

  // Load any queued events from previous session
  loadQueueFromStorage();

  // Process any pending events
  processQueue();

  // Track app launch
  trackEvent("app_launch", {
    os: osInfo?.platform,
  });

  // NOTE: Heartbeat is handled by Rust backend (lib.rs) since JavaScript
  // setInterval doesn't fire reliably when the Tauri window is hidden

  console.log("[Analytics] Initialized");
}

/**
 * Track an analytics event
 */
export function trackEvent(
  event: string,
  context?: Record<string, unknown>
): void {
  const analyticsEvent: AnalyticsEvent = {
    app: "desktop",
    version: appVersion,
    event,
    context,
    timestamp: Date.now(),
    retries: 0,
  };

  // Add to queue
  eventQueue.push(analyticsEvent);

  // Trim queue if too large (keep most recent)
  if (eventQueue.length > MAX_QUEUE_SIZE) {
    eventQueue = eventQueue.slice(-MAX_QUEUE_SIZE);
  }

  // Save queue to storage
  saveQueueToStorage();

  // Try to send immediately
  processQueue();
}

/**
 * Track upload completion
 */
export function trackUploadComplete(params: {
  fileCount: number;
  totalSize: number;
  isCollection: boolean;
  /**
   * How many files the user actually selected. Sent alongside the landed count
   * so a shortfall is visible in the data at all.
   *
   * Without it, a 425-file folder that lands 382 files reports one success with
   * file_count 382 and nothing else - indistinguishable from a 382-file folder
   * that worked perfectly. That is how 43 missing files went unnoticed until a
   * customer counted them by hand: the failure moved no signal we were
   * watching, because the only signal we sent was the success.
   */
  attemptedCount: number;
}): void {
  trackEvent("upload_complete", {
    file_count: params.fileCount,
    attempted_count: params.attemptedCount,
    total_size: params.totalSize,
    is_collection: params.isCollection,
    os: osInfo?.platform,
  });
}

/**
 * Track screenshot completion
 */
export function trackScreenshotComplete(): void {
  trackEvent("screenshot_complete", {
    os: osInfo?.platform,
  });
}

/**
 * Process the event queue - send events to API
 */
async function processQueue(): Promise<void> {
  if (isProcessingQueue || eventQueue.length === 0) {
    return;
  }

  isProcessingQueue = true;

  while (eventQueue.length > 0) {
    const event = eventQueue[0];

    try {
      // Rust attaches identity headers and stamps app/version.
      // Errors: "status:<code>" for HTTP failures, "network:<msg>" otherwise.
      await invoke("send_app_event", {
        event: event.event,
        context: event.context ?? null,
      });

      // Success - remove from queue
      eventQueue.shift();
      saveQueueToStorage();
    } catch (rawErr) {
      const status = parseInt(String(rawErr).match(/^status:(\d+)/)?.[1] ?? "", 10);
      if (status >= 400 && status < 500) {
        // Client error - don't retry, just remove
        console.warn("[Analytics] Client error, dropping event:", status);
        eventQueue.shift();
        saveQueueToStorage();
        continue;
      }
      // Network error or server error - retry later
      event.retries++;

      if (event.retries >= MAX_RETRIES) {
        // Give up on this event
        console.warn("[Analytics] Max retries reached, dropping event");
        eventQueue.shift();
        saveQueueToStorage();
      } else {
        // Wait and retry
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }

  isProcessingQueue = false;
}

/**
 * Save queue to localStorage for persistence across restarts
 */
function saveQueueToStorage(): void {
  try {
    localStorage.setItem("analyticsQueue", JSON.stringify(eventQueue));
  } catch {
    // Storage full or unavailable - just continue
  }
}

/**
 * Load queue from localStorage
 */
function loadQueueFromStorage(): void {
  try {
    const stored = localStorage.getItem("analyticsQueue");
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        // Filter out very old events (> 24 hours)
        const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
        eventQueue = parsed.filter((e) => e.timestamp > dayAgo);
      }
    }
  } catch {
    // Invalid storage - start fresh
    eventQueue = [];
  }
}
