import type { BatchRecord, RunRecord } from "./types";

/**
 * Past runs are kept in this browser's IndexedDB so people can come back to them.
 * Only results are stored, never the API key. Anyone can switch saving off or clear it.
 */
export type HistoryEntry =
  | { id: string; kind: "lookup"; title: string; createdAt: number; updatedAt: number; data: RunRecord }
  | { id: string; kind: "batch"; title: string; createdAt: number; updatedAt: number; data: BatchRecord };

const DB_NAME = "stakeholder-lookup";
const STORE = "entries";
const PREF_KEY = "stakeholder-lookup:save-history";
export const HISTORY_EVENT = "stakeholder-history-changed";

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => (dbPromise = null));
  }
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const changed = () => window.dispatchEvent(new Event(HISTORY_EVENT));

export function isSavingEnabled() {
  try {
    return localStorage.getItem(PREF_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setSavingEnabled(on: boolean) {
  try {
    localStorage.setItem(PREF_KEY, on ? "on" : "off");
  } catch {}
  changed();
}

export async function saveEntry(entry: HistoryEntry) {
  if (!isSavingEnabled()) return;
  try {
    await tx("readwrite", (s) => s.put(entry));
    changed();
  } catch {}
}

export async function listEntries(): Promise<HistoryEntry[]> {
  try {
    const all = await tx<HistoryEntry[]>("readonly", (s) => s.getAll());
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export async function deleteEntry(id: string) {
  try {
    await tx("readwrite", (s) => s.delete(id));
    changed();
  } catch {}
}

export async function clearEntries() {
  try {
    await tx("readwrite", (s) => s.clear());
    changed();
  } catch {}
}

export const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
