import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { initErrorReporter } from "./errorReporter";
import { initAnalyticsReporter } from "./analyticsReporter";
import "./index.css";

// Initialize error reporter as early as possible
initErrorReporter();

// Initialize analytics reporter
initAnalyticsReporter();

// NOTE: Update checking is now handled in Rust (lib.rs - start_update_checker)
// This runs in background even when window is hidden and shows a notification
// when an update is downloaded and ready to install.

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
