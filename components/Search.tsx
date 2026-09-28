"use client";

import { useCallback, useRef, useState } from "react";
import { BadgeCheck, Search as SearchIcon } from "lucide-react";
import { ApiError, isAbort, vieu } from "@/lib/api";
import { idParam, type Company, type StakeholdersResponse } from "@/lib/types";
import { detectInput } from "@/lib/detect";
import { Badge, CompanyLogo, LinkedInIcon, Spinner } from "./ui";

type Status = { state: "loading" } | { state: "ok"; data: StakeholdersResponse } | { state: "error"; status: number };

function StatusBadge({ s, company }: { s?: Status; company: Company }) {
  if (!s || s.state === "loading")
    return (
      <Badge>
        <Spinner size={12} /> Checking
      </Badge>
    );
  if (s.state === "error") {
    if (s.status === 404 || !company.accountId) return <Badge>No account yet</Badge>;
    return <Badge tone="warn">Status unavailable</Badge>;
  }
  const d = s.data;
  if (d.generated) return <Badge tone="good">{d.stakeholders?.length ?? 0} stakeholders</Badge>;
  if (d.seedingStatus === "pending") return <Badge tone="accent">Seeding now</Badge>;
  if (d.seedingStatus === "failed") return <Badge tone="bad">Last seed failed</Badge>;
  return <Badge>Not generated</Badge>;
}

export function Search({
  apiKey,
  selected,
  onSelect,
  onKeyInvalid,
}: {
  apiKey: string;
  selected: Company | null;
  onSelect: (c: Company | null, domainHint?: string) => void;
  onKeyInvalid: (msg: string) => void;
}) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rateNote, setRateNote] = useState(false);
  const [results, setResults] = useState<Company[] | null>(null);
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const [domainHint, setDomainHint] = useState<string | undefined>();
  const abortRef = useRef<AbortController | null>(null);
  const detected = detectInput(input);

  // All matches are checked at once, not one after another.
  const checkStatuses = useCallback(
    (companies: Company[], signal: AbortSignal) => {
      setStatuses(Object.fromEntries(companies.map((c) => [c.companyId, { state: "loading" } as Status])));
      companies.forEach((c) => {
        vieu<StakeholdersResponse>(apiKey, "GET", "/accounts/stakeholders", idParam(c), { signal })
          .then((data) => setStatuses((s) => ({ ...s, [c.companyId]: { state: "ok", data } })))
          .catch((e) => {
            if (isAbort(e)) return;
            setStatuses((s) => ({ ...s, [c.companyId]: { state: "error", status: (e as ApiError).status ?? 0 } }));
          });
      });
    },
    [apiKey],
  );

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (!detected) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    onSelect(null);
    setBusy(true);
    setError(null);
    setResults(null);
    try {
      const res = await vieu<{ companies: Company[] }>(apiKey, "GET", "/accounts/search", { [detected.param]: detected.value }, {
        signal: ac.signal,
        onRateLimit: () => setRateNote(true),
      });
      const companies = (res.companies ?? []).slice(0, 5);
      setResults(companies);
      setDomainHint(detected.param === "webDomain" ? detected.value : undefined);
      checkStatuses(companies, ac.signal);
    } catch (err) {
      if (isAbort(err)) return;
      const ae = err as ApiError;
      if (ae.status === 401) return onKeyInvalid(ae.message);
      setError(ae.message);
    } finally {
      setBusy(false);
      setRateNote(false);
    }
  }

  function change() {
    onSelect(null);
    if (results && abortRef.current) checkStatuses(results, abortRef.current.signal);
  }

  const shown = selected ? results?.filter((c) => c.companyId === selected.companyId) ?? [selected] : results;

  return (
    <section className="card">
      <p className="eyebrow">Step 2</p>
      <h2>Find the company</h2>
      <form className="row gap wrap" onSubmit={run}>
        <div className="input-wrap grow">
          <SearchIcon size={18} className="input-icon" aria-hidden="true" />
          <input
            className="input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Company name, domain, email, LinkedIn URL or id"
            aria-label="Company"
            autoFocus
          />
        </div>
        <button className="btn btn-primary" disabled={!detected || busy}>
          {busy ? <Spinner /> : null} Search
        </button>
      </form>
      <p className="hint">
        {detected ? <>Searching by {detected.label}{detected.param !== "query" && <>: <code>{detected.value}</code></>}</> : "A domain gives the most precise match."}
      </p>
      {rateNote && <p className="warn-text">Rate limited, retrying</p>}
      {error && <p className="error-text" role="alert">{error}</p>}

      {results && results.length === 0 && <p className="empty">No companies matched. Try the company&apos;s domain instead.</p>}

      {shown && shown.length > 0 && (
        <>
          {!selected && <p className="muted small">Pick the right company. Similar names can be different companies, like Merck &amp; Co. and Merck KGaA.</p>}
          <ul className="matches">
            {shown.map((c) => (
              <li key={c.companyId}>
                <div className={`match ${selected?.companyId === c.companyId ? "match-selected" : ""}`}>
                  <button className="match-hit" onClick={() => onSelect(c, domainHint)} disabled={!!selected}>
                  <CompanyLogo src={c.imageUrl} name={c.name} />
                  <span className="match-main">
                    <span className="match-name">
                      {c.name}
                      {c.verified && <BadgeCheck size={16} className="verified" aria-label="Verified" />}
                    </span>
                    <span className="match-meta">
                      {c.hasAccountPlan ? <Badge tone="accent">Has plan</Badge> : <Badge>No plan</Badge>}
                      <StatusBadge s={statuses[c.companyId]} company={c} />
                      <span className="mono small muted">{c.companyId}</span>
                    </span>
                  </span>
                  </button>
                  {c.linkedInUrl && (
                    <a className="icon-link" href={c.linkedInUrl} target="_blank" rel="noreferrer" aria-label={`${c.name} on LinkedIn`}>
                      <LinkedInIcon size={20} />
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {selected && (
            <button className="btn btn-ghost small" onClick={change}>
              Change company
            </button>
          )}
        </>
      )}
    </section>
  );
}
