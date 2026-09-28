import { rowToRecord, STAGE_OUTCOME, type BatchRow, type Outcome, type RunRecord } from "./types";

/**
 * Past runs live in this browser's IndexedDB so results are never lost: every
 * lookup and every batch is saved automatically, and a backup file can be
 * downloaded and restored. Only results are stored, never the API key.
 *
 * Layout (v2): `entries` holds one small record per lookup / batch (a batch keeps
 * only its summary), and `batchRows` holds each batch company separately, so a
 * 1,500-row batch writes just the rows that changed instead of one huge blob.
 */

export type BatchSummary = {
  name: string;
  total: number;
  counts: Partial<Record<Outcome | "unresolved", number>>;
  stakeholders: number;
  /** Every power pod seen in this batch (for zero-count pods elsewhere). */
  pods: string[];
  maxSeeds?: number;
};

type EntryBase = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** User's tenant (detected), never the key. */
  tenant?: string;
};
export type HistoryEntry =
  | (EntryBase & { kind: "lookup"; data: RunRecord })
  | (EntryBase & { kind: "batch"; data: BatchSummary });

type StoredRow = { key: string; batchId: string; i: number; row: BatchRow };

const DB_NAME = "stakeholder-lookup";
const ENTRIES = "entries";
const ROWS = "batchRows";
export const HISTORY_EVENT = "stakeholder-history-changed";

export function summarize(name: string, rows: BatchRow[], maxSeeds?: number): BatchSummary {
  const counts: BatchSummary["counts"] = {};
  const pods = new Set<string>();
  let stakeholders = 0;
  for (const r of rows) {
    const o = STAGE_OUTCOME[r.stage] ?? (r.stage === "no_match" || r.stage === "error" ? "unresolved" : undefined);
    if (o) counts[o] = (counts[o] ?? 0) + 1;
    stakeholders += r.stakeholders.length;
    for (const s of r.stakeholders) if (typeof s.swimlane === "string" && s.swimlane.trim()) pods.add(s.swimlane.trim());
  }
  return { name, total: rows.length, counts, stakeholders, pods: [...pods], maxSeeds };
}

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const d = req.result;
        const tx = req.transaction!;
        if (!d.objectStoreNames.contains(ENTRIES)) d.createObjectStore(ENTRIES, { keyPath: "id" });
        if (!d.objectStoreNames.contains(ROWS)) {
          const rows = d.createObjectStore(ROWS, { keyPath: "key" });
          rows.createIndex("batchId", "batchId");
          // v1 kept whole batches (rows and all) inside `entries`: split them out.
          tx.objectStore(ENTRIES).openCursor().onsuccess = (ev) => {
            const cur = (ev.target as IDBRequest<IDBCursorWithValue | null>).result;
            if (!cur) return;
            const v = cur.value;
            if (v.kind === "batch" && Array.isArray(v.data?.rows)) {
              (v.data.rows as BatchRow[]).forEach((row, i) => rows.put({ key: `${v.id}:${row.id}`, batchId: v.id, i, row } satisfies StoredRow));
              cur.update({ ...v, data: summarize(v.data.name, v.data.rows) });
            }
            cur.continue();
          };
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => (dbPromise = null));
  }
  return dbPromise;
}

function done(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function req<T>(r: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

const changed = () => window.dispatchEvent(new Event(HISTORY_EVENT));

let persistAsked = false;
/** Ask the browser not to evict our data under storage pressure (asked once per load). */
export async function requestPersistence() {
  if (persistAsked) return;
  persistAsked = true;
  try {
    await navigator.storage?.persist?.();
  } catch {}
}

export async function storageInfo(): Promise<{ usedMB: number | null; persisted: boolean | null }> {
  try {
    const [est, persisted] = await Promise.all([navigator.storage?.estimate?.(), navigator.storage?.persisted?.()]);
    return { usedMB: est?.usage != null ? est.usage / 1_048_576 : null, persisted: persisted ?? null };
  } catch {
    return { usedMB: null, persisted: null };
  }
}

export async function saveEntry(entry: HistoryEntry) {
  requestPersistence();
  try {
    const tx = (await db()).transaction(ENTRIES, "readwrite");
    tx.objectStore(ENTRIES).put(entry);
    await done(tx);
    changed();
  } catch {}
}

/** Save a batch: its summary, plus only the rows that changed (and drop removed ones), in one transaction. */
export async function saveBatch(opts: {
  id: string;
  createdAt: number;
  tenant?: string;
  name: string;
  rows: BatchRow[];
  dirty: { row: BatchRow; i: number }[];
  removed: string[];
  maxSeeds?: number;
}) {
  requestPersistence();
  try {
    const tx = (await db()).transaction([ENTRIES, ROWS], "readwrite");
    const entry: HistoryEntry = {
      id: opts.id,
      kind: "batch",
      title: opts.name,
      tenant: opts.tenant,
      createdAt: opts.createdAt,
      updatedAt: Date.now(),
      data: summarize(opts.name, opts.rows, opts.maxSeeds),
    };
    tx.objectStore(ENTRIES).put(entry);
    const rows = tx.objectStore(ROWS);
    for (const { row, i } of opts.dirty) rows.put({ key: `${opts.id}:${row.id}`, batchId: opts.id, i, row } satisfies StoredRow);
    for (const rid of opts.removed) rows.delete(`${opts.id}:${rid}`);
    await done(tx);
    changed();
  } catch {}
}

export async function loadBatchRows(batchId: string): Promise<BatchRow[]> {
  try {
    const store = (await db()).transaction(ROWS, "readonly").objectStore(ROWS);
    const all = await req<StoredRow[]>(store.index("batchId").getAll(batchId));
    return all.sort((a, b) => a.i - b.i).map((s) => s.row);
  } catch {
    return [];
  }
}

export async function listEntries(): Promise<HistoryEntry[]> {
  try {
    const all = await req<HistoryEntry[]>((await db()).transaction(ENTRIES, "readonly").objectStore(ENTRIES).getAll());
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

/** Every saved company result (lookups and batch rows), with its tenant. */
export async function listRecords(): Promise<{ record: RunRecord; tenant: string; at: number }[]> {
  try {
    const tx = (await db()).transaction([ENTRIES, ROWS], "readonly");
    const [entries, rows] = await Promise.all([
      req<HistoryEntry[]>(tx.objectStore(ENTRIES).getAll()),
      req<StoredRow[]>(tx.objectStore(ROWS).getAll()),
    ]);
    const byId = new Map(entries.map((e) => [e.id, e]));
    const out: { record: RunRecord; tenant: string; at: number }[] = [];
    for (const e of entries) if (e.kind === "lookup") out.push({ record: e.data, tenant: e.tenant ?? "", at: e.data.checkedAt ?? e.updatedAt });
    for (const s of rows) {
      const rec = rowToRecord(s.row);
      const e = byId.get(s.batchId);
      if (rec && e) out.push({ record: rec, tenant: e.tenant ?? "", at: rec.checkedAt ?? e.updatedAt });
    }
    return out;
  } catch {
    return [];
  }
}

export async function deleteEntry(id: string) {
  try {
    const tx = (await db()).transaction([ENTRIES, ROWS], "readwrite");
    tx.objectStore(ENTRIES).delete(id);
    const keys = await req(tx.objectStore(ROWS).index("batchId").getAllKeys(id));
    for (const k of keys) tx.objectStore(ROWS).delete(k);
    await done(tx);
    changed();
  } catch {}
}

export async function clearEntries() {
  try {
    const tx = (await db()).transaction([ENTRIES, ROWS], "readwrite");
    tx.objectStore(ENTRIES).clear();
    tx.objectStore(ROWS).clear();
    await done(tx);
    changed();
  } catch {}
}

// ---- Backup / restore ------------------------------------------------------

type Backup = { app: "stakeholder-lookup"; version: 2; exportedAt: string; entries: HistoryEntry[]; batchRows: StoredRow[] };

export async function exportBackup(): Promise<string> {
  const tx = (await db()).transaction([ENTRIES, ROWS], "readonly");
  const [entries, batchRows] = await Promise.all([
    req<HistoryEntry[]>(tx.objectStore(ENTRIES).getAll()),
    req<StoredRow[]>(tx.objectStore(ROWS).getAll()),
  ]);
  const backup: Backup = { app: "stakeholder-lookup", version: 2, exportedAt: new Date().toISOString(), entries, batchRows };
  return JSON.stringify(backup);
}

/** Merge a backup in: an entry replaces the saved one only if it is newer. */
export async function importBackup(text: string): Promise<{ added: number; updated: number; skipped: number }> {
  const b = JSON.parse(text) as Partial<Backup>;
  if (b.app !== "stakeholder-lookup" || !Array.isArray(b.entries)) throw new Error("That file isn't a Stakeholder Lookup backup.");
  const d = await db();
  const existing = new Map((await listEntries()).map((e) => [e.id, e]));
  const tx = d.transaction([ENTRIES, ROWS], "readwrite");
  let added = 0;
  let updated = 0;
  let skipped = 0;
  const take = new Set<string>();
  for (const e of b.entries) {
    const cur = existing.get(e.id);
    if (!cur) added++;
    else if (e.updatedAt > cur.updatedAt) updated++;
    else {
      skipped++;
      continue;
    }
    take.add(e.id);
    tx.objectStore(ENTRIES).put(e);
  }
  for (const r of b.batchRows ?? []) if (take.has(r.batchId)) tx.objectStore(ROWS).put(r);
  await done(tx);
  changed();
  return { added, updated, skipped };
}

export const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
