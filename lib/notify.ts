/**
 * Completion alerts that need no server: desktop notifications, a short chime,
 * and a tab title + favicon that change while seeds run and once they finish.
 * Preferences are per-viewer conveniences kept in localStorage (never the key).
 */

export type NotifyPrefs = { desktop: boolean; sound: boolean };

const PREF_KEY = "stakeholder-lookup:notify";
const PREF_EVENT = "stakeholder-notify-prefs";
const BASE_TITLE = "Stakeholder Lookup";

export function getPrefs(): NotifyPrefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) || "{}");
    return { desktop: !!p.desktop && permission() === "granted", sound: !!p.sound };
  } catch {
    return { desktop: false, sound: false };
  }
}

export function setPrefs(p: NotifyPrefs) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(p));
  } catch {}
  window.dispatchEvent(new Event(PREF_EVENT));
}

export const PREFS_EVENT = PREF_EVENT;

export function notificationsSupported() {
  return typeof window !== "undefined" && "Notification" in window;
}

export function permission(): NotificationPermission | "unsupported" {
  return notificationsSupported() ? Notification.permission : "unsupported";
}

/** Must be called from a click/change handler so the browser shows its prompt. */
export async function requestPermission() {
  if (!notificationsSupported()) return "unsupported" as const;
  if (Notification.permission !== "default") return Notification.permission;
  return Notification.requestPermission();
}

// ---- Sound -----------------------------------------------------------------

let audio: AudioContext | null = null;

/** Create/resume the audio context during a user gesture so a later chime is allowed. */
export function primeAudio() {
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") audio.resume();
  } catch {}
}

export function chime() {
  try {
    primeAudio();
    const ctx = audio!;
    const t = ctx.currentTime;
    [660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = t + i * 0.16;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.4);
    });
  } catch {}
}

// ---- Tab title + favicon ---------------------------------------------------

const generating = new Map<string, number>();
let label = "";

/** Prefix the tab title with the key's label so two tenants' tabs are easy to tell apart. */
export function setTitleLabel(next?: string) {
  label = next?.trim() ?? "";
  render();
}
let done = false;
let listening = false;

const ICON = (badge?: string) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#7744FF"/><circle cx="11" cy="12" r="3.2" fill="#fff"/><circle cx="21" cy="12" r="3.2" fill="#fff"/><circle cx="16" cy="21" r="3.2" fill="#fff"/><path d="M11 12 21 12 16 21Z" fill="none" stroke="#fff" stroke-width="1.4" opacity=".7"/>${
      badge ? `<circle cx="25" cy="25" r="6.5" fill="${badge}" stroke="#fff" stroke-width="2"/>` : ""
    }</svg>`,
  )}`;

function render() {
  if (typeof document === "undefined") return;
  const total = [...generating.values()].reduce((a, b) => a + b, 0);
  const base = label ? `${label} · ${BASE_TITLE}` : BASE_TITLE;
  document.title = done ? `✓ Done · ${base}` : total ? `(${total}) Generating · ${base}` : base;
  let link = document.querySelector<HTMLLinkElement>("link#app-icon");
  if (!link) {
    link = document.createElement("link");
    link.id = "app-icon";
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.href = ICON(done ? "#00EC8A" : total ? "#FFE299" : undefined);
}

function listen() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  const clear = () => {
    if (done && !document.hidden && document.hasFocus()) {
      done = false;
      render();
    }
  };
  document.addEventListener("visibilitychange", clear);
  window.addEventListener("focus", clear);
}

/** Report how many seeds a source (a lookup or a batch) is currently watching. */
export function setGenerating(source: string, count: number) {
  listen();
  if (count > 0) generating.set(source, count);
  else generating.delete(source);
  render();
}

const isAway = () => document.hidden || !document.hasFocus();

/** Fire on completion. The tab title always updates; sound and desktop follow prefs. */
export function announce({ title, body, tag }: { title: string; body: string; tag: string }) {
  listen();
  const prefs = getPrefs();
  const away = isAway();
  if (away) {
    done = true;
    render();
  }
  if (prefs.sound) chime();
  if (prefs.desktop && away && permission() === "granted") {
    try {
      const n = new Notification(title, { body, tag, icon: ICON() });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch {}
  }
}
