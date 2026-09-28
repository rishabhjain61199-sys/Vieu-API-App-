"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Download, FileUp, RefreshCw, TriangleAlert, Upload } from "lucide-react";
import { ApiError, formatDuration, isAbort, vieu } from "@/lib/api";
import { downloadFile, MAX_BATCH_ROWS, slugify, TEMPLATE_CSV, toBatchInputs, today, toCsv } from "@/lib/csv";
import { PARAM_LABEL, SEARCH_PARAMS } from "@/lib/detect";
import { newId, saveEntry } from "@/lib/history";
import { pool } from "@/lib/pool";
import { analyze, companyCore, CSV_COLUMNS, stakeholderCsvRows } from "@/lib/stakeholders";
import {
  idParam,
  OUTCOME_LABEL,
  rowToRecord,
  STAGE_OUTCOME,
  type BatchRecord,
  type BatchRow,
  type Company,
  type GenerateResponse,
  type Outcome,
  type StakeholdersResponse,
} from "@/lib/types";
import { Badge, CompanyLogo, ConfirmDialog, Spinner } from "./ui";
import { OUTCOME_TONE, RecordView } from "./Summary";

const CONCURRENCY = 5;
const POLL_MS = 15_000; // per account, never faster
const TICK_MS = 5_000;
const MAX_WAIT_MS = 12 * 60_000;
const WATCHING = new Set(["polling", "timeout", "generating"]);

function blankRow(label: string, inputs: BatchRow["inputs"]): BatchRow {
  return {
    id: newId(), label, inputs, candidates: [], company: null, ambiguous: false, stage: "queued",
    accountId: null, created: false, noAccount: false, stakeholders: [], genStart: null, genEnd: null,
    watchStart: null, joined: false, checkedAt: null,
  };
}

export type ResumeBatch = { id: string; createdAt: number; record: BatchRecord };

export function Batch({
  apiKey,
  onKeyInvalid,
  resume,
}: {
  apiKey: string;
  onKeyInvalid: (msg: string) => void;
  resume: ResumeBatch | null;
}) {
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [tickN, setTickN] = useState(0);
  const rowsRef = useRef<BatchRow[]>([]);
  rowsRef.current = rows;
  const entry = useRef({ id: newId(), createdAt: Date.now() });
  const ac = useRef(new AbortController());
  const fileRef = useRef<HTMLInputElement>(null);

  const preview = useMemo(() => (text.trim() ? toBatchInputs(text) : null), [text]);

  function patch(id: string, p: Partial<BatchRow>) {
    setRows((prev) => {
      const next = prev.map((r) => (r.id === id ? { ...r, ...p } : r));
      rowsRef.current = next;
      return next;
    });
  }

  const opts = () => ({ signal: ac.current.signal, onRateLimit: () => setNotice("Rate limited, retrying") });

  /** Returns true when the whole batch should stop. */
  function handleError(e: unknown, id: string) {
    if (isAbort(e)) return true;
    const ae = e as ApiError;
    if (ae.status === 401) {
      ac.current.abort();
      onKeyInvalid(ae.message);
      return true;
    }
    patch(id, { stage: "error", error: ae.message });
    return false;
  }

  async function checkRow(row: BatchRow) {
    if (!row.company) return;
    const wasWatching = WATCHING.has(row.stage);
    patch(row.id, { stage: "checking", error: undefined });
    const ids = { accountId: row.accountId, companyId: row.company.companyId };
    try {
      const r = await vieu<StakeholdersResponse>(apiKey, "GET", "/accounts/stakeholders", idParam(ids), opts());
      const now = Date.now();
      const base = { accountId: r.accountId ?? ids.accountId, stakeholders: r.stakeholders ?? [], message: r.message, checkedAt: now, noAccount: false };
      if (wasWatching && (r.seedingStatus === "completed" || r.generated)) patch(row.id, { ...base, stage: "completed", genEnd: now });
      else if (r.generated) patch(row.id, { ...base, stage: "seeded" });
      else if (r.seedingStatus === "pending")
        patch(row.id, { ...base, stage: "polling", joined: wasWatching ? row.joined : true, genStart: row.genStart ?? now, watchStart: now });
      else if (r.seedingStatus === "failed") patch(row.id, { ...base, stage: "failed" });
      else patch(row.id, { ...base, stage: "not_started" });
      setNotice(null);
    } catch (e) {
      if ((e as ApiError).status === 404 && !ids.accountId) {
        patch(row.id, { stage: "not_started", noAccount: true, checkedAt: Date.now() });
        return;
      }
      handleError(e, row.id);
    }
  }

  async function resolveRow(row: BatchRow) {
    patch(row.id, { stage: "resolving", error: undefined });
    for (const param of SEARCH_PARAMS.filter((p) => row.inputs[p])) {
      try {
        const res = await vieu<{ companies: Company[] }>(apiKey, "GET", "/accounts/search", { [param]: row.inputs[param]! }, opts());
        const candidates = (res.companies ?? []).slice(0, 5);
        if (!candidates.length) continue;
        const q = row.inputs.query ? companyCore(row.inputs.query) : "";
        const exact = q ? candidates.filter((c) => companyCore(c.name) === q) : [];
        const company = exact[0] ?? candidates[0];
        // A name alone is the only input that can land on the wrong company.
        // "Merck" matches both Merck & Co. and Merck KGaA exactly, so that still needs review.
        const ambiguous = param === "query" && candidates.length > 1 && exact.length !== 1;
        const next = { candidates, company, matchedBy: param, ambiguous, accountId: company.accountId };
        patch(row.id, next);
        return checkRow({ ...row, ...next });
      } catch (e) {
        if ((e as ApiError).status === 404) continue;
        handleError(e, row.id);
        return;
      }
    }
    patch(row.id, { stage: "no_match" });
  }

  async function generate(targets: BatchRow[]) {
    setConfirming(false);
    await pool(targets, CONCURRENCY, async (row) => {
      patch(row.id, { stage: "generating", error: undefined });
      try {
        const g = await vieu<GenerateResponse>(
          apiKey, "POST", "/accounts/stakeholders/generate",
          idParam({ accountId: row.accountId, companyId: row.company!.companyId }), opts(),
        );
        const now = Date.now();
        patch(row.id, {
          stage: "polling", created: row.created || !!g.created, accountId: g.accountId ?? row.accountId,
          noAccount: false, joined: false, genStart: now, genEnd: null, watchStart: now, checkedAt: now,
        });
      } catch (e) {
        handleError(e, row.id);
      }
    });
  }

  async function tick() {
    const now = Date.now();
    const due = rowsRef.current.filter(
      (r) => r.stage === "polling" && now - Math.max(r.checkedAt ?? 0, r.watchStart ?? 0) >= POLL_MS,
    );
    await pool(due, CONCURRENCY, async (row) => {
      const timedOut = () => Date.now() - (row.watchStart ?? 0) >= MAX_WAIT_MS;
      try {
        const r = await vieu<StakeholdersResponse>(
          apiKey, "GET", "/accounts/stakeholders",
          idParam({ accountId: row.accountId, companyId: row.company!.companyId }), opts(),
        );
        const base = { accountId: r.accountId ?? row.accountId, stakeholders: r.stakeholders ?? [], message: r.message, checkedAt: Date.now(), error: undefined };
        if (r.seedingStatus === "completed" || (r.generated && r.seedingStatus !== "pending"))
          patch(row.id, { ...base, stage: "completed", genEnd: Date.now() });
        else if (r.seedingStatus === "failed") patch(row.id, { ...base, stage: "failed" });
        else patch(row.id, { ...base, ...(timedOut() ? { stage: "timeout" as const } : {}) });
      } catch (e) {
        if (isAbort(e)) return;
        const ae = e as ApiError;
        if (ae.status === 401 || ae.status === 403) return void handleError(e, row.id);
        patch(row.id, { checkedAt: Date.now(), error: `${ae.message}. Still watching`, ...(timedOut() ? { stage: "timeout" as const } : {}) });
      }
    });
  }

  const anyPolling = rows.some((r) => r.stage === "polling");
  const busy = rows.some((r) => r.stage === "generating" || anyPolling);

  useEffect(() => {
    if (!anyPolling) return;
    const t = setTimeout(async () => {
      await tick();
      setTickN((n) => n + 1);
    }, TICK_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyPolling, tickN]);

  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  useEffect(() => () => ac.current.abort(), []);

  // Persist to history (debounced) whenever rows change.
  useEffect(() => {
    if (!rows.length) return;
    const t = setTimeout(() => {
      saveEntry({
        id: entry.current.id, kind: "batch", title: name, createdAt: entry.current.createdAt,
        updatedAt: Date.now(), data: { name, rows },
      });
    }, 800);
    return () => clearTimeout(t);
  }, [rows, name]);

  // Resume a batch opened from History: re-check anything that wasn't final.
  useEffect(() => {
    if (!resume) return;
    ac.current.abort();
    ac.current = new AbortController();
    entry.current = { id: resume.id, createdAt: resume.createdAt };
    setName(resume.record.name);
    const restored = resume.record.rows.map((r) => ({ ...r }));
    setRows(restored);
    rowsRef.current = restored;
    const stale = restored.filter((r) => !["seeded", "completed", "no_match"].includes(r.stage));
    pool(stale, CONCURRENCY, (r) => (r.company ? checkRow(r) : resolveRow(r)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resume]);

  function start(source: string, label: string) {
    const { items, truncated } = toBatchInputs(source);
    if (!items.length) {
      setImportError("No companies found. Use one per line, or a CSV with a name, domain or LinkedIn column.");
      return;
    }
    ac.current.abort();
    ac.current = new AbortController();
    entry.current = { id: newId(), createdAt: Date.now() };
    const fresh = items.map((it) => blankRow(it.label, it.inputs));
    setRows(fresh);
    rowsRef.current = fresh;
    setName(`${label} (${fresh.length} ${fresh.length === 1 ? "company" : "companies"})`);
    setImportError(truncated ? `Only the first ${MAX_BATCH_ROWS} rows were imported.` : null);
    setText("");
    pool(fresh, CONCURRENCY, resolveRow);
  }

  async function onFile(f: File | undefined) {
    if (!f) return;
    if (f.size > 2_000_000) return setImportError("That file is over 2 MB. Split it into smaller batches.");
    start(await f.text(), f.name.replace(/\.(csv|tsv|txt)$/i, ""));
  }

  function reset() {
    ac.current.abort();
    ac.current = new AbortController();
    setRows([]);
    setName("");
    setNotice(null);
  }

  const eligible = rows.filter((r) => r.company && !r.ambiguous && (r.stage === "not_started" || r.stage === "failed"));
  const willCreate = eligible.filter((r) => !r.accountId).length;
  const needsReview = rows.filter((r) => r.ambiguous && (r.stage === "not_started" || r.stage === "failed")).length;

  if (!rows.length) {
    return (
      <section className="card">
        <p className="eyebrow">Batch</p>
        <h2>Look up many companies at once</h2>
        <p className="muted">
          Upload a CSV or paste a list. Each row can use a name, domain, email, LinkedIn URL, company id or account id. When a row has several, the most precise one is used.
        </p>
        <div
          className={`dropzone ${dragging ? "dropzone-active" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            onFile(e.dataTransfer.files[0]);
          }}
        >
          <FileUp size={28} aria-hidden="true" />
          <p>
            Drop a CSV here or{" "}
            <button className="link-btn" onClick={() => fileRef.current?.click()}>
              choose a file
            </button>
          </p>
          <p className="muted small">Columns like name, domain, website, linkedin_url, company_id, account_id are detected automatically.</p>
          <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,text/csv" hidden onChange={(e) => onFile(e.target.files?.[0])} />
        </div>
        <div className="or">or paste a list</div>
        <textarea
          className="textarea"
          rows={6}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"merck.com\nStripe\nhttps://www.linkedin.com/company/datadog\njane@snowflake.com"}
          aria-label="Companies, one per line"
        />
        {preview && (
          <p className="hint">
            {preview.items.length} {preview.items.length === 1 ? "company" : "companies"} detected
            {preview.mapped.length > 0 && <> · columns: {preview.mapped.join(", ")}</>}
            {countBy(preview.items.map((i) => SEARCH_PARAMS.find((p) => i.inputs[p])!))}
          </p>
        )}
        {importError && <p className="error-text">{importError}</p>}
        <div className="row gap wrap">
          <button className="btn btn-primary" disabled={!preview?.items.length} onClick={() => start(text, "Pasted list")}>
            <Upload size={16} /> Run batch
          </button>
          <button className="btn btn-ghost small" onClick={() => downloadFile("stakeholder_batch_template.csv", TEMPLATE_CSV)}>
            <Download size={14} /> CSV template
          </button>
        </div>
      </section>
    );
  }

  return (
    <>
      {importError && <p className="warn-text">{importError}</p>}
      <BatchView
        name={name}
        rows={rows}
        notice={notice}
        live={{
          eligible: eligible.length,
          needsReview,
          onGenerate: () => setConfirming(true),
          onCheckAgain: () =>
            rows.filter((r) => r.stage === "timeout").forEach((r) => patch(r.id, { stage: "polling", watchStart: Date.now(), checkedAt: 0 })),
          onRetry: (r) => (r.company ? checkRow(r) : resolveRow(r)),
          onGenerateRow: (r) => generate([r]),
          onPick: (r, c) => {
            const next = { ...r, company: c, ambiguous: false, accountId: c.accountId, created: false, stakeholders: [] };
            patch(r.id, next);
            checkRow(next);
          },
          onConfirmMatch: (r) => patch(r.id, { ambiguous: false }),
          onReset: reset,
        }}
      />
      <ConfirmDialog
        open={confirming}
        title={`Generate stakeholders for ${eligible.length} ${eligible.length === 1 ? "company" : "companies"}?`}
        confirmLabel="Generate"
        onConfirm={() => generate(eligible)}
        onCancel={() => setConfirming(false)}
      >
        <p>This writes to the tenant your key belongs to. It starts power pod seeding for each of them.</p>
        {willCreate > 0 && (
          <p>
            {willCreate === 1 ? "1 of them has no account yet, so one will be created." : `${willCreate} of them have no account yet, so an account will be created for each.`}
          </p>
        )}
        {needsReview > 0 && <p className="warn-text">{needsReview} rows with an uncertain match are skipped until you confirm them.</p>}
        <p className="muted small">Each usually takes under 10 minutes. They run in parallel and you can watch them here.</p>
      </ConfirmDialog>
    </>
  );
}

function countBy(params: string[]) {
  const counts: Record<string, number> = {};
  for (const p of params) counts[p] = (counts[p] ?? 0) + 1;
  const parts = Object.entries(counts).map(([p, n]) => `${n} by ${PARAM_LABEL[p as keyof typeof PARAM_LABEL]}`);
  return parts.length ? <> · {parts.join(", ")}</> : null;
}

const STAGE_BADGE: Record<BatchRow["stage"], { label: string; tone: string }> = {
  queued: { label: "Queued", tone: "neutral" },
  resolving: { label: "Finding company", tone: "neutral" },
  checking: { label: "Checking", tone: "neutral" },
  no_match: { label: "No match", tone: "bad" },
  error: { label: "Error", tone: "bad" },
  generating: { label: "Starting seed", tone: "accent" },
  seeded: { label: OUTCOME_LABEL.already_seeded, tone: OUTCOME_TONE.already_seeded },
  completed: { label: OUTCOME_LABEL.newly_generated, tone: OUTCOME_TONE.newly_generated },
  polling: { label: OUTCOME_LABEL.seed_in_progress, tone: OUTCOME_TONE.seed_in_progress },
  timeout: { label: OUTCOME_LABEL.still_generating, tone: OUTCOME_TONE.still_generating },
  failed: { label: OUTCOME_LABEL.failed, tone: OUTCOME_TONE.failed },
  not_started: { label: OUTCOME_LABEL.not_generated, tone: OUTCOME_TONE.not_generated },
};

type LiveActions = {
  eligible: number;
  needsReview: number;
  onGenerate: () => void;
  onCheckAgain: () => void;
  onRetry: (r: BatchRow) => void;
  onGenerateRow: (r: BatchRow) => void;
  onPick: (r: BatchRow, c: Company) => void;
  onConfirmMatch: (r: BatchRow) => void;
  onReset: () => void;
};

/** Batch summary, table, exports and row detail. Without `live` it is a read-only view (History). */
export function BatchView({
  name,
  rows,
  notice,
  live,
  extraActions,
}: {
  name: string;
  rows: BatchRow[];
  notice?: string | null;
  live?: LiveActions;
  extraActions?: React.ReactNode;
}) {
  const [detailId, setDetailId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const polling = rows.filter((r) => r.stage === "polling" || r.stage === "generating");
  const working = rows.filter((r) => ["queued", "resolving", "checking"].includes(r.stage)).length;

  useEffect(() => {
    if (!polling.length) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [polling.length]);

  const outcomes = useMemo(() => {
    const c: Partial<Record<Outcome | "unresolved", number>> = {};
    for (const r of rows) {
      const o = STAGE_OUTCOME[r.stage] ?? (r.stage === "no_match" || r.stage === "error" ? "unresolved" : null);
      if (o) c[o] = (c[o] ?? 0) + 1;
    }
    return c;
  }, [rows]);
  const totalPeople = rows.reduce((n, r) => n + r.stakeholders.length, 0);
  const createdCount = rows.filter((r) => r.created).length;
  const timeouts = rows.filter((r) => r.stage === "timeout").length;

  const detail = rows.find((r) => r.id === detailId);
  const detailRecord = detail ? rowToRecord(detail) : null;
  if (detail && detailRecord) {
    return (
      <>
        <button className="btn btn-ghost small back" onClick={() => setDetailId(null)}>
          <ArrowLeft size={14} /> Back to batch
        </button>
        <RecordView record={detailRecord} />
      </>
    );
  }

  function exportAll() {
    const lines: unknown[][] = [[...CSV_COLUMNS]];
    for (const r of rows) {
      const rec = rowToRecord(r);
      if (!rec || !rec.stakeholders.length) continue;
      const { pods } = analyze(rec.stakeholders, { name: rec.company.name, domain: rec.domain });
      lines.push(...stakeholderCsvRows(pods, { company: rec.company.name, companyId: rec.company.companyId, accountId: rec.accountId ?? "", outcome: rec.outcome }));
    }
    downloadFile(`batch_${slugify(name)}_stakeholders_${today()}.csv`, toCsv(lines));
  }

  function exportSummary() {
    const lines: unknown[][] = [[
      "input", "company", "companyId", "accountId", "matchedBy", "matchCheck", "account", "outcome",
      "stakeholders", "pods", "generationTime", "error",
    ]];
    for (const r of rows) {
      const rec = rowToRecord(r);
      lines.push([
        r.label, r.company?.name ?? "", r.company?.companyId ?? "", r.accountId ?? "", r.matchedBy ?? "",
        r.ambiguous ? "review" : r.company ? "ok" : "", r.created ? "created_now" : r.accountId ? "existing" : r.company ? "none" : "",
        rec?.outcome ?? r.stage, r.stakeholders.length, new Set(r.stakeholders.map((s) => String(s.swimlane ?? ""))).size || 0,
        rec?.genMs != null ? formatDuration(rec.genMs) : "", r.error ?? "",
      ]);
    }
    downloadFile(`batch_${slugify(name)}_summary_${today()}.csv`, toCsv(lines));
  }

  return (
    <>
      <section className="card">
        <div className="summary-head">
          <div className="grow">
            <p className="eyebrow">Batch summary</p>
            <h2>{name}</h2>
          </div>
          <div className="row gap wrap">
            {extraActions}
            {live && (
              <button className="btn btn-ghost small" onClick={live.onReset} disabled={polling.length > 0}>
                New batch
              </button>
            )}
          </div>
        </div>
        <dl className="fields">
          <div>
            <dt>Companies</dt>
            <dd className="kpi">{rows.length}</dd>
          </div>
          <div>
            <dt>Total stakeholders</dt>
            <dd className="kpi">{totalPeople}</dd>
          </div>
          <div>
            <dt>Accounts created</dt>
            <dd className="kpi">{createdCount}</dd>
          </div>
          {working > 0 && (
            <div>
              <dt>Still checking</dt>
              <dd className="kpi">
                {working} <Spinner size={16} />
              </dd>
            </div>
          )}
        </dl>
        <div className="chips">
          {(Object.keys(OUTCOME_LABEL) as Outcome[]).map((o) =>
            outcomes[o] ? (
              <Badge key={o} tone={OUTCOME_TONE[o]}>
                {OUTCOME_LABEL[o]} {outcomes[o]}
              </Badge>
            ) : null,
          )}
          {outcomes.unresolved ? <Badge tone="bad">Unresolved {outcomes.unresolved}</Badge> : null}
        </div>

        {polling.length > 0 && (
          <p className="note">
            Generating for {polling.length} {polling.length === 1 ? "company" : "companies"}. Each is checked every 15s for up to 12 minutes. You can leave this tab open. Refreshing it clears your key, but you can resume from History.
          </p>
        )}
        {notice && <p className="warn-text">{notice}</p>}

        <div className="row gap wrap">
          {live && live.eligible > 0 && (
            <button className="btn btn-primary" onClick={live.onGenerate}>
              Generate for {live.eligible}
            </button>
          )}
          {live && timeouts > 0 && (
            <button className="btn btn-ghost" onClick={live.onCheckAgain}>
              <RefreshCw size={16} /> Check again ({timeouts})
            </button>
          )}
          <button className="btn btn-ghost" onClick={exportAll} disabled={!totalPeople}>
            <Download size={16} /> Export all stakeholders
          </button>
          <button className="btn btn-ghost" onClick={exportSummary}>
            <Download size={16} /> Export summary
          </button>
        </div>
        {live && live.needsReview > 0 && (
          <p className="warn-text">
            <TriangleAlert size={14} /> {live.needsReview} {live.needsReview === 1 ? "row matched" : "rows matched"} by name only with several candidates. Confirm the match before generating.
          </p>
        )}
      </section>

      <section className="card table-card">
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Input</th>
                <th>Matched company</th>
                <th>Account</th>
                <th>Stakeholders</th>
                <th className="num">People</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const badge = STAGE_BADGE[r.stage];
                const canView = r.stakeholders.length > 0;
                return (
                  <tr key={r.id} className={r.ambiguous ? "row-review" : undefined}>
                    <td className="cell-input">
                      <span className="truncate" title={r.label}>{r.label}</span>
                      {r.matchedBy && <span className="muted small">by {PARAM_LABEL[r.matchedBy]}</span>}
                    </td>
                    <td>
                      {r.company ? (
                        <div className="cell-company">
                          <CompanyLogo src={r.company.imageUrl} name={r.company.name} size={28} />
                          <div className="cell-company-main">
                            {live && r.candidates.length > 1 && !WATCHING.has(r.stage) ? (
                              <select
                                className="select"
                                value={r.company.companyId}
                                onChange={(e) => {
                                  const c = r.candidates.find((x) => x.companyId === e.target.value);
                                  if (c) live.onPick(r, c);
                                }}
                                aria-label={`Match for ${r.label}`}
                              >
                                {r.candidates.map((c) => (
                                  <option key={c.companyId} value={c.companyId}>
                                    {c.name}
                                    {c.verified ? " (verified)" : ""}
                                    {c.hasAccountPlan ? " · has plan" : ""}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <span className="strong">{r.company.name}</span>
                            )}
                            {r.ambiguous && (
                              <span className="review">
                                Check match
                                {live && (
                                  <button className="link-btn" onClick={() => live.onConfirmMatch(r)}>
                                    Looks right
                                  </button>
                                )}
                              </span>
                            )}
                          </div>
                        </div>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      {r.created ? <Badge tone="accent">Created now</Badge> : r.accountId ? <Badge tone="good">Existing</Badge> : r.company ? <Badge>None yet</Badge> : null}
                    </td>
                    <td>
                      <Badge tone={badge.tone}>
                        {["resolving", "checking", "generating", "polling"].includes(r.stage) && <Spinner size={12} />}
                        {badge.label}
                      </Badge>
                      {r.stage === "polling" && r.genStart && <span className="muted small"> {formatDuration(now - r.genStart)}</span>}
                      {r.stage === "completed" && r.genStart && r.genEnd && <span className="muted small"> in {formatDuration(r.genEnd - r.genStart)}</span>}
                      {r.error && <div className="error-text small">{r.error}</div>}
                    </td>
                    <td className="num">{r.stakeholders.length || ""}</td>
                    <td className="cell-actions">
                      {canView && (
                        <button className="btn btn-ghost small" onClick={() => setDetailId(r.id)}>
                          View
                        </button>
                      )}
                      {live && r.company && !r.ambiguous && (r.stage === "not_started" || r.stage === "failed") && (
                        <button className="btn btn-ghost small" onClick={() => live.onGenerateRow(r)}>
                          Generate
                        </button>
                      )}
                      {live && (r.stage === "error" || r.stage === "no_match") && (
                        <button className="btn btn-ghost small" onClick={() => live.onRetry(r)}>
                          Retry
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
