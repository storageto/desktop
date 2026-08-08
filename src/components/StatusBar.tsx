import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

// Shape of GET /api/limits (via the get_limits Rust command). Anonymous callers
// get the daily upload cap + usage; signed-in users get their plan instead.
interface Limits {
  logged_in: boolean;
  limit?: number;
  used?: number;
  remaining?: number;
  plan?: string;
  is_premium?: boolean;
}

interface StatusBarProps {
  // Bumped by App after uploads finish/fail and on login, so the meter stays
  // current. The bar also refreshes itself on window focus (menu bar app: the
  // window is hidden most of the time, so focus == user is looking).
  refreshKey: number;
}

export function StatusBar({ refreshKey }: StatusBarProps) {
  const [limits, setLimits] = useState<Limits | null>(null);

  const refresh = useCallback(async () => {
    try {
      const l = await invoke<Limits>("get_limits");
      setLimits(l);
    } catch (e) {
      // Offline or API down: keep showing the last known state.
      console.warn("[StatusBar] limits fetch failed:", e);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, refreshKey]);

  useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  const handleCreateAccount = useCallback(() => {
    // Signup auto-signs-in and ?desktop=1 threads through to the token mint,
    // so a fresh account deep-links straight back into the app.
    openUrl("https://storage.to/register?desktop=1").catch((e) =>
      console.error("[StatusBar] failed to open signup:", e)
    );
  }, []);

  // Nothing sensible to show before the first successful fetch.
  if (!limits) return null;

  if (limits.logged_in) {
    return (
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#1c1917] border-t border-[#292524] text-[11px]">
        <div className="flex items-center gap-1.5 text-[#a8a29e]">
          <svg className="w-3 h-3 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          </svg>
          <span>Signed in</span>
        </div>
        <span className={limits.is_premium ? "text-pink-400 font-medium" : "text-stone-500"}>
          {limits.is_premium ? "Premium" : "Free plan"}
        </span>
      </div>
    );
  }

  const limit = limits.limit ?? 0;
  const used = Math.min(limits.used ?? 0, limit);
  const atLimit = limit > 0 && (limits.remaining ?? 0) <= 0;
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;

  return (
    <div className="px-3 py-1.5 bg-[#1c1917] border-t border-[#292524]">
      <div className="flex items-center justify-between text-[11px] mb-1">
        <span className={atLimit ? "text-red-400 font-medium" : "text-[#a8a29e]"}>
          {atLimit ? "Daily limit reached" : `${used} of ${limit} daily uploads`}
        </span>
        <button
          onClick={handleCreateAccount}
          className="text-pink-400 hover:text-pink-300 font-medium transition-colors cursor-pointer"
        >
          Create free account
        </button>
      </div>
      <div className="h-1 rounded-full bg-[#292524] overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${
            atLimit ? "bg-red-500" : pct >= 70 ? "bg-amber-400" : "bg-pink-500"
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
