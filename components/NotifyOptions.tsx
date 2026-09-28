"use client";

import { useEffect, useState } from "react";
import { Bell, Volume2 } from "lucide-react";
import {
  chime,
  getPrefs,
  notificationsSupported,
  permission,
  PREFS_EVENT,
  primeAudio,
  requestPermission,
  setPrefs,
  type NotifyPrefs,
} from "@/lib/notify";

function usePrefs(): [NotifyPrefs, (p: NotifyPrefs) => void] {
  const [prefs, set] = useState<NotifyPrefs>({ desktop: false, sound: true });
  useEffect(() => {
    const sync = () => set(getPrefs());
    sync();
    window.addEventListener(PREFS_EVENT, sync);
    return () => window.removeEventListener(PREFS_EVENT, sync);
  }, []);
  return [prefs, setPrefs];
}

/** "Tell me when it's done" opt-ins, shown before generating and while a seed runs. */
export function NotifyOptions({ compact = false }: { compact?: boolean }) {
  const [prefs, save] = usePrefs();
  const [blocked, setBlocked] = useState(false);
  const supported = notificationsSupported();

  useEffect(() => setBlocked(permission() === "denied"), []);

  return (
    <fieldset className={`notify-opts ${compact ? "notify-compact" : ""}`}>
      {!compact && <legend>When it&apos;s done</legend>}
      {supported && (
        <label className="toggle">
          <input
            type="checkbox"
            checked={prefs.desktop}
            disabled={blocked}
            onChange={async (e) => {
              if (!e.target.checked) return save({ ...prefs, desktop: false });
              const result = await requestPermission();
              setBlocked(result === "denied");
              save({ ...prefs, desktop: result === "granted" });
            }}
          />
          <Bell size={14} aria-hidden="true" /> Desktop notification
        </label>
      )}
      <label className="toggle">
        <input
          type="checkbox"
          checked={prefs.sound}
          onChange={(e) => {
            save({ ...prefs, sound: e.target.checked });
            if (e.target.checked) chime(); // preview, and unlocks audio for later
          }}
        />
        <Volume2 size={14} aria-hidden="true" /> Play a sound
      </label>
      {blocked && <p className="hint">Notifications are blocked for this site. Allow them in your browser&apos;s site settings.</p>}
      {!compact && <p className="hint">The tab title also changes when it finishes. Keep this tab open.</p>}
    </fieldset>
  );
}

export { primeAudio };
