"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, RefreshCw, Trash2 } from "lucide-react";
import {
  clearEntries,
  deleteEntry,
  HISTORY_EVENT,
  isSavingEnabled,
  listEntries,
  setSavingEnabled,
  type HistoryEntry,
} from "@/lib/history";
import { OUTCOME_LABEL, STAGE_OUTCOME, type Company, type Outcome } from "@/lib/types";
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

export function History({
  hasKey,
  onResumeBatch,
  onRerunLookup,
}: {
  hasKey: boolean;
  onResumeBatch: (b: ResumeBatch) => void;
  onRerunLookup: (c: Company, domain?: string) => void;
}) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [saving, setSaving] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    const load = () => {
      setSaving(isSavingEnabled());
      listEntries().then(setEntries);
    };
    load();
    window.addEventListener(HISTORY_EVENT, load);
    return () => window.removeEventListener(HISTORY_EVENT, load);
  }, []);

  const open = entries?.find((e) => e.id === openId);
  const needKey = hasKey ? undefined : "Paste your key first";

  if (open) {
    return (
      <div className="stack">
        <button className="btn btn-ghost small back" onClick={() => setOpenId(null)}>
          <ArrowLeft size={14} /> Back to history
        </button>
        {open.kind === "lookup" ? (
          <RecordView
            record={open.data}
            actions={
              <button className="btn btn-ghost" disabled={!hasKey} title={needKey} onClick={() => onRerunLookup(open.data.company, open.data.domain)}>
                <RefreshCw size={16} /> Run again
              </button>
            }
          />
        ) : (
          <BatchView
            name={open.data.name}
            rows={open.data.rows}
            extraActions={
              <button
                className="btn btn-ghost small"
                disabled={!hasKey}
                title={needKey}
                onClick={() => onResumeBatch({ id: open.id, createdAt: open.createdAt, record: open.data })}
              >
                <RefreshCw size={14} /> Resume and re-check
              </button>
            }
          />
        )}
      </div>
    );
  }

  return (
    <section className="card">
      <div className="summary-head">
        <div className="grow">
          <p className="eyebrow">History</p>
          <h2>Previous lookups and batches</h2>
          <p className="muted small">Saved in this browser only. Your API key is never saved.</p>
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            checked={saving}
            onChange={(e) => {
              setSavingEnabled(e.target.checked);
              setSaving(e.target.checked);
            }}
          />
          Save new runs
        </label>
        {!!entries?.length && (
          <button className="btn btn-ghost small" onClick={() => setConfirmClear(true)}>
            <Trash2 size={14} /> Clear all
          </button>
        )}
      </div>

      {entries === null ? null : entries.length === 0 ? (
        <p className="empty">Nothing yet. Lookups and batches show up here once they finish.</p>
      ) : (
        <ul className="history">
          {entries.map((e) => (
            <li key={e.id} className="history-item">
              <button className="history-hit" onClick={() => setOpenId(e.id)}>
                {e.kind === "lookup" ? (
                  <CompanyLogo src={e.data.company.imageUrl} name={e.data.company.name} size={36} />
                ) : (
                  <span className="logo batch-logo" style={{ width: 36, height: 36 }}>
                    {e.data.rows.length}
                  </span>
                )}
                <span className="grow history-main">
                  <span className="strong">{e.title}</span>
                  <span className="match-meta">
                    <Badge>{e.kind === "lookup" ? "Lookup" : "Batch"}</Badge>
                    {e.kind === "lookup" ? (
                      <>
                        <Badge tone={OUTCOME_TONE[e.data.outcome]}>{OUTCOME_LABEL[e.data.outcome]}</Badge>
                        <span className="muted small">{e.data.stakeholders.length} stakeholders</span>
                      </>
                    ) : (
                      <BatchChips rows={e.data.rows} />
                    )}
                  </span>
                </span>
                <span className="muted small nowrap">{ago(e.updatedAt)}</span>
              </button>
              <button className="icon-btn" aria-label={`Delete ${e.title}`} onClick={() => deleteEntry(e.id)}>
                <Trash2 size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}

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

function BatchChips({ rows }: { rows: { stage: keyof typeof STAGE_OUTCOME | string; stakeholders: unknown[] }[] }) {
  const counts: Partial<Record<Outcome, number>> = {};
  for (const r of rows) {
    const o = STAGE_OUTCOME[r.stage as keyof typeof STAGE_OUTCOME];
    if (o) counts[o] = (counts[o] ?? 0) + 1;
  }
  return (
    <>
      {(Object.keys(counts) as Outcome[]).map((o) => (
        <Badge key={o} tone={OUTCOME_TONE[o]}>
          {OUTCOME_LABEL[o]} {counts[o]}
        </Badge>
      ))}
      <span className="muted small">{rows.reduce((n, r) => n + r.stakeholders.length, 0)} stakeholders</span>
    </>
  );
}
