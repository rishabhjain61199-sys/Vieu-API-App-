"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Clock, RefreshCw, TriangleAlert } from "lucide-react";
import { ApiError, formatDuration, isAbort, sleep, vieu } from "@/lib/api";
import { analyze, downloadStakeholderCsv } from "@/lib/stakeholders";
import { newId, saveEntry } from "@/lib/history";
import { cleanDomain } from "@/lib/detect";
import { announce, primeAudio, setGenerating } from "@/lib/notify";
import {
  idParam,
  type Company,
  type CompanyProfile,
  type GenerateResponse,
  type Ids,
  type LookupResume,
  type Outcome,
  type StakeholdersResponse,
} from "@/lib/types";
import { ConfirmDialog, Spinner } from "./ui";
import { Pods } from "./Pods";
import { Summary, usePodNav } from "./Summary";
import { NotifyOptions } from "./NotifyOptions";

const POLL_MS = 15_000; // API asks for no more than one poll per 15s
const MAX_WAIT_MS = 12 * 60_000;

type Phase = "loading" | "results" | "not_started" | "polling" | "timeout" | "failed" | "error";

export function Run({
  apiKey,
  company,
  domainHint,
  tenant,
  resume,
  onKeyInvalid,
}: {
  apiKey: string;
  company: Company;
  domainHint?: string;
  tenant?: string;
  resume?: LookupResume;
  onKeyInvalid: (msg: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [resp, setResp] = useState<StakeholdersResponse | null>(null);
  const [outcome, setOutcome] = useState<Outcome>("not_generated");
  const [created, setCreated] = useState(resume?.created ?? false);
  const [noAccount, setNoAccount] = useState(false);
  const [error, setError] = useState<{ msg: string; status: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [profile, setProfile] = useState<CompanyProfile | null>(null);
  const [genStart, setGenStart] = useState<number | null>(resume?.genStart ?? null);
  const [genEnd, setGenEnd] = useState<number | null>(null);
  const [joined, setJoined] = useState(resume?.joined ?? false);
  // Re-opened from History while it was still generating: time is an upper bound.
  const [genApprox, setGenApprox] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [lastChecked, setLastChecked] = useState<number | null>(null);
  const entryId = useRef(resume?.entryId ?? newId());
  const createdAt = useRef(resume?.createdAt ?? Date.now());

  const ids = useRef<Ids>({ accountId: company.accountId, companyId: company.companyId });
  const ac = useRef<AbortController>(new AbortController());

  const opts = () => ({
    signal: ac.current.signal,
    onRateLimit: (ms: number) => setNotice(`Rate limited, retrying in ${Math.ceil(ms / 1000)}s`),
  });

  async function fetchStakeholders() {
    const r = await vieu<StakeholdersResponse>(apiKey, "GET", "/accounts/stakeholders", idParam(ids.current), opts());
    if (r.accountId) ids.current.accountId = r.accountId;
    setResp(r);
    setLastChecked(Date.now());
    setNotice(null);
    return r;
  }

  function fatal(e: unknown) {
    if (isAbort(e)) return;
    const ae = e as ApiError;
    if (ae.status === 401) return onKeyInvalid(ae.message);
    setError({ msg: ae.message || "Something went wrong", status: ae.status ?? 0 });
    setPhase("error");
  }

  /** Applies a stakeholders response. Returns true when the run has reached a final state. */
  function settle(r: StakeholdersResponse, watching: boolean): boolean {
    if (r.seedingStatus === "failed" && !(r.generated && !watching)) {
      setOutcome("failed");
      setPhase("failed");
      return true;
    }
    if (watching) {
      if (r.seedingStatus === "completed" || (r.generated && r.seedingStatus !== "pending")) {
        setGenEnd(Date.now());
        setOutcome("newly_generated");
        setPhase("results");
        return true;
      }
      return false;
    }
    if (r.generated) {
      setOutcome("already_seeded");
      setPhase("results");
      return true;
    }
    if (r.seedingStatus === "pending") return false;
    setOutcome("not_generated");
    setPhase("not_started");
    return true;
  }

  async function watch() {
    const signal = ac.current.signal;
    const windowStart = Date.now();
    setPhase("polling");
    setOutcome("seed_in_progress");
    try {
      while (true) {
        await sleep(POLL_MS, signal);
        try {
          if (settle(await fetchStakeholders(), true)) return;
        } catch (e) {
          if (isAbort(e)) throw e;
          const ae = e as ApiError;
          if (ae.status === 401 || ae.status === 403) return fatal(ae);
          setNotice(`${ae.message}. Still watching`);
        }
        if (Date.now() - windowStart >= MAX_WAIT_MS) {
          setOutcome("still_generating");
          setPhase("timeout");
          return;
        }
      }
    } catch (e) {
      fatal(e);
    }
  }

  async function load() {
    setPhase("loading");
    setError(null);
    // Profile (for domain/industry) and stakeholders are fetched in parallel.
    vieu<{ profile?: CompanyProfile }>(apiKey, "GET", "/accounts/profile", { companyId: company.companyId }, { signal: ac.current.signal })
      .then((r) => r.profile && setProfile(r.profile))
      .catch(() => {});
    try {
      const r = await fetchStakeholders();
      // Re-opened from History mid-generation: a finished seed counts as newly generated.
      const resuming = !!resume?.watching && (r.generated || r.seedingStatus === "pending" || r.seedingStatus === "completed");
      if (resuming) {
        if (settle(r, true)) {
          setGenApprox(true);
          return;
        }
        watch();
        return;
      }
      if (!settle(r, false)) {
        // Someone already triggered a seed: skip the POST and watch it.
        setJoined(true);
        setGenStart(Date.now());
        watch();
      }
    } catch (e) {
      if (isAbort(e)) return;
      if ((e as ApiError).status === 404 && !ids.current.accountId) {
        setNoAccount(true);
        setOutcome("not_generated");
        setPhase("not_started");
        return;
      }
      fatal(e);
    }
  }

  async function generate() {
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      const g = await vieu<GenerateResponse>(apiKey, "POST", "/accounts/stakeholders/generate", idParam(ids.current), opts());
      if (g.created) setCreated(true);
      if (g.accountId) ids.current.accountId = g.accountId;
      setNoAccount(false);
      setJoined(false);
      setGenStart(Date.now());
      setGenEnd(null);
      setGenApprox(false);
      setNotice(null);
      watch();
    } catch (e) {
      fatal(e);
    } finally {
      setBusy(false);
    }
  }

  async function checkAgain() {
    setBusy(true);
    try {
      if (!settle(await fetchStakeholders(), true)) watch();
    } catch (e) {
      fatal(e);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    ac.current = new AbortController();
    load();
    return () => ac.current.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (phase !== "polling") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => {
      clearInterval(t);
      window.removeEventListener("beforeunload", warn);
    };
  }, [phase]);

  // Prefer the domain the user typed; the profile field can be a short link.
  const domain = domainHint || cleanDomain(profile?.domain);
  const analysis = useMemo(
    () => (resp?.stakeholders?.length ? analyze(resp.stakeholders, { name: company.name, domain }) : null),
    [resp, company.name, domain],
  );
  const pods = analysis?.pods ?? [];
  const nav = usePodNav(pods);
  const showResults = !!analysis && (phase === "results" || phase === "timeout" || phase === "failed");
  const accountId = ids.current.accountId;
  const genMs = outcome === "newly_generated" && genStart && genEnd ? genEnd - genStart : null;

  // Tab title while this seed is watched, and an alert when a watched seed ends.
  const prevPhase = useRef<Phase>(phase);
  useEffect(() => {
    const source = `run-${entryId.current}`;
    setGenerating(source, phase === "polling" ? 1 : 0);
    const was = prevPhase.current;
    prevPhase.current = phase;
    if (was === "polling" && phase === "results") {
      const n = analysis?.people.length ?? 0;
      announce({
        tag: source,
        title: `Stakeholders ready: ${company.name}`,
        body: `${n} stakeholders in ${pods.length} power pods${genMs ? ` · generated in ${formatDuration(genMs)}` : ""}`,
      });
    } else if (was === "polling" && phase === "failed") {
      announce({ tag: source, title: `Generation failed: ${company.name}`, body: "Open the app to retry." });
    } else if (was === "polling" && phase === "timeout") {
      announce({ tag: source, title: `Still generating: ${company.name}`, body: "Not finished after 12 minutes. Open the app to check again." });
    }
    return () => setGenerating(source, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // Save to history as soon as generation starts (so a closed tab can resume it) and on every final state.
  useEffect(() => {
    if (!["polling", "results", "timeout", "failed"].includes(phase)) return;
    saveEntry({
      id: entryId.current,
      kind: "lookup",
      title: company.name,
      tenant,
      createdAt: createdAt.current,
      updatedAt: Date.now(),
      data: {
        company,
        domain,
        industry: profile?.industry,
        headquarters: profile?.headquarters,
        accountId: ids.current.accountId,
        created,
        outcome,
        genMs,
        joined,
        genStart,
        genApprox,
        stakeholders: resp?.stakeholders ?? [],
        message: resp?.message,
        checkedAt: lastChecked ?? Date.now(),
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, outcome, resp, profile, tenant]);

  return (
    <>
      <Summary
        company={company}
        domain={domain}
        industry={profile?.industry}
        headquarters={profile?.headquarters}
        account={created ? "created" : noAccount ? "none" : phase === "loading" ? "loading" : "existing"}
        outcome={phase === "loading" ? null : outcome}
        elapsed={phase === "polling" && genStart ? formatDuration(now - genStart) : undefined}
        genMs={genMs}
        joined={joined}
        genApprox={genApprox}
        analysis={analysis}
        onJumpPod={nav.jump}
        notice={notice}
        onExport={() =>
          downloadStakeholderCsv(pods, { company: company.name, companyId: company.companyId, accountId: accountId ?? "", outcome })
        }
      />

      {phase === "not_started" && (
        <section className="card stage">
          <h3>No stakeholders yet</h3>
          <p className="muted">
            Stakeholders haven&apos;t been generated for {company.name} in this tenant.
            {(noAccount || !accountId) && " There's no account for this company yet, so generating will also create one."}
          </p>
          <button className="btn btn-primary" onClick={() => setConfirming(true)} disabled={busy}>
            {busy && <Spinner />} Generate stakeholders
          </button>
        </section>
      )}

      {phase === "polling" && genStart && (
        <section className="card stage">
          <div className="row gap">
            <Spinner size={20} />
            <h3>{joined ? "A seed was already running. Watching it now" : "Generating stakeholders"}</h3>
          </div>
          <div className="progress" aria-hidden="true">
            <span style={{ width: `${Math.max(0, Math.min(100, ((now - genStart) / MAX_WAIT_MS) * 100))}%` }} />
          </div>
          <p className="row gap wrap small">
            <span className="kpi-inline">
              <Clock size={14} /> {formatDuration(now - genStart)} elapsed
            </span>
            <span className="muted">Usually under 10 minutes. Checks every 15s, stops after 12 min.</span>
            {lastChecked && <span className="muted">Last checked {formatDuration(now - lastChecked)} ago.</span>}
          </p>
          <NotifyOptions compact />
          <p className="note">You can leave this tab open and come back. Refreshing or closing it clears your key and stops the watch, but generation keeps running in Vieu.</p>
        </section>
      )}

      {phase === "timeout" && (
        <section className="card stage">
          <h3>Still generating</h3>
          <p className="muted">It hasn&apos;t finished after 12 minutes. It is probably still running in Vieu.</p>
          <button className="btn btn-primary" onClick={checkAgain} disabled={busy}>
            {busy ? <Spinner /> : <RefreshCw size={16} />} Check again
          </button>
        </section>
      )}

      {phase === "failed" && (
        <section className="card stage stage-bad">
          <h3>
            <TriangleAlert size={18} /> Stakeholder generation failed
          </h3>
          <p className="muted">{resp?.message || "Vieu reported that seeding failed for this account."}</p>
          <button className="btn btn-primary" onClick={() => setConfirming(true)} disabled={busy}>
            {busy && <Spinner />} Retry generation
          </button>
        </section>
      )}

      {phase === "error" && error && (
        <section className="card stage stage-bad">
          <h3>
            <TriangleAlert size={18} /> {error.msg}
          </h3>
          {error.status === 403 && <p className="muted">Ask a tenant admin for a key with the account:read-write scope.</p>}
          <button className="btn btn-ghost" onClick={load}>
            <RefreshCw size={16} /> Try again
          </button>
        </section>
      )}

      {phase === "results" && !analysis && (
        <section className="card stage">
          <h3>No stakeholders returned</h3>
          <p className="muted">Power pods exist for this account, but the list is empty.</p>
        </section>
      )}

      {showResults && analysis && (
        <Pods pods={pods} open={nav.open} onOpenChange={nav.setOpen} />
      )}

      <ConfirmDialog
        open={confirming}
        title={`Generate stakeholders for ${company.name}?`}
        confirmLabel="Generate"
        onConfirm={() => {
          primeAudio();
          generate();
        }}
        onCancel={() => setConfirming(false)}
      >
        <p>This writes to the tenant your key belongs to. It starts power pod seeding for this company{!accountId && " and creates an account for it"}.</p>
        <p className="muted small">It usually takes under 10 minutes. You can watch progress here.</p>
        <NotifyOptions />
      </ConfirmDialog>
    </>
  );
}
