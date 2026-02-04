import React from "react";
import ReactDOM from "react-dom/client";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { initErrorReporter } from "./errorReporter";
import { initAnalyticsReporter } from "./analyticsReporter";
import "./index.css";

// Initialize error reporter as early as possible
initErrorReporter();

// Initialize analytics reporter
initAnalyticsReporter();

// Check for updates and auto-install
async function checkForUpdates() {
  try {
    const update = await check();
    if (update) {
      console.log(`[Updater] Update available: ${update.version}`);
      // Download and install
      await update.downloadAndInstall();
      // Relaunch the app
      await relaunch();
    }
  } catch (e) {
    console.error("[Updater] Failed to check for updates:", e);
  }
}

// Check on startup (with small delay to not block app load)
setTimeout(checkForUpdates, 3000);

// Check every hour
setInterval(checkForUpdates, 60 * 60 * 1000);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
