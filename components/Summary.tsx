"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Copy, Download } from "lucide-react";
import { formatDuration } from "@/lib/api";
import { analyze, downloadStakeholderCsv, type Pod } from "@/lib/stakeholders";
import { OUTCOME_LABEL, type Company, type Outcome, type RunRecord } from "@/lib/types";
import { Badge, CompanyLogo, Spinner } from "./ui";
import { Pods } from "./Pods";

export const OUTCOME_TONE: Record<Outcome, string> = {
  already_seeded: "good",
  newly_generated: "accent",
  seed_in_progress: "accent",
  still_generating: "warn",
  failed: "bad",
  not_generated: "neutral",
};

export type Analysis = ReturnType<typeof analyze>;

/** Open/closed state for pod sections, plus jumping to one from a chip. */
export function usePodNav(pods: Pod[]) {
  const [open, setOpen] = useState<Set<string> | null>(null);
  const openSet = open ?? new Set(pods[0] ? [pods[0].name] : []);
  function jump(name: string) {
    setOpen(new Set([...openSet, name]));
    requestAnimationFrame(() =>
      document.getElementById(`pod-${encodeURIComponent(name)}`)?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  }
  return { open: openSet, setOpen, jump };
}

export function Summary({
  company,
  domain,
  industry,
  headquarters,
  account,
  outcome,
  elapsed,
  genMs,
  joined,
  genApprox,
  analysis,
  onExport,
  onJumpPod,
  notice,
  checkedAt,
  actions,
}: {
  company: Company;
  domain?: string;
  industry?: string;
  headquarters?: string;
  account: "existing" | "created" | "none" | "loading";
  outcome: Outcome | null;
  elapsed?: string;
  genMs?: number | null;
  joined?: boolean;
  genApprox?: boolean;
  analysis: Analysis | null;
  onExport?: () => void;
  onJumpPod?: (name: string) => void;
  notice?: string | null;
  checkedAt?: number;
  actions?: ReactNode;
}) {
  const pods = analysis?.pods ?? [];
  return (
    <section className="card summary" aria-live="polite">
      <div className="summary-head">
        <CompanyLogo src={company.imageUrl} name={company.name} size={48} />
        <div className="grow">
          <p className="eyebrow">Run summary</p>
          <h2 className="summary-title">{company.name}</h2>
          <p className="muted small summary-sub">
            {domain && <span>{domain}</span>}
            {industry && <span>{industry}</span>}
            {headquarters && <span>{headquarters}</span>}
            <CopyId value={company.companyId} />
          </p>
        </div>
        <div className="row gap wrap">
          {actions}
          {analysis && onExport && (
            <button className="btn btn-primary" onClick={onExport}>
              <Download size={16} /> Export CSV
            </button>
          )}
        </div>
      </div>

      <dl className="fields">
        <div>
          <dt>Account</dt>
          <dd>
            {account === "created" ? (
              <Badge tone="accent">Account created now</Badge>
            ) : account === "none" ? (
              <Badge>No account yet</Badge>
            ) : account === "loading" ? (
              <Spinner />
            ) : (
              <Badge tone="good">Existing account</Badge>
            )}
          </dd>
        </div>
        <div>
          <dt>Stakeholders</dt>
          <dd>
            {outcome ? <Badge tone={OUTCOME_TONE[outcome]}>{OUTCOME_LABEL[outcome]}</Badge> : <Spinner />}
            {elapsed && <span className="muted small"> {elapsed}</span>}
          </dd>
        </div>
        {outcome === "newly_generated" && genMs != null && (
          <div>
            <dt>Generation time</dt>
            <dd
              title={
                genApprox
                  ? "At most this long. The tab was closed while it ran, so the exact finish time isn't known"
                  : joined
                    ? "Measured from when this app found the seed already running"
                    : undefined
              }
            >
              {genApprox && "≤ "}
              {formatDuration(genMs)}
              {joined && !genApprox && <span className="muted small"> (watched)</span>}
            </dd>
          </div>
        )}
        <div>
          <dt>Total stakeholders</dt>
          <dd className="kpi">{analysis ? analysis.people.length : outcome ? 0 : "…"}</dd>
        </div>
        <div>
          <dt>Power pods</dt>
          <dd className="kpi">{pods.length}</dd>
        </div>
        {analysis && analysis.flaggedCount > 0 && (
          <div>
            <dt>Flagged for review</dt>
            <dd className="kpi kpi-warn">{analysis.flaggedCount}</dd>
          </div>
        )}
      </dl>

      {pods.length > 0 && (
        <div className="chips">
          {pods.map((p) => (
            <button key={p.name} className="chip" onClick={() => onJumpPod?.(p.name)}>
              {p.name} <strong>{p.people.length}</strong>
            </button>
          ))}
        </div>
      )}
      {checkedAt && <p className="muted small">Last checked {new Date(checkedAt).toLocaleString()}</p>}
      {notice && <p className="warn-text">{notice}</p>}
    </section>
  );
}

/** A saved or batch result: summary card plus pods, no live API calls. */
export function RecordView({ record, actions }: { record: RunRecord; actions?: ReactNode }) {
  const analysis = useMemo(
    () =>
      record.stakeholders.length ? analyze(record.stakeholders, { name: record.company.name, domain: record.domain }) : null,
    [record],
  );
  const pods = analysis?.pods ?? [];
  const nav = usePodNav(pods);
  return (
    <>
      <Summary
        company={record.company}
        domain={record.domain}
        industry={record.industry}
        headquarters={record.headquarters}
        account={record.created ? "created" : record.accountId ? "existing" : "none"}
        outcome={record.outcome}
        genMs={record.genMs}
        joined={record.joined}
        genApprox={record.genApprox}
        analysis={analysis}
        checkedAt={record.checkedAt}
        onJumpPod={nav.jump}
        actions={actions}
        onExport={() =>
          downloadStakeholderCsv(pods, {
            company: record.company.name,
            companyId: record.company.companyId,
            accountId: record.accountId ?? "",
            outcome: record.outcome,
          })
        }
      />
      {analysis && <Pods pods={pods} open={nav.open} onOpenChange={nav.setOpen} />}
    </>
  );
}

function CopyId({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="copy-id mono"
      title="Copy company id"
      onClick={() => {
        navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {value} <Copy size={12} /> {copied && <span className="copied">Copied</span>}
    </button>
  );
}
