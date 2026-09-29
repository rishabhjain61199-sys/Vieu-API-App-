"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowUp, BadgeCheck, ChevronsUpDown, Download, FileUp, ListChecks, RefreshCw, TriangleAlert, Upload } from "lucide-react";
import { ApiError, formatDuration, isAbort, vieu } from "@/lib/api";
import { downloadFile, MAX_BATCH_ROWS, slugify, TEMPLATE_CSV, toBatchInputs, today, toCsv } from "@/lib/csv";
import { PARAM_LABEL, SEARCH_PARAMS, type Detected } from "@/lib/detect";
import { newId, saveBatch } from "@/lib/history";
import { useWakeLock, wakeLockSupported } from "@/lib/wakelock";
import { announce, primeAudio, setGenerating } from "@/lib/notify";
import { pool } from "@/lib/pool";
import { analyze, companyCore, csvHeader, extraFields, stakeholderCsvRows } from "@/lib/stakeholders";
import {
  idParam,
  OUTCOME_LABEL,
  rowToRecord,
  STAGE_OUTCOME,
  type BatchRow,
  type Company,
  type CompanyProfile,
  type GenerateResponse,
  type Outcome,
  type StakeholdersResponse,
} from "@/lib/types";
import { Badge, CompanyFacts, CompanyLogo, ConfirmDialog, Spinner } from "./ui";
import { OUTCOME_TONE, RecordView } from "./Summary";
import { NotifyOptions } from "./NotifyOptions";
import { MatchPicker, type CandidateDetails } from "./MatchPicker";

// Lookups/checks in flight; the shared limiter in lib/api keeps the tenant under its rate limit.
const CONCURRENCY = 8;
/** Seeds running in Vieu at once (the API docs set no limit; kept modest and adjustable). */
export const DEFAULT_MAX_SEEDS = 50;
const SAVE_EVERY_MS = 1500;
const WAKE_GAP_MS = 60_000; // a tick this late means the laptop slept
const POLL_MS = 15_000; // per account, never faster
const TICK_MS = 5_000;
const MAX_WAIT_MS = 12 * 60_000;
const WATCHING = new Set(["polling", "timeout", "generating", "gen_queued"]);
const PAGE_ROWS = 100;
const BUSY = new Set(["queued", "resolving", "checking"]);
const NOT_LISTED = "__not_listed__";

function blankRow(label: string, inputs: BatchRow["inputs"]): BatchRow {
  return {
    id: newId(), label, inputs, candidates: [], company: null, ambiguous: false, stage: "queued",
    accountId: null, created: false, noAccount: false, stakeholders: [], genStart: null, genEnd: null,
    watchStart: null, joined: false, checkedAt: null,
  };
}

export type ResumeBatch = { id: string; createdAt: number; name: string; rows: BatchRow[]; maxSeeds?: number };

export function Batch({
  apiKey,
  tenant,
  onKeyInvalid,
  resume,
  onViewStakeholders,
}: {
  apiKey: string;
  tenant?: string;
  onKeyInvalid: (msg: string) => void;
  resume: ResumeBatch | null;
  onViewStakeholders?: (companyId: string) => void;
}) {
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Rows waiting for the "Generate for N?" confirmation (all eligible, or a bulk selection).
  const [confirmTargets, setConfirmTargets] = useState<BatchRow[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const [tickN, setTickN] = useState(0);
  const [maxSeeds, setMaxSeeds] = useState(DEFAULT_MAX_SEEDS);
  const [keepAwake, setKeepAwake] = useState(true);
  const rowsRef = useRef<BatchRow[]>([]);
  rowsRef.current = rows;
  const entry = useRef({ id: newId(), createdAt: Date.now() });
  const ac = useRef(new AbortController());
  const fileRef = useRef<HTMLInputElement>(null);
  // Rows changed / removed since the last save (only these are written to History).
  const dirty = useRef(new Set<string>());
  const removed = useRef(new Set<string>());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTick = useRef(Date.now());

  const preview = useMemo(() => (text.trim() ? toBatchInputs(text, "paste") : null), [text]);

  function patch(id: string, p: Partial<BatchRow>) {
    dirty.current.add(id);
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
    // Profile (domain, size, HQ) in parallel, so lookalike matches are easy to spot.
    if (row.profile === undefined || row.profile?.companyId !== ids.companyId) {
      const companyId = ids.companyId;
      vieu<{ profile?: CompanyProfile }>(apiKey, "GET", "/accounts/profile", { companyId }, opts())
        .then((r) => {
          // Ignore if the user has since picked a different match for this row.
          if (rowsRef.current.find((x) => x.id === row.id)?.company?.companyId === companyId)
            patch(row.id, { profile: r.profile ? { ...r.profile, companyId } : null });
        })
        .catch(() => {});
    }
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

  /** Queue rows for generation; the scheduler below starts them `maxSeeds` at a time. */
  function generate(targets: BatchRow[]) {
    setConfirmTargets(null);
    for (const row of targets) patch(row.id, { stage: "gen_queued", error: undefined });
  }

  async function startSeed(row: BatchRow) {
    patch(row.id, { stage: "generating", error: undefined });
    {
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
    }
  }

  // Scheduler: keep up to `maxSeeds` seeds running (started here or found already pending).
  useEffect(() => {
    const running = rows.filter((r) => r.stage === "generating" || r.stage === "polling").length;
    const slots = maxSeeds - running;
    if (slots <= 0) return;
    rows.filter((r) => r.stage === "gen_queued").slice(0, slots).forEach(startSeed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, maxSeeds]);

  async function tick() {
    const now = Date.now();
    // Woke from sleep (lid closed): time asleep doesn't count toward the 12-minute watch,
    // and anything that timed out meanwhile is checked again right away.
    const gap = now - lastTick.current;
    lastTick.current = now;
    if (gap > WAKE_GAP_MS) {
      for (const r of rowsRef.current) {
        if (r.stage === "polling") patch(r.id, { watchStart: (r.watchStart ?? now) + gap, checkedAt: 0 });
        if (r.stage === "timeout") patch(r.id, { stage: "polling", watchStart: now, checkedAt: 0 });
      }
      return;
    }
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
  const busy = rows.some((r) => r.stage === "generating" || r.stage === "gen_queued") || anyPolling;
  useWakeLock(busy && keepAwake);

  useEffect(() => {
    if (!anyPolling) return;
    lastTick.current = Math.max(lastTick.current, Date.now() - TICK_MS);
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

  // Tab title while seeds run; one alert when the last watched seed in the batch ends.
  const activeCount = rows.filter((r) => r.stage === "polling" || r.stage === "generating" || r.stage === "gen_queued").length;
  const wasActive = useRef(false);
  useEffect(() => {
    setGenerating("batch", activeCount);
    if (activeCount > 0) {
      wasActive.current = true;
      return;
    }
    if (!wasActive.current) return;
    wasActive.current = false;
    const count = (s: BatchRow["stage"]) => rowsRef.current.filter((r) => r.stage === s).length;
    const parts = [
      count("completed") && `${count("completed")} newly generated`,
      count("seeded") && `${count("seeded")} already seeded`,
      count("failed") && `${count("failed")} failed`,
      count("timeout") && `${count("timeout")} still generating`,
    ].filter(Boolean);
    announce({ tag: `batch-${entry.current.id}`, title: `Batch done: ${name}`, body: parts.join(" · ") || "All rows finished." });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCount]);

  useEffect(() => () => setGenerating("batch", 0), []);

  // Save to History: at most every 1.5s, writing only the rows that changed. The batch is one
  // History entry however many companies it has; each company is stored under it.
  const latest = useRef({ name, tenant, maxSeeds });
  latest.current = { name, tenant, maxSeeds };
  function flush() {
    saveTimer.current = null;
    const all = rowsRef.current;
    if (!all.length && !removed.current.size) return;
    const index = new Map(all.map((r, i) => [r.id, i]));
    const dirtyRows = [...dirty.current].flatMap((id) => (index.has(id) ? [{ row: all[index.get(id)!], i: index.get(id)! }] : []));
    const gone = [...removed.current];
    dirty.current.clear();
    removed.current.clear();
    saveBatch({
      id: entry.current.id, createdAt: entry.current.createdAt, tenant: latest.current.tenant, name: latest.current.name,
      rows: all, dirty: dirtyRows, removed: gone, maxSeeds: latest.current.maxSeeds,
    });
  }
  useEffect(() => {
    if (!rows.length && !removed.current.size) return;
    if (!saveTimer.current) saveTimer.current = setTimeout(flush, SAVE_EVERY_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, name, tenant, maxSeeds]);
  // Write anything pending if this view goes away (key cleared, etc.).
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (dirty.current.size || removed.current.size) flush();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Resume a batch opened from History: re-check anything that wasn't final.
  useEffect(() => {
    if (!resume) return;
    ac.current.abort();
    ac.current = new AbortController();
    entry.current = { id: resume.id, createdAt: resume.createdAt };
    dirty.current.clear();
    removed.current.clear();
    setName(resume.name);
    if (resume.maxSeeds) setMaxSeeds(resume.maxSeeds);
    const restored = resume.rows.map((r) => ({ ...r }));
    setRows(restored);
    rowsRef.current = restored;
    // Queued rows stay queued (the scheduler picks them up); anything else unfinished is re-checked.
    const stale = restored.filter((r) => !["seeded", "completed", "no_match", "gen_queued"].includes(r.stage));
    pool(stale, CONCURRENCY, (r) => (r.company ? checkRow(r) : resolveRow(r)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resume]);

  // Match picker: profile + stakeholder status per candidate, fetched once and shared.
  const detailPromises = useRef(new Map<string, Promise<CandidateDetails>>());
  const detailCache = useRef(new Map<string, CandidateDetails>());
  function candidateDetails(c: Company): Promise<CandidateDetails> {
    const hit = detailPromises.current.get(c.companyId);
    if (hit) return hit;
    const signal = ac.current.signal;
    const profile = vieu<{ profile?: CompanyProfile }>(apiKey, "GET", "/accounts/profile", { companyId: c.companyId }, { signal })
      .then((r) => (r.profile ? { ...r.profile, companyId: c.companyId } : null))
      .catch(() => null);
    const status = vieu<StakeholdersResponse>(apiKey, "GET", "/accounts/stakeholders", idParam(c), { signal })
      .then((r): CandidateDetails["status"] =>
        r.generated
          ? { kind: "seeded", count: r.stakeholders?.length ?? 0 }
          : r.seedingStatus === "pending"
            ? { kind: "pending" }
            : r.seedingStatus === "failed"
              ? { kind: "failed" }
              : { kind: "not_started" },
      )
      .catch((e): CandidateDetails["status"] => ((e as ApiError).status === 404 ? { kind: "no_account" } : { kind: "unknown" }));
    const p = Promise.all([profile, status]).then(([pr, st]) => {
      const d = { profile: pr, status: st };
      detailCache.current.set(c.companyId, d);
      return d;
    });
    detailPromises.current.set(c.companyId, p);
    return p;
  }

  async function searchCompanies(d: Detected): Promise<Company[]> {
    const res = await vieu<{ companies: Company[] }>(apiKey, "GET", "/accounts/search", { [d.param]: d.value }, opts());
    return (res.companies ?? []).slice(0, 5);
  }

  function start(source: string, label: string, kind: "paste" | "file" = "file") {
    const { items, truncated } = toBatchInputs(source, kind);
    if (!items.length) {
      setImportError("No companies found. Use one per line, or a CSV with a name, domain or LinkedIn column.");
      return;
    }
    if (dirty.current.size || removed.current.size) flush();
    ac.current.abort();
    ac.current = new AbortController();
    entry.current = { id: newId(), createdAt: Date.now() };
    const fresh = items.map((it) => blankRow(it.label, it.inputs));
    dirty.current = new Set(fresh.map((r) => r.id));
    removed.current.clear();
    setRows(fresh);
    rowsRef.current = fresh;
    setName(`${label} (${fresh.length} ${fresh.length === 1 ? "company" : "companies"})`);
    setImportError(truncated ? `Only the first ${MAX_BATCH_ROWS} rows were imported.` : null);
    setText("");
    pool(fresh, CONCURRENCY, resolveRow);
  }

  async function onFile(f: File | undefined) {
    if (!f) return;
    if (f.size > 5_000_000) return setImportError("That file is over 5 MB. Split it into smaller batches.");
    start(await f.text(), f.name.replace(/\.(csv|tsv|txt)$/i, ""));
  }

  function removeRows(ids: string[]) {
    const drop = new Set(ids);
    for (const id of ids) removed.current.add(id);
    setRows((prev) => {
      const out = prev.filter((x) => !drop.has(x.id));
      rowsRef.current = out;
      return out;
    });
  }

  function reset() {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (dirty.current.size || removed.current.size) flush();
    ac.current.abort();
    ac.current = new AbortController();
    setRows([]);
    setName("");
    setNotice(null);
  }

  const eligible = rows.filter((r) => r.company && !r.ambiguous && (r.stage === "not_started" || r.stage === "failed"));
  const targets = confirmTargets ?? [];
  const willCreate = targets.filter((r) => !r.accountId).length;
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
        <div className="or">or paste a list, one per line or separated by commas</div>
        <textarea
          className="textarea"
          rows={6}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"merck.com, Stripe, NVIDIA\nhttps://www.linkedin.com/company/datadog\njane@snowflake.com"}
          aria-label="Companies, one per line or separated by commas"
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
          <button className="btn btn-primary" disabled={!preview?.items.length} onClick={() => start(text, "Pasted list", "paste")}>
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
        onView={onViewStakeholders}
        live={{
          eligible: eligible.length,
          needsReview,
          onGenerate: (only) => setConfirmTargets(only ?? eligible),
          onConfirmMany: (ids) => ids.forEach((id) => patch(id, { ambiguous: false, manual: true })),
          onRemoveMany: removeRows,
          maxSeeds,
          onStopQueue: () => rows.filter((r) => r.stage === "gen_queued").forEach((r) => patch(r.id, { stage: "not_started" })),
          keepAwake,
          onKeepAwake: setKeepAwake,
          onCheckAgain: () =>
            rows.filter((r) => r.stage === "timeout").forEach((r) => patch(r.id, { stage: "polling", watchStart: Date.now(), checkedAt: 0 })),
          onRetry: (r) => (r.company ? checkRow(r) : resolveRow(r)),
          onGenerateRow: (r) => generate([r]),
          onConfirmMatch: (r) => patch(r.id, { ambiguous: false, manual: true }),
          loadDetails: candidateDetails,
          search: searchCompanies,
          onUse: (r, c, via) => {
            const next: BatchRow = {
              ...r,
              company: c,
              candidates: [c, ...r.candidates.filter((x) => x.companyId !== c.companyId)],
              profile: detailCache.current.get(c.companyId)?.profile ?? undefined,
              ambiguous: false,
              manual: true,
              inputs: via ? { ...r.inputs, [via.param]: via.value } : r.inputs,
              accountId: c.accountId,
              created: false,
              noAccount: false,
              stakeholders: [],
              stage: "checking",
              error: undefined,
              genStart: null,
              genEnd: null,
              watchStart: null,
              joined: false,
            };
            patch(r.id, next);
            checkRow(next);
          },
          onRemove: (r) => removeRows([r.id]),
          onReset: reset,
        }}
      />
      <ConfirmDialog
        open={!!confirmTargets}
        title={`Generate stakeholders for ${targets.length} ${targets.length === 1 ? "company" : "companies"}?`}
        confirmLabel="Generate"
        onConfirm={() => {
          primeAudio();
          generate(targets);
        }}
        onCancel={() => setConfirmTargets(null)}
      >
        <p>This writes to the tenant your key belongs to. It starts power pod seeding for each of them.</p>
        {willCreate > 0 && (
          <p>
            {willCreate === 1 ? "1 of them has no account yet, so one will be created." : `${willCreate} of them have no account yet, so an account will be created for each.`}
          </p>
        )}
        {needsReview > 0 && targets === eligible && (
          <p className="warn-text">{needsReview} rows with an uncertain match are skipped until you confirm them.</p>
        )}
        {targets.length > 1 ? (
          <label className="seeds-input">
            Run
            <input
              type="number"
              min={1}
              max={50}
              value={maxSeeds}
              onChange={(e) => setMaxSeeds(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
              aria-label="Seeds at a time"
            />
            at a time. The rest wait in a queue and start as each one finishes.
          </label>
        ) : null}
        <p className="muted small">
          Each usually takes under 10 minutes
          {targets.length > maxSeeds && <>, so this is roughly {formatDuration(Math.ceil(targets.length / maxSeeds) * 8 * 60_000)} in total</>}. Keep this tab
          open and the laptop awake. If it sleeps, the queue pauses and picks up on wake, and History always keeps the results.
        </p>
        <NotifyOptions />
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
  gen_queued: { label: "Queued to generate", tone: "neutral" },
};

type FilterKey = "all" | "review" | "not_generated" | "generating" | "has_people" | "failed" | "no_match";

const FILTERS: Record<FilterKey, { label: string; test: (r: BatchRow) => boolean }> = {
  all: { label: "All", test: () => true },
  review: { label: "Needs review", test: (r) => r.ambiguous },
  not_generated: { label: "Not generated", test: (r) => r.stage === "not_started" },
  generating: { label: "Generating", test: (r) => ["gen_queued", "generating", "polling", "timeout"].includes(r.stage) },
  has_people: { label: "Has stakeholders", test: (r) => r.stakeholders.length > 0 },
  failed: { label: "Failed", test: (r) => r.stage === "failed" || r.stage === "error" },
  no_match: { label: "No match", test: (r) => r.stage === "no_match" },
};

type SortKey = "input" | "company" | "account" | "status" | "people";

const STATUS_ORDER: Record<BatchRow["stage"], number> = {
  no_match: 0, error: 1, failed: 2, not_started: 3, queued: 4, resolving: 4, checking: 4, gen_queued: 5,
  generating: 5, polling: 5, timeout: 6, completed: 7, seeded: 8,
};

function sortRows(rows: BatchRow[], sort: { key: SortKey; dir: 1 | -1 } | null) {
  if (!sort) return rows;
  const val = (r: BatchRow): string | number => {
    switch (sort.key) {
      case "input":
        return r.label.toLowerCase();
      case "company":
        return (r.company?.name ?? "\uffff").toLowerCase();
      case "account":
        return r.created ? 0 : r.accountId ? 1 : r.company ? 2 : 3;
      case "status":
        return STATUS_ORDER[r.stage];
      case "people":
        return r.stakeholders.length;
    }
  };
  return [...rows].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
  });
}

function SortTh({
  label,
  k,
  sort,
  onSort,
  className,
}: {
  label: string;
  k: SortKey;
  sort: { key: SortKey; dir: 1 | -1 } | null;
  onSort: (k: SortKey) => void;
  className?: string;
}) {
  const active = sort?.key === k;
  return (
    <th className={className} aria-sort={active ? (sort!.dir === 1 ? "ascending" : "descending") : "none"}>
      <button className={`th-sort ${active ? "th-sort-active" : ""}`} onClick={() => onSort(k)}>
        {label}
        <span className="th-arrow" aria-hidden="true">
          {active ? sort!.dir === 1 ? <ArrowUp size={13} /> : <ArrowDown size={13} /> : <ChevronsUpDown size={13} />}
        </span>
      </button>
    </th>
  );
}

type LiveActions = {
  eligible: number;
  maxSeeds: number;
  onStopQueue: () => void;
  keepAwake: boolean;
  onKeepAwake: (on: boolean) => void;
  needsReview: number;
  /** Open the generate confirmation for these rows (default: every eligible row). */
  onGenerate: (only?: BatchRow[]) => void;
  onConfirmMany: (ids: string[]) => void;
  onRemoveMany: (ids: string[]) => void;
  onCheckAgain: () => void;
  onRetry: (r: BatchRow) => void;
  onGenerateRow: (r: BatchRow) => void;
  onConfirmMatch: (r: BatchRow) => void;
  loadDetails: (c: Company) => Promise<CandidateDetails>;
  search: (d: Detected) => Promise<Company[]>;
  onUse: (r: BatchRow, c: Company, via?: Detected) => void;
  onRemove: (r: BatchRow) => void;
  onReset: () => void;
};

/** Batch summary, table, exports and row detail. Without `live` it is a read-only view (History). */
export function BatchView({
  name,
  rows,
  notice,
  live,
  extraActions,
  onView,
}: {
  name: string;
  rows: BatchRow[];
  notice?: string | null;
  live?: LiveActions;
  extraActions?: React.ReactNode;
  /** Open this row's stakeholders in the Stakeholders tab (falls back to an inline detail view). */
  onView?: (companyId: string) => void;
}) {
  const [detailId, setDetailId] = useState<string | null>(null);
  const [pickerId, setPickerId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastClicked, setLastClicked] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  // Review mode: total fixed when it starts, so the counter reads "2 of 3" as rows get confirmed.
  const [review, setReview] = useState<{ total: number; done: number } | null>(null);
  const canEditRow = (r: BatchRow) => !!live && !WATCHING.has(r.stage) && !BUSY.has(r.stage);
  const reviewable = rows.filter((r) => r.ambiguous && canEditRow(r));

  function openPicker(id: string | null) {
    setPickerId(id);
    // Jump to the page holding the row.
    const idx = id ? visible.findIndex((r) => r.id === id) : -1;
    if (idx >= 0) setPage(Math.floor(idx / PAGE_ROWS));
    if (id) requestAnimationFrame(() => document.getElementById(`row-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
  }
  /** After a pick: in review mode move to the next uncertain row, else close. */
  function afterPick(doneId: string) {
    if (!review) return openPicker(null);
    const next = reviewable.find((r) => r.id !== doneId);
    if (next) {
      setReview({ ...review, done: review.done + 1 });
      openPicker(next.id);
    } else {
      setReview(null);
      openPicker(null);
    }
  }
  const [now, setNow] = useState(() => Date.now());
  const polling = rows.filter((r) => r.stage === "polling" || r.stage === "generating");
  const queuedCount = rows.filter((r) => r.stage === "gen_queued").length;
  const doneGen = rows.filter((r) => r.stage === "completed");
  const avgGenMs = doneGen.length ? doneGen.reduce((n, r) => n + ((r.genEnd ?? 0) - (r.genStart ?? 0)), 0) / doneGen.length : 8 * 60_000;
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

  // A filter that has emptied out (e.g. all "Needs review" rows confirmed) falls back to All.
  const activeFilter: FilterKey = filter !== "all" && !rows.some(FILTERS[filter].test) ? "all" : filter;
  const visible = sortRows(rows.filter(FILTERS[activeFilter].test), sort);
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_ROWS));
  const curPage = Math.min(page, pageCount - 1);
  const pageRows = visible.slice(curPage * PAGE_ROWS, (curPage + 1) * PAGE_ROWS);

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

  const selectedRows = rows.filter((r) => selected.has(r.id));
  const selConfirmable = selectedRows.filter((r) => r.ambiguous && canEditRow(r));
  const selGeneratable = selectedRows.filter((r) => r.company && !r.ambiguous && (r.stage === "not_started" || r.stage === "failed"));
  const selRemovable = selectedRows.filter(canEditRow);
  const allVisibleSelected = pageRows.length > 0 && pageRows.every((r) => selected.has(r.id));
  const someVisibleSelected = pageRows.some((r) => selected.has(r.id));

  /** Checkbox click; shift-click selects the range from the last clicked row, like a spreadsheet. */
  function toggleRow(id: string, shift: boolean) {
    const next = new Set(selected);
    const on = !next.has(id);
    if (shift && lastClicked) {
      const a = pageRows.findIndex((r) => r.id === lastClicked);
      const b = pageRows.findIndex((r) => r.id === id);
      if (a >= 0 && b >= 0) for (const r of pageRows.slice(Math.min(a, b), Math.max(a, b) + 1)) on ? next.add(r.id) : next.delete(r.id);
    } else on ? next.add(id) : next.delete(id);
    setSelected(next);
    setLastClicked(id);
  }

  function toggleAllVisible() {
    const next = new Set(selected);
    if (allVisibleSelected) pageRows.forEach((r) => next.delete(r.id));
    else pageRows.forEach((r) => next.add(r.id));
    setSelected(next);
  }

  const clearSelection = () => setSelected(new Set());

  function sortBy(key: SortKey) {
    setSort((cur) => (cur?.key === key ? (cur.dir === 1 ? { key, dir: -1 } : null) : { key, dir: 1 }));
    setPage(0);
  }

  function exportAll(subset: BatchRow[] = rows) {
    const parts = subset.flatMap((r) => {
      const rec = rowToRecord(r);
      if (!rec || !rec.stakeholders.length) return [];
      const { pods } = analyze(rec.stakeholders, { name: rec.company.name, domain: rec.domain });
      return [{ pods, meta: { company: rec.company.name, companyId: rec.company.companyId, accountId: rec.accountId ?? "", outcome: rec.outcome } }];
    });
    const extras = extraFields(parts.flatMap((x) => x.pods.flatMap((p) => p.people)));
    const lines: unknown[][] = [csvHeader(extras)];
    for (const x of parts) lines.push(...stakeholderCsvRows(x.pods, x.meta, extras));
    const tag = subset === rows ? "" : `_${subset.length}_selected`;
    downloadFile(`batch_${slugify(name)}${tag}_stakeholders_${today()}.csv`, toCsv(lines));
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

        {(polling.length > 0 || queuedCount > 0) && (
          <p className="note progress-note">
            <strong>
              {polling.length} generating{queuedCount > 0 && <> · {queuedCount.toLocaleString()} queued</>}
              {doneGen.length > 0 && <> · {doneGen.length.toLocaleString()} done</>}
            </strong>
            {live && <> · {live.maxSeeds} at a time</>}
            {queuedCount > 0 && live && <> · about {formatDuration(Math.ceil((queuedCount + polling.length) / live.maxSeeds) * avgGenMs)} left</>}
            . Each is checked every 15s. Keep this tab open and the laptop awake: if it sleeps, the queue pauses and resumes on wake. Everything is saved to History as it finishes.
          </p>
        )}
        {(polling.length > 0 || queuedCount > 0) && (
          <div className="row gap wrap">
            <NotifyOptions compact />
            {live && wakeLockSupported() && (
              <label className="toggle">
                <input type="checkbox" checked={live.keepAwake} onChange={(e) => live.onKeepAwake(e.target.checked)} /> Keep screen awake
              </label>
            )}
            {live && queuedCount > 0 && (
              <button className="link-btn small danger" onClick={live.onStopQueue}>
                Stop queue ({queuedCount.toLocaleString()} not started)
              </button>
            )}
          </div>
        )}
        {notice && <p className="warn-text">{notice}</p>}

        <div className="row gap wrap">
          {live && live.eligible > 0 && (
            <button className="btn btn-primary" onClick={() => live.onGenerate()}>
              Generate for {live.eligible}
            </button>
          )}
          {live && timeouts > 0 && (
            <button className="btn btn-ghost" onClick={live.onCheckAgain}>
              <RefreshCw size={16} /> Check again ({timeouts})
            </button>
          )}
          <button className="btn btn-ghost" onClick={() => exportAll()} disabled={!totalPeople}>
            <Download size={16} /> Export all stakeholders
          </button>
          <button className="btn btn-ghost" onClick={exportSummary}>
            <Download size={16} /> Export summary
          </button>
        </div>
        {live && reviewable.length > 0 && (
          <div className="review-banner">
            <TriangleAlert size={16} aria-hidden="true" />
            <span className="grow">
              {reviewable.length} {reviewable.length === 1 ? "row was" : "rows were"} matched by name only and could be the wrong company. They&apos;re skipped when generating until you confirm them.
            </span>
            <button
              className="btn btn-ghost small"
              onClick={() => {
                setFilter("review");
                setPage(0);
                setSelected(new Set(reviewable.map((r) => r.id)));
              }}
            >
              Select all {reviewable.length}
            </button>
            <button
              className="btn btn-ghost small"
              onClick={() => {
                setReview({ total: reviewable.length, done: 0 });
                openPicker(reviewable[0].id);
              }}
            >
              <ListChecks size={14} /> Review {reviewable.length} {reviewable.length === 1 ? "match" : "matches"}
            </button>
          </div>
        )}
      </section>

      <section className="card table-card">
        <div className="table-toolbar">
          <div className="chips" role="group" aria-label="Filter rows">
            {(Object.keys(FILTERS) as FilterKey[]).map((k) => {
              const n = k === "all" ? rows.length : rows.filter(FILTERS[k].test).length;
              if (k !== "all" && !n) return null;
              return (
                <button key={k} className={`chip ${activeFilter === k ? "chip-active" : ""}`} aria-pressed={activeFilter === k} onClick={() => (setFilter(k), setPage(0))}>
                  {FILTERS[k].label} <strong>{n}</strong>
                </button>
              );
            })}
          </div>
        </div>

        {selected.size > 0 && (
          <div className="bulk-bar" role="toolbar" aria-label="Bulk actions">
            <span className="strong">{selected.size} selected</span>
            {live && selConfirmable.length > 0 && (
              <button className="btn btn-ghost small" onClick={() => live.onConfirmMany(selConfirmable.map((r) => r.id))}>
                Confirm {selConfirmable.length} {selConfirmable.length === 1 ? "match" : "matches"}
              </button>
            )}
            {live && selGeneratable.length > 0 && (
              <button className="btn btn-primary small" onClick={() => live.onGenerate(selGeneratable)}>
                Generate {selGeneratable.length}
              </button>
            )}
            {selectedRows.some((r) => r.stakeholders.length) && (
              <button className="btn btn-ghost small" onClick={() => exportAll(selectedRows)}>
                <Download size={14} /> Export selected
              </button>
            )}
            {live && selRemovable.length > 0 && (
              <button
                className="link-btn small danger"
                onClick={() => {
                  live.onRemoveMany(selRemovable.map((r) => r.id));
                  clearSelection();
                }}
              >
                Remove {selRemovable.length}
              </button>
            )}
            {allVisibleSelected && visible.length > pageRows.length && selected.size < visible.length && (
              <button className="link-btn small" onClick={() => setSelected(new Set([...selected, ...visible.map((r) => r.id)]))}>
                Select all {visible.length.toLocaleString()} rows
              </button>
            )}
            <span className="grow" />
            <button className="link-btn small" onClick={clearSelection}>
              Clear selection
            </button>
          </div>
        )}

        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th className="col-check">
                  <input
                    type="checkbox"
                    aria-label="Select all visible rows"
                    checked={allVisibleSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = !allVisibleSelected && someVisibleSelected;
                    }}
                    onChange={toggleAllVisible}
                  />
                </th>
                <SortTh label="Input" k="input" sort={sort} onSort={sortBy} />
                <SortTh label="Matched company" k="company" sort={sort} onSort={sortBy} />
                <SortTh label="Account" k="account" sort={sort} onSort={sortBy} />
                <SortTh label="Stakeholders" k="status" sort={sort} onSort={sortBy} />
                <SortTh label="People" k="people" sort={sort} onSort={sortBy} className="num" />
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr>
                  <td colSpan={7} className="empty-cell">
                    No rows match this filter.
                  </td>
                </tr>
              )}
              {pageRows.map((r) => {
                const badge = STAGE_BADGE[r.stage];
                const canView = r.stakeholders.length > 0;
                const canEdit = canEditRow(r);
                const picking = canEdit && pickerId === r.id;
                const reviewStep = review && picking ? { index: review.done + 1, total: Math.max(review.total, review.done + 1) } : undefined;
                return (
                  <Fragment key={r.id}>
                    <tr
                      id={`row-${r.id}`}
                      className={`${r.ambiguous ? "row-review" : ""} ${picking ? "row-picking" : ""} ${selected.has(r.id) ? "row-selected" : ""}`}
                    >
                      <td className="col-check">
                        <input
                          type="checkbox"
                          aria-label={`Select ${r.label}`}
                          checked={selected.has(r.id)}
                          onChange={() => {}}
                          onClick={(e) => toggleRow(r.id, e.shiftKey)}
                        />
                      </td>
                      <td>
                        <div className="cell-input">
                          <span className="truncate" title={r.label}>{r.label}</span>
                          {r.manual ? (
                            <span className="muted small">chosen by you</span>
                          ) : (
                            r.matchedBy && <span className="muted small">by {PARAM_LABEL[r.matchedBy]}</span>
                          )}
                        </div>
                      </td>
                      <td>
                        {r.company ? (
                          <div className="cell-company">
                            <CompanyLogo src={r.company.imageUrl} name={r.company.name} size={28} />
                            <div className="cell-company-main">
                              <span className="row gap-xs wrap">
                                <span className="strong">{r.company.name}</span>
                                {r.company.verified && <BadgeCheck size={14} className="verified" aria-label="Verified" />}
                                {canEdit && !picking && (
                                  <button className="link-btn small" onClick={() => openPicker(r.id)}>
                                    {r.candidates.length > 1 ? `Change (${r.candidates.length} matches)` : "Change"}
                                  </button>
                                )}
                              </span>
                              <CompanyFacts profile={r.profile} linkedInUrl={r.company.linkedInUrl} loading={r.profile === undefined && BUSY.has(r.stage)} />
                              {r.ambiguous && !picking && (
                                <span className="review">
                                  Check match
                                  {live && (
                                    <>
                                      <button className="link-btn" onClick={() => live.onConfirmMatch(r)}>
                                        Looks right
                                      </button>
                                      <button className="link-btn" onClick={() => openPicker(r.id)}>
                                        Compare
                                      </button>
                                    </>
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
                        <span className="cell-status">
                          <Badge tone={badge.tone}>
                            {["resolving", "checking", "generating", "polling"].includes(r.stage) && <Spinner size={12} />}
                            {badge.label}
                          </Badge>
                          {r.stage === "polling" && r.genStart && <span className="muted small nowrap">{formatDuration(now - r.genStart)}</span>}
                          {r.stage === "completed" && r.genStart && r.genEnd && <span className="muted small nowrap">in {formatDuration(r.genEnd - r.genStart)}</span>}
                        </span>
                        {r.error && <div className="error-text small">{r.error}</div>}
                      </td>
                      <td className="num">{r.stakeholders.length || ""}</td>
                      <td className="cell-actions">
                        {canView && (
                          <button
                            className="btn btn-ghost small"
                            onClick={() => (onView && r.company ? onView(r.company.companyId) : setDetailId(r.id))}
                          >
                            View
                          </button>
                        )}
                        {live && r.company && !r.ambiguous && (r.stage === "not_started" || r.stage === "failed") && (
                          <button className="btn btn-ghost small" onClick={() => live.onGenerateRow(r)}>
                            Generate
                          </button>
                        )}
                        {live && r.stage === "error" && (
                          <button className="btn btn-ghost small" onClick={() => live.onRetry(r)}>
                            Retry
                          </button>
                        )}
                        {live && r.stage === "no_match" && !picking && (
                          <button className="btn btn-ghost small" onClick={() => openPicker(r.id)}>
                            Search differently
                          </button>
                        )}
                      </td>
                    </tr>
                    {picking && live && (
                      <tr className="row-edit">
                        <td colSpan={7}>
                          <MatchPicker
                            row={r}
                            review={reviewStep}
                            loadDetails={live.loadDetails}
                            search={live.search}
                            onUse={(c, via) => {
                              live.onUse(r, c, via);
                              afterPick(r.id);
                            }}
                            onConfirm={() => {
                              live.onConfirmMatch(r);
                              afterPick(r.id);
                            }}
                            onRemove={() => {
                              live.onRemove(r);
                              afterPick(r.id);
                            }}
                            onCancel={() => {
                              setReview(null);
                              openPicker(null);
                            }}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        {pageCount > 1 && (
          <div className="pager">
            <button className="btn btn-ghost small" disabled={curPage === 0} onClick={() => setPage(curPage - 1)}>
              Previous
            </button>
            <span className="muted small">
              {(curPage * PAGE_ROWS + 1).toLocaleString()}–{Math.min((curPage + 1) * PAGE_ROWS, visible.length).toLocaleString()} of{" "}
              {visible.length.toLocaleString()}
            </span>
            <button className="btn btn-ghost small" disabled={curPage >= pageCount - 1} onClick={() => setPage(curPage + 1)}>
              Next
            </button>
          </div>
        )}
      </section>
    </>
  );
}
