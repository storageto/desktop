/**
 * Error Reporter - DIY error tracking for StorageTo Desktop
 *
 * Catches JS errors, promise rejections, and custom events.
 * Queues errors locally and sends to API with retry logic.
 */

import { getVersion } from "@tauri-apps/api/app";

const API_URL = "https://storage.to/api/app-errors";
const MAX_QUEUE_SIZE = 50;
const RETRY_DELAY_MS = 5000;
const MAX_RETRIES = 3;

interface ErrorReport {
  app: "desktop";
  version: string | null;
  type: string;
  message: string;
  stack?: string;
  os?: string;
  os_version?: string;
  arch?: string;
  context?: Record<string, unknown>;
  timestamp: number;
  retries: number;
}

// Queue for offline/failed reports
let errorQueue: ErrorReport[] = [];
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
 * Initialize the error reporter - call once at app startup
 */
export async function initErrorReporter(): Promise<void> {
  // Get app version
  try {
    appVersion = await getVersion();
  } catch (e) {
    console.warn("[ErrorReporter] Failed to get app version:", e);
  }

  // Get OS info from userAgent
  osInfo = getOsFromUserAgent();

  // Set up global error handlers
  window.onerror = (message, source, lineno, colno, error) => {
    reportError({
      type: "js_error",
      message: String(message),
      stack: error?.stack || `at ${source}:${lineno}:${colno}`,
    });
    return false; // Let default handling continue
  };

  window.onunhandledrejection = (event) => {
    const error = event.reason;
    reportError({
      type: "promise_rejection",
      message: error?.message || String(error),
      stack: error?.stack,
    });
  };

  // Process any queued errors from previous session
  loadQueueFromStorage();
  processQueue();

  console.log("[ErrorReporter] Initialized");
}

/**
 * Report an error - main entry point
 */
export function reportError(params: {
  type: string;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
}): void {
  const report: ErrorReport = {
    app: "desktop",
    version: appVersion,
    type: params.type,
    message: params.message.slice(0, 10000), // Limit message size
    stack: params.stack?.slice(0, 50000), // Limit stack size
    os: osInfo?.platform,
    context: params.context,
    timestamp: Date.now(),
    retries: 0,
  };

  // Add to queue
  errorQueue.push(report);

  // Trim queue if too large (keep most recent)
  if (errorQueue.length > MAX_QUEUE_SIZE) {
    errorQueue = errorQueue.slice(-MAX_QUEUE_SIZE);
  }

  // Save queue to storage
  saveQueueToStorage();

  // Try to send immediately
  processQueue();
}

/**
 * Process the error queue - send errors to API
 */
async function processQueue(): Promise<void> {
  if (isProcessingQueue || errorQueue.length === 0) {
    return;
  }

  isProcessingQueue = true;

  while (errorQueue.length > 0) {
    const report = errorQueue[0];

    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Storageto-Client": "desktop",
        },
        body: JSON.stringify({
          app: report.app,
          version: report.version,
          type: report.type,
          message: report.message,
          stack: report.stack,
          os: report.os,
          os_version: report.os_version,
          arch: report.arch,
          context: report.context,
        }),
      });

      if (response.ok) {
        // Success - remove from queue
        errorQueue.shift();
        saveQueueToStorage();
      } else if (response.status >= 400 && response.status < 500) {
        // Client error - don't retry, just remove
        console.warn("[ErrorReporter] Client error, dropping report:", response.status);
        errorQueue.shift();
        saveQueueToStorage();
      } else {
        // Server error - retry later
        throw new Error(`Server error: ${response.status}`);
      }
    } catch (e) {
      // Network error or server error - retry later
      report.retries++;

      if (report.retries >= MAX_RETRIES) {
        // Give up on this report
        console.warn("[ErrorReporter] Max retries reached, dropping report");
        errorQueue.shift();
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
    localStorage.setItem("errorQueue", JSON.stringify(errorQueue));
  } catch (e) {
    // Storage full or unavailable - just continue
  }
}

/**
 * Load queue from localStorage
 */
function loadQueueFromStorage(): void {
  try {
    const stored = localStorage.getItem("errorQueue");
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        // Filter out very old errors (> 24 hours)
        const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
        errorQueue = parsed.filter((r) => r.timestamp > dayAgo);
      }
    }
  } catch (e) {
    // Invalid storage - start fresh
    errorQueue = [];
  }
}

/**
 * React Error Boundary helper - call from componentDidCatch
 */
export function reportReactError(error: Error, errorInfo: { componentStack: string }): void {
  reportError({
    type: "react_error",
    message: error.message,
    stack: error.stack,
    context: {
      componentStack: errorInfo.componentStack,
    },
  });
}
