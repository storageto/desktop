/**
 * Analytics Reporter - Usage tracking for StorageTo Desktop
 *
 * Tracks app usage events like launches, uploads, and screenshots.
 * Queues events locally and sends to API with retry logic.
 */

import { getVersion } from "@tauri-apps/api/app";

const API_URL = "https://storage.to/api/app-analytics";
const MAX_QUEUE_SIZE = 100;
const RETRY_DELAY_MS = 5000;
const MAX_RETRIES = 3;
const HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes

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
let visitorToken: string | null = null;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

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
 * Get visitor token from localStorage (set by Rust backend)
 */
function getVisitorTokenFromStorage(): string | null {
  try {
    return localStorage.getItem("visitor_token");
  } catch {
    return null;
  }
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

  // Get visitor token
  visitorToken = getVisitorTokenFromStorage();

  // Load any queued events from previous session
  loadQueueFromStorage();

  // Process any pending events
  processQueue();

  // Track app launch
  trackEvent("app_launch", {
    os: osInfo?.platform,
  });

  // Start heartbeat
  startHeartbeat();

  console.log("[Analytics] Initialized");
}

/**
 * Start the heartbeat interval
 */
function startHeartbeat(): void {
  // Clear any existing interval
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }

  // Send heartbeat every 60 minutes
  heartbeatInterval = setInterval(() => {
    trackEvent("heartbeat", {
      os: osInfo?.platform,
    });
  }, HEARTBEAT_INTERVAL_MS);
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
}): void {
  trackEvent("upload_complete", {
    file_count: params.fileCount,
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

  // Refresh visitor token in case it was set after init
  if (!visitorToken) {
    visitorToken = getVisitorTokenFromStorage();
  }

  while (eventQueue.length > 0) {
    const event = eventQueue[0];

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      // Add visitor token if available
      if (visitorToken) {
        headers["X-Visitor-Token"] = visitorToken;
      }

      const response = await fetch(API_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({
          app: event.app,
          version: event.version,
          event: event.event,
          context: event.context,
        }),
      });

      if (response.ok) {
        // Success - remove from queue
        eventQueue.shift();
        saveQueueToStorage();
      } else if (response.status >= 400 && response.status < 500) {
        // Client error - don't retry, just remove
        console.warn(
          "[Analytics] Client error, dropping event:",
          response.status
        );
        eventQueue.shift();
        saveQueueToStorage();
      } else {
        // Server error - retry later
        throw new Error(`Server error: ${response.status}`);
      }
    } catch (e) {
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
