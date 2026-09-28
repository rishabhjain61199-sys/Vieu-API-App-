"use client";

import { useEffect } from "react";

/**
 * Keep the screen from sleeping while seeds run (Screen Wake Lock API). The
 * browser drops the lock when the tab is hidden, so it is re-taken on return.
 * It cannot stop a laptop from sleeping when the lid is closed.
 */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const take = async () => {
      if (cancelled || document.hidden) return;
      try {
        lock = await navigator.wakeLock.request("screen");
      } catch {}
    };
    const onVisible = () => !document.hidden && take();
    take();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      lock?.release().catch(() => {});
    };
  }, [active]);
}

export const wakeLockSupported = () => typeof navigator !== "undefined" && "wakeLock" in navigator;
