"use client";

import { useEffect, useMemo, useState } from "react";
import { BadgeCheck, Search as SearchIcon } from "lucide-react";
import { detectInput, type Detected } from "@/lib/detect";
import type { BatchRow, Company, CompanyProfile } from "@/lib/types";
import { Badge, CompanyFacts, CompanyLogo, Spinner } from "./ui";

export type CandidateStatus =
  | { kind: "seeded"; count: number }
  | { kind: "pending" }
  | { kind: "failed" }
  | { kind: "not_started" }
  | { kind: "no_account" }
  | { kind: "unknown" };

export type CandidateDetails = { profile: CompanyProfile | null; status: CandidateStatus };

function StatusBadge({ s }: { s?: CandidateStatus }) {
  if (!s) return <Badge><Spinner size={11} /> Checking</Badge>;
  switch (s.kind) {
    case "seeded":
      return <Badge tone="good">{s.count} stakeholders</Badge>;
    case "pending":
      return <Badge tone="accent">Seeding now</Badge>;
    case "failed":
      return <Badge tone="bad">Last seed failed</Badge>;
    case "not_started":
      return <Badge>Not generated</Badge>;
    case "no_account":
      return <Badge>No account yet</Badge>;
    default:
      return null;
  }
}

/**
 * Compare a row's candidates side by side (domain, LinkedIn, size, HQ, whether
 * stakeholders already exist), search for a different company, or drop the row.
 */
export function MatchPicker({
  row,
  review,
  loadDetails,
  search,
  onUse,
  onConfirm,
  onRemove,
  onCancel,
}: {
  row: BatchRow;
  /** "2 of 5" when stepping through uncertain matches. */
  review?: { index: number; total: number };
  loadDetails: (c: Company) => Promise<CandidateDetails>;
  search: (d: Detected) => Promise<Company[]>;
  onUse: (c: Company, via?: Detected) => void;
  onConfirm: () => void;
  onRemove: () => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(row.company?.companyId ?? null);
  const [found, setFound] = useState<{ via: Detected; companies: Company[] } | null>(null);
  const [q, setQ] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, CandidateDetails>>({});
  const detected = detectInput(q);

  const original = useMemo(
    () => (row.candidates.length ? row.candidates : row.company ? [row.company] : []),
    [row.candidates, row.company],
  );
  const extra = useMemo(
    () => (found?.companies ?? []).filter((c) => !original.some((o) => o.companyId === c.companyId)),
    [found, original],
  );
  const all = useMemo(() => [...extra, ...original], [extra, original]);

  // Details for every visible candidate, fetched in parallel (cached by the parent).
  useEffect(() => {
    let live = true;
    for (const c of all) {
      if (details[c.companyId]) continue;
      loadDetails(c).then((d) => live && setDetails((prev) => ({ ...prev, [c.companyId]: d })));
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all]);

  async function runSearch() {
    if (!detected) return;
    setSearching(true);
    setSearchError(null);
    try {
      const companies = await search(detected);
      setFound({ via: detected, companies });
      if (companies[0]) setSelected(companies[0].companyId);
      if (!companies.length) setSearchError(`No company found for that ${detected.label}.`);
    } catch (e) {
      setSearchError((e as Error).message || "Search failed");
    } finally {
      setSearching(false);
    }
  }

  function use() {
    const c = all.find((x) => x.companyId === selected);
    if (!c) return;
    if (c.companyId === row.company?.companyId) return onConfirm();
    const fromSearch = found?.companies.some((x) => x.companyId === c.companyId) ? found.via : undefined;
    onUse(c, fromSearch);
  }

  const card = (c: Company) => {
    const d = details[c.companyId];
    const current = c.companyId === row.company?.companyId;
    return (
      <li key={c.companyId}>
        <label className={`cand ${selected === c.companyId ? "cand-selected" : ""}`}>
          <input type="radio" name={`pick-${row.id}`} checked={selected === c.companyId} onChange={() => setSelected(c.companyId)} />
          <CompanyLogo src={c.imageUrl} name={c.name} size={36} />
          <span className="cand-main">
            <span className="cand-name">
              {c.name}
              {c.verified && <BadgeCheck size={15} className="verified" aria-label="Verified" />}
              {current && <span className="cand-current">current match</span>}
            </span>
            <CompanyFacts profile={d?.profile} linkedInUrl={c.linkedInUrl} loading={!d} />
            <span className="match-meta">
              {c.hasAccountPlan && <Badge tone="accent">Has plan</Badge>}
              <StatusBadge s={d?.status} />
            </span>
          </span>
        </label>
      </li>
    );
  };

  return (
    <div className="picker" onKeyDown={(e) => e.key === "Escape" && onCancel()}>
      <div className="picker-head">
        <p className="small">
          {review && <span className="picker-step">Reviewing {review.index} of {review.total}</span>}
          Pick the right company for <strong>{row.label}</strong>
        </p>
      </div>

      {extra.length > 0 && (
        <>
          <p className="picker-group">Search results</p>
          <ul className="cands">{extra.map(card)}</ul>
        </>
      )}
      {original.length > 0 && (
        <>
          {extra.length > 0 && <p className="picker-group">Original matches</p>}
          <ul className="cands">{original.map(card)}</ul>
        </>
      )}

      <form
        className="picker-search"
        onSubmit={(e) => {
          e.preventDefault();
          runSearch();
        }}
      >
        <span className="small strong nowrap">Not here?</span>
        <div className="input-wrap input-sm grow">
          <SearchIcon size={15} className="input-icon" aria-hidden="true" />
          <input
            className="input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="LinkedIn URL, domain or name"
            aria-label={`Search for a different company for ${row.label}`}
            autoFocus={!original.length}
          />
        </div>
        <button className="btn btn-ghost small" disabled={!detected || searching}>
          {searching && <Spinner size={14} />} Search
        </button>
      </form>
      {detected && detected.param !== "query" && !found && <p className="hint">Searching by {detected.label}: <code>{detected.value}</code></p>}
      {searchError && <p className="error-text small">{searchError}</p>}

      <div className="row gap wrap picker-actions">
        <button type="button" className="link-btn small danger" onClick={onRemove}>
          Remove from batch
        </button>
        <span className="grow" />
        <button type="button" className="btn btn-ghost small" onClick={onCancel}>
          {review ? "Stop reviewing" : "Cancel"}
        </button>
        <button type="button" className="btn btn-primary small" disabled={!selected} onClick={use}>
          {selected && selected === row.company?.companyId ? "Keep this match" : "Use this company"}
          {review && review.index < review.total ? " · next" : ""}
        </button>
      </div>
    </div>
  );
}
