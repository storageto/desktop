import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";

interface AppConfig {
  visitor_token: string | null;
  api_url: string;
  upload_history: unknown[];
  auto_copy_url: boolean;
  show_notifications: boolean;
  has_launched: boolean;
  default_expiry_days: number | null;
  screenshot_shortcut: string | null;
  auth_token: string | null;
}

interface SettingsProps {
  isOpen: boolean;
  onClose: () => void;
  appVersion: string | null;
  addToast: (toast: { title: string; description?: string; type: "success" | "error" | "info" }) => void;
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (val: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer ${
        checked ? "bg-amber-500" : "bg-[#292524]"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
          checked ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}

const EXPIRY_OPTIONS = [
  { label: "1d", value: 1 },
  { label: "2d", value: 2 },
  { label: "3d", value: 3 },
  { label: "5d", value: 5 },
  { label: "7d", value: 7 },
] as const;

function parseShortcutToKeys(shortcut: string): string[] {
  return shortcut.split("+").map((key) => {
    const k = key.trim();
    if (k === "Command" || k === "Super") return "\u2318";
    if (k === "Control") return "Ctrl";
    if (k === "Shift") return "\u21E7";
    if (k === "Alt" || k === "Option") return "\u2325";
    return k;
  });
}

function getDefaultShortcut(): string {
  const isMac = navigator.userAgent.includes("Mac");
  return isMac ? "Command+Shift+S" : "Control+Shift+S";
}

export function Settings({ isOpen, onClose, appVersion, addToast }: SettingsProps) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [autostart, setAutostart] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordedKeys, setRecordedKeys] = useState<string[]>([]);
  const [authStatus, setAuthStatus] = useState<{ logged_in: boolean; email?: string; name?: string }>({ logged_in: false });

  const loadConfig = useCallback(async () => {
    try {
      const cfg = await invoke<AppConfig>("get_config");
      setConfig(cfg);
    } catch (e) {
      console.error("Failed to load config:", e);
    }
  }, []);

  const loadAutostart = useCallback(async () => {
    try {
      const enabled = await invoke<boolean>("get_autostart_enabled");
      setAutostart(enabled);
    } catch (e) {
      console.error("Failed to load autostart:", e);
    }
  }, []);

  const loadAuthStatus = useCallback(async () => {
    try {
      const status = await invoke<{ logged_in: boolean; email?: string; name?: string }>("get_auth_status");
      setAuthStatus(status);
    } catch (e) {
      console.error("Failed to load auth status:", e);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      loadConfig();
      loadAutostart();
      loadAuthStatus();
    }
  }, [isOpen, loadConfig, loadAutostart, loadAuthStatus]);

  // Listen for auth token received via deep link
  useEffect(() => {
    const unlisten = listen("auth-token-received", () => {
      loadAuthStatus();
      loadConfig();
      addToast({ title: "Logged in", description: "Account connected", type: "success" });
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [loadAuthStatus, loadConfig, addToast]);

  const updateConfig = async (updates: Partial<AppConfig>) => {
    if (!config) return;
    const newConfig = { ...config, ...updates };
    setConfig(newConfig);
    try {
      await invoke("update_config", { config: newConfig });
    } catch (e) {
      console.error("Failed to save config:", e);
      addToast({ title: "Failed to save settings", type: "error" });
    }
  };

  const handleAutostartToggle = async (enabled: boolean) => {
    setAutostart(enabled);
    try {
      await invoke("set_autostart_enabled", { enabled });
    } catch (e) {
      console.error("Failed to set autostart:", e);
      setAutostart(!enabled);
      addToast({ title: "Failed to update launch at login", type: "error" });
    }
  };

  const handleStartRecording = () => {
    setRecording(true);
    setRecordedKeys([]);
  };

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!recording) return;
      e.preventDefault();
      e.stopPropagation();

      // Collect modifiers + key
      const modifiers: string[] = [];
      if (e.metaKey) modifiers.push("Command");
      if (e.ctrlKey) modifiers.push("Control");
      if (e.altKey) modifiers.push("Alt");
      if (e.shiftKey) modifiers.push("Shift");

      const key = e.key;
      // Ignore standalone modifier presses
      if (["Meta", "Control", "Alt", "Shift"].includes(key)) {
        setRecordedKeys(modifiers);
        return;
      }

      // Must have at least one modifier
      if (modifiers.length === 0) {
        addToast({ title: "Invalid shortcut", description: "Must include at least one modifier key", type: "error" });
        setRecording(false);
        setRecordedKeys([]);
        return;
      }

      const shortcutStr = [...modifiers, key.length === 1 ? key.toUpperCase() : key].join("+");
      setRecording(false);
      setRecordedKeys([]);

      // Send to Rust to validate and register
      invoke("update_screenshot_shortcut", { shortcut: shortcutStr })
        .then(() => {
          loadConfig();
          addToast({ title: "Shortcut updated", type: "success" });
        })
        .catch((err) => {
          console.error("Failed to update shortcut:", err);
          addToast({ title: "Invalid shortcut", description: String(err), type: "error" });
        });
    },
    [recording, addToast, loadConfig]
  );

  useEffect(() => {
    if (recording) {
      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }
  }, [recording, handleKeyDown]);

  const handleResetShortcut = async () => {
    try {
      await invoke("update_screenshot_shortcut", { shortcut: getDefaultShortcut() });
      loadConfig();
      addToast({ title: "Shortcut reset to default", type: "success" });
    } catch (e) {
      console.error("Failed to reset shortcut:", e);
      addToast({ title: "Failed to reset shortcut", type: "error" });
    }
  };

  const handleLogin = async () => {
    try {
      await openUrl("https://storage.to/desktop/login");
    } catch (e) {
      console.error("Failed to open login:", e);
    }
  };

  const handleLogout = async () => {
    try {
      await invoke("logout");
      setAuthStatus({ logged_in: false });
      loadConfig();
      addToast({ title: "Logged out", type: "success" });
    } catch (e) {
      console.error("Failed to logout:", e);
      addToast({ title: "Failed to log out", type: "error" });
    }
  };

  const currentShortcut = config?.screenshot_shortcut || getDefaultShortcut();
  const shortcutKeys = parseShortcutToKeys(currentShortcut);

  return (
    <div
      className={`absolute inset-0 z-40 transition-transform duration-300 ease-in-out ${
        isOpen ? "translate-x-0" : "translate-x-full"
      }`}
    >
      <div className="h-full flex flex-col bg-[#0c0a09] rounded-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2 bg-[#1c1917] border-b border-[#292524]">
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-[#292524] text-[#a8a29e] hover:text-white transition-colors cursor-pointer"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <span className="font-semibold text-white text-base">Settings</span>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {config && (
            <div className="p-4 space-y-6">
              {/* Account Section */}
              <div>
                <h3 className="text-xs font-medium text-[#78716c] uppercase tracking-wider mb-3">Account</h3>
                <div className="space-y-1">
                  {authStatus.logged_in ? (
                    <div className="flex items-center justify-between py-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="w-6 h-6 rounded-full bg-emerald-500/20 flex items-center justify-center flex-shrink-0">
                          <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                        </div>
                        <span className="text-sm text-white truncate">{authStatus.email || "Logged in"}</span>
                      </div>
                      <button
                        onClick={handleLogout}
                        className="text-xs text-[#a8a29e] hover:text-white transition-colors cursor-pointer flex-shrink-0 ml-2"
                      >
                        Log out
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={handleLogin}
                      className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-lg bg-[#1c1917] hover:bg-[#292524] border border-[#292524] text-sm text-white transition-colors cursor-pointer"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
                      </svg>
                      Log in to storage.to
                    </button>
                  )}
                </div>
              </div>

              {/* General Section */}
              <div>
                <h3 className="text-xs font-medium text-[#78716c] uppercase tracking-wider mb-3">General</h3>
                <div className="space-y-3">
                  {/* Notifications */}
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-[#e7e5e4]">Notifications</span>
                    <Toggle
                      checked={config.show_notifications}
                      onChange={(val) => updateConfig({ show_notifications: val })}
                    />
                  </div>

                  {/* Auto-copy URL */}
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-[#e7e5e4]">Auto-copy URL</span>
                    <Toggle
                      checked={config.auto_copy_url}
                      onChange={(val) => updateConfig({ auto_copy_url: val })}
                    />
                  </div>

                  {/* Launch at login */}
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-[#e7e5e4]">Launch at login</span>
                    <Toggle
                      checked={autostart}
                      onChange={handleAutostartToggle}
                    />
                  </div>

                  {/* Default expiry */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm text-[#e7e5e4]">Default expiry</span>
                    </div>
                    <div className="flex gap-1.5">
                      {EXPIRY_OPTIONS.map((opt) => {
                        const effectiveExpiry = config.default_expiry_days ?? 3;
                        return (
                          <button
                            key={opt.label}
                            onClick={() => updateConfig({ default_expiry_days: opt.value })}
                            className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors cursor-pointer ${
                              effectiveExpiry === opt.value
                                ? "bg-amber-500/20 text-amber-400 border-amber-500/30"
                                : "bg-[#1c1917] text-[#a8a29e] border-[#292524] hover:border-[#3f3f46] hover:text-white"
                            }`}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Screenshot shortcut */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm text-[#e7e5e4]">Screenshot shortcut</span>
                      <button
                        onClick={recording ? () => { setRecording(false); setRecordedKeys([]); } : handleStartRecording}
                        className="text-xs text-amber-400 hover:text-amber-300 transition-colors cursor-pointer"
                      >
                        {recording ? "Cancel" : "Change"}
                      </button>
                    </div>
                    {recording ? (
                      <div className="flex items-center gap-2">
                        <div className="flex-1 flex items-center justify-center gap-1 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30">
                          {recordedKeys.length > 0 ? (
                            recordedKeys.map((key, i) => (
                              <kbd
                                key={i}
                                className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 text-xs font-mono"
                              >
                                {parseShortcutToKeys(key)[0]}
                              </kbd>
                            ))
                          ) : (
                            <span className="text-xs text-amber-400/60">Press keys...</span>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <div className="flex items-center gap-1">
                          {shortcutKeys.map((key, i) => (
                            <kbd
                              key={i}
                              className="px-1.5 py-0.5 rounded bg-[#1c1917] border border-[#292524] text-[#a8a29e] text-xs font-mono"
                            >
                              {key}
                            </kbd>
                          ))}
                        </div>
                        {config.screenshot_shortcut && (
                          <button
                            onClick={handleResetShortcut}
                            className="text-[10px] text-[#57534e] hover:text-[#a8a29e] transition-colors cursor-pointer"
                          >
                            Reset
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* About Section */}
              <div>
                <h3 className="text-xs font-medium text-[#78716c] uppercase tracking-wider mb-3">About</h3>
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-[#a8a29e]">Version</span>
                    <span className="text-sm text-[#57534e]">{appVersion ? `v${appVersion}` : "..."}</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
