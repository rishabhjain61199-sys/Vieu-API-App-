"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, DatabaseBackup, Download, RefreshCw, ShieldCheck, Tag, Trash2 } from "lucide-react";
import {
  clearEntries,
  deleteEntry,
  exportBackup,
  HISTORY_EVENT,
  importBackup,
  listEntries,
  loadBatchRows,
  requestPersistence,
  storageInfo,
  type BatchSummary,
  type HistoryEntry,
} from "@/lib/history";
import { downloadFile, today } from "@/lib/csv";
import { OUTCOME_LABEL, type BatchRow, type Company, type LookupResume, type Outcome } from "@/lib/types";
import { Spinner } from "./ui";
import { tenantKey } from "@/lib/tenant";
import { Badge, CompanyLogo, ConfirmDialog } from "./ui";
import { OUTCOME_TONE, RecordView } from "./Summary";
import { BatchView, type ResumeBatch } from "./Batch";

function ago(ts: number) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}


const UNLABELED = "__unlabeled__";

export function History({
  hasKey,
  currentTenant,
  onResumeBatch,
  onRerunLookup,
  onViewStakeholders,
}: {
  hasKey: boolean;
  currentTenant?: string;
  onViewStakeholders?: (companyId: string) => void;
  onResumeBatch: (b: ResumeBatch) => void;
  onRerunLookup: (c: Company, domain?: string, resume?: LookupResume) => void;
}) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openRows, setOpenRows] = useState<BatchRow[] | null>(null);
  const [storage, setStorage] = useState<{ usedMB: number | null; persisted: boolean | null } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<HistoryEntry | null>(null);
  const [backupMsg, setBackupMsg] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [filter, setFilter] = useState<string>("all");
  const [pending, setPending] = useState<{ entry: HistoryEntry; run: () => void } | null>(null);

  useEffect(() => {
    const load = () => {
      listEntries().then(setEntries);
      storageInfo().then(setStorage);
    };
    requestPersistence().then(() => storageInfo().then(setStorage));
    load();
    window.addEventListener(HISTORY_EVENT, load);
    return () => window.removeEventListener(HISTORY_EVENT, load);
  }, []);

  // One chip per tenant (first spelling seen wins), plus "No tenant" if any entry lacks one.
  const tenants = useMemo(() => {
    const m = new Map<string, string>();
    let unlabeled = false;
    for (const e of entries ?? []) {
      if (!tenantKey(e.tenant)) unlabeled = true;
      else if (!m.has(tenantKey(e.tenant))) m.set(tenantKey(e.tenant), e.tenant!.trim());
    }
    return { list: [...m.entries()], unlabeled };
  }, [entries]);

  const shown = (entries ?? []).filter((e) =>
    filter === "all" ? true : filter === UNLABELED ? !tenantKey(e.tenant) : tenantKey(e.tenant) === filter,
  );

  /** Re-running with a key labeled for another tenant would query the wrong tenant: confirm first. */
  function guarded(entry: HistoryEntry, run: () => void) {
    if (tenantKey(entry.tenant) === tenantKey(currentTenant)) run();
    else setPending({ entry, run });
  }

  const open = entries?.find((e) => e.id === openId);

  // A batch's companies are stored separately; load them when it's opened.
  useEffect(() => {
    setOpenRows(null);
    if (open?.kind !== "batch") return;
    let live = true;
    loadBatchRows(open.id).then((r) => live && setOpenRows(r));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId, open?.updatedAt]);

  async function downloadBackup() {
    downloadFile(`stakeholder_lookup_backup_${today()}.json`, await exportBackup(), "application/json");
  }

  async function restore(file?: File) {
    if (!file) return;
    try {
      const r = await importBackup(await file.text());
      setBackupMsg(`Restored: ${r.added} added, ${r.updated} updated, ${r.skipped} already up to date.`);
    } catch (e) {
      setBackupMsg((e as Error).message || "Couldn't read that backup file.");
    }
  }
  const needKey = hasKey ? undefined : "Paste your key first";

  if (open) {
    return (
      <div className="stack">
        <button className="btn btn-ghost small back" onClick={() => setOpenId(null)}>
          <ArrowLeft size={14} /> Back to history
        </button>
        {open.tenant && (
          <p className="muted small">
            <Tag size={12} /> Tenant: <strong>{open.tenant}</strong>
          </p>
        )}
        {open.kind === "lookup" ? (
          <RecordView
            record={open.data}
            tenant={open.tenant}
            actions={
              <button
                className="btn btn-ghost"
                disabled={!hasKey}
                title={needKey}
                onClick={() =>
                  guarded(open, () => {
                    const d = open.data;
                    const inProgress = d.outcome === "seed_in_progress" || d.outcome === "still_generating";
                    onRerunLookup(
                      d.company,
                      d.domain,
                      inProgress
                        ? { entryId: open.id, createdAt: open.createdAt, genStart: d.genStart ?? null, created: d.created, joined: d.joined, watching: true }
                        : undefined,
                    );
                  })
                }
              >
                <RefreshCw size={16} />{" "}
                {open.data.outcome === "seed_in_progress" || open.data.outcome === "still_generating" ? "Resume and re-check" : "Run again"}
              </button>
            }
          />
        ) : (
          openRows === null ? (
            <section className="card">
              <p className="muted">
                <Spinner /> Loading {open.data.total.toLocaleString()} companies…
              </p>
            </section>
          ) : (
            <BatchView
              name={open.data.name}
              rows={openRows}
              onView={onViewStakeholders}
              extraActions={
                <button
                  className="btn btn-ghost small"
                  disabled={!hasKey}
                  title={needKey}
                  onClick={() =>
                    guarded(open, () =>
                      onResumeBatch({ id: open.id, createdAt: open.createdAt, name: open.data.name, rows: openRows, maxSeeds: open.data.maxSeeds }),
                    )
                  }
                >
                  <RefreshCw size={14} /> Resume and re-check
                </button>
              }
            />
          )
        )}
        <MismatchDialog pending={pending} currentTenant={currentTenant} onClose={() => setPending(null)} />
      </div>
    );
  }

  return (
    <section className="card">
      <div className="summary-head">
        <div className="grow">
          <p className="eyebrow">History</p>
          <h2>Previous lookups and batches</h2>
          <p className="muted small">
            Every lookup and batch is saved here automatically, in this browser. Your API key is never saved.
            {storage?.persisted && (
              <>
                {" "}
                <ShieldCheck size={13} className="ok-icon" /> Protected from automatic cleanup
              </>
            )}
            {storage?.usedMB != null && <> · {storage.usedMB < 1 ? "<1" : Math.round(storage.usedMB)} MB used</>}
          </p>
          {storage?.persisted === false && (
            <p className="hint">The browser may clear this if disk space runs low. Download a backup now and then to be safe.</p>
          )}
          {backupMsg && <p className="hint">{backupMsg}</p>}
        </div>
        <button className="btn btn-ghost small" onClick={downloadBackup} disabled={!entries?.length}>
          <Download size={14} /> Download backup
        </button>
        <label className="btn btn-ghost small">
          <DatabaseBackup size={14} /> Restore backup
          <input type="file" accept="application/json,.json" hidden onChange={(e) => restore(e.target.files?.[0])} />
        </label>
        {!!entries?.length && (
          <button className="btn btn-ghost small" onClick={() => setConfirmClear(true)}>
            <Trash2 size={14} /> Clear all
          </button>
        )}
      </div>

      {tenants.list.length > 0 && (
        <div className="chips" role="group" aria-label="Filter by tenant">
          {[["all", "All tenants"] as const, ...tenants.list, ...(tenants.unlabeled ? [[UNLABELED, "Unknown tenant"] as const] : [])].map(([k, label]) => (
            <button key={k} className={`chip ${filter === k ? "chip-active" : ""}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>
              {k !== "all" && k !== UNLABELED && <Tag size={12} aria-hidden="true" />} {label}
            </button>
          ))}
        </div>
      )}

      {entries === null ? null : shown.length === 0 ? (
        <p className="empty">{entries.length ? "Nothing for this tenant yet." : "Nothing yet. Lookups and batches show up here as soon as generation starts or a result comes back."}</p>
      ) : (
        <ul className="history">
          {shown.map((e) => (
            <li key={e.id} className="history-item">
              <button className="history-hit" onClick={() => setOpenId(e.id)}>
                {e.kind === "lookup" ? (
                  <CompanyLogo src={e.data.company.imageUrl} name={e.data.company.name} size={36} />
                ) : (
                  <span className="logo batch-logo" style={{ width: 36, height: 36 }}>
                    {e.data.total >= 1000 ? `${Math.round(e.data.total / 100) / 10}k` : e.data.total}
                  </span>
                )}
                <span className="grow history-main">
                  <span className="strong">{e.title}</span>
                  <span className="match-meta">
                    <Badge>{e.kind === "lookup" ? "Lookup" : "Batch"}</Badge>
                    {e.tenant && (
                      <Badge tone="accent">
                        <Tag size={11} aria-hidden="true" /> {e.tenant}
                      </Badge>
                    )}
                    {e.kind === "lookup" ? (
                      <>
                        <Badge tone={OUTCOME_TONE[e.data.outcome]}>{OUTCOME_LABEL[e.data.outcome]}</Badge>
                        <span className="muted small">{e.data.stakeholders.length} stakeholders</span>
                      </>
                    ) : (
                      <BatchChips summary={e.data} />
                    )}
                  </span>
                </span>
                <span className="muted small nowrap">{ago(e.updatedAt)}</span>
              </button>
              <button className="icon-btn" aria-label={`Delete ${e.title}`} onClick={() => setConfirmDelete(e)}>
                <Trash2 size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title={`Delete "${confirmDelete?.title ?? ""}" from History?`}
        confirmLabel="Delete"
        onConfirm={() => {
          if (confirmDelete) deleteEntry(confirmDelete.id);
          setConfirmDelete(null);
        }}
        onCancel={() => setConfirmDelete(null)}
      >
        <p>
          {confirmDelete?.kind === "batch"
            ? `This removes the saved results for all ${confirmDelete.data.total.toLocaleString()} companies in this batch from this browser.`
            : "This removes the saved result from this browser."}{" "}
          Nothing in Vieu is affected, and running it again brings it back.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmClear}
        title="Clear all history?"
        confirmLabel="Clear history"
        onConfirm={() => {
          clearEntries();
          setConfirmClear(false);
        }}
        onCancel={() => setConfirmClear(false)}
      >
        <p>This removes every saved lookup and batch from this browser. Nothing in Vieu is affected.</p>
      </ConfirmDialog>
    </section>
  );
}

function MismatchDialog({
  pending,
  currentTenant,
  onClose,
}: {
  pending: { entry: HistoryEntry; run: () => void } | null;
  currentTenant?: string;
  onClose: () => void;
}) {
  const saved = pending?.entry.tenant?.trim();
  const now = currentTenant?.trim();
  return (
    <ConfirmDialog
      open={!!pending}
      title="Different tenant?"
      confirmLabel="Use current key"
      onConfirm={() => {
        pending?.run();
        onClose();
      }}
      onCancel={onClose}
    >
      <p>
        This was run {saved ? <>for <strong>{saved}</strong></> : "with a key whose tenant couldn't be identified"}, but the key in this tab{" "}
        {now ? <>is for <strong>{now}</strong></> : "has no identified tenant"}.
      </p>
      <p className="muted small">
        Re-checking uses the key in this tab, so it reads that key&apos;s tenant. Continue only if they&apos;re the same tenant. To use another key, open a new tab.
      </p>
    </ConfirmDialog>
  );
}

function BatchChips({ summary }: { summary: BatchSummary }) {
  return (
    <>
      {(Object.keys(OUTCOME_LABEL) as Outcome[]).map((o) =>
        summary.counts[o] ? (
          <Badge key={o} tone={OUTCOME_TONE[o]}>
            {OUTCOME_LABEL[o]} {summary.counts[o]!.toLocaleString()}
          </Badge>
        ) : null,
      )}
      <span className="muted small">{summary.stakeholders.toLocaleString()} stakeholders</span>
    </>
  );
}
