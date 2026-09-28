"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown, Download, ExternalLink, Search as SearchIcon, Tag } from "lucide-react";
import { downloadFile, slugify, today, toCsv } from "@/lib/csv";
import { HISTORY_EVENT, isSavingEnabled, listEntries, type HistoryEntry } from "@/lib/history";
import { analyze, CSV_COLUMNS, type Stakeholder } from "@/lib/stakeholders";
import { tenantKey } from "@/lib/tenant";
import { rowToRecord, type Outcome, type RunRecord } from "@/lib/types";
import { LinkedInIcon } from "./ui";

type Row = {
  id: string;
  person: Stakeholder;
  company: string;
  companyId: string;
  accountId: string;
  outcome: Outcome;
  tenant: string;
};

type SortKey = "name" | "title" | "pod" | "company" | "location" | "flags";
const PAGE = 300;

/** Newest saved result per (tenant, company), from lookups and batch rows alike. */
function latestRecords(entries: HistoryEntry[]) {
  const best = new Map<string, { record: RunRecord; at: number; tenant: string }>();
  for (const e of entries) {
    const records =
      e.kind === "lookup" ? [e.data] : e.data.rows.map(rowToRecord).filter((r): r is RunRecord => !!r);
    for (const record of records) {
      if (!record.stakeholders.length) continue;
      const key = `${tenantKey(e.tenant)}|${record.company.companyId}`;
      const at = record.checkedAt ?? e.updatedAt;
      const cur = best.get(key);
      if (!cur || at > cur.at) best.set(key, { record, at, tenant: e.tenant?.trim() ?? "" });
    }
  }
  return [...best.values()];
}

export type StakeholderFocus = { companyId: string; n: number } | null;

export function Stakeholders({ currentTenant, focus }: { currentTenant?: string; focus: StakeholderFocus }) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [tenant, setTenant] = useState<string>(() => tenantKey(currentTenant) || "all");
  const [company, setCompany] = useState<string>("all");
  const [pod, setPod] = useState<string>("all");
  const [q, setQ] = useState("");
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastClicked, setLastClicked] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);

  useEffect(() => {
    const load = () => listEntries().then(setEntries);
    load();
    window.addEventListener(HISTORY_EVENT, load);
    return () => window.removeEventListener(HISTORY_EVENT, load);
  }, []);

  // "View" on a batch row lands here filtered to that company.
  useEffect(() => {
    if (!focus) return;
    setCompany(focus.companyId);
    setPod("all");
    setQ("");
    setFlaggedOnly(false);
    setTenant(tenantKey(currentTenant) || "all");
    setLimit(PAGE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.n]);

  const allRows = useMemo<Row[]>(() => {
    if (!entries) return [];
    return latestRecords(entries).flatMap(({ record, tenant: t }) => {
      const { people } = analyze(record.stakeholders, { name: record.company.name, domain: record.domain });
      return people.map((person) => ({
        id: `${tenantKey(t)}|${record.company.companyId}|${person.key}`,
        person,
        company: record.company.name,
        companyId: record.company.companyId,
        accountId: record.accountId ?? "",
        outcome: record.outcome,
        tenant: t,
      }));
    });
  }, [entries]);

  const tenants = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of allRows) if (!m.has(tenantKey(r.tenant))) m.set(tenantKey(r.tenant), r.tenant || "Unknown tenant");
    return [...m.entries()];
  }, [allRows]);

  const inTenant = allRows.filter((r) => tenant === "all" || tenantKey(r.tenant) === tenant);
  const companies = useMemo(() => {
    const m = new Map<string, { name: string; n: number }>();
    for (const r of inTenant) m.set(r.companyId, { name: r.company, n: (m.get(r.companyId)?.n ?? 0) + 1 });
    return [...m.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  }, [inTenant]);
  const inCompany = inTenant.filter((r) => company === "all" || r.companyId === company);
  // Every pod seen for the tenant (pods are tenant-wide), with 0 where this selection has none.
  const pods = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of inTenant) if (r.person.pod !== "Unassigned") m.set(r.person.pod, 0);
    for (const r of inCompany) m.set(r.person.pod, (m.get(r.person.pod) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [inTenant, inCompany]);

  const needle = q.trim().toLowerCase();
  const filtered = inCompany.filter(
    (r) =>
      (pod === "all" || r.person.pod === pod) &&
      (!flaggedOnly || r.person.flags.length > 0) &&
      (!needle || `${r.person.name} ${r.person.title} ${r.person.location} ${r.company}`.toLowerCase().includes(needle)),
  );
  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const val = (r: Row) =>
      sort.key === "flags"
        ? r.person.flags.length
        : sort.key === "company"
          ? r.company.toLowerCase()
          : String(r.person[sort.key] ?? "").toLowerCase();
    return [...filtered].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }, [filtered, sort]);
  const shown = sorted.slice(0, limit);

  const selectedRows = sorted.filter((r) => selected.has(r.id));
  const allShownSelected = shown.length > 0 && shown.every((r) => selected.has(r.id));
  const someShownSelected = shown.some((r) => selected.has(r.id));

  function toggleRow(id: string, shift: boolean) {
    const next = new Set(selected);
    const on = !next.has(id);
    if (shift && lastClicked) {
      const a = shown.findIndex((r) => r.id === lastClicked);
      const b = shown.findIndex((r) => r.id === id);
      if (a >= 0 && b >= 0) for (const r of shown.slice(Math.min(a, b), Math.max(a, b) + 1)) on ? next.add(r.id) : next.delete(r.id);
    } else on ? next.add(id) : next.delete(id);
    setSelected(next);
    setLastClicked(id);
  }

  function sortBy(key: SortKey) {
    setSort((cur) => (cur?.key === key ? (cur.dir === 1 ? { key, dir: -1 } : null) : { key, dir: 1 }));
  }

  function exportRows(rows: Row[], tag: string) {
    const lines: unknown[][] = [[...CSV_COLUMNS]];
    for (const r of rows) {
      const p = r.person;
      lines.push([
        r.company, r.companyId, r.accountId, r.outcome, p.pod, p.name, p.title, p.location, p.linkedInUrl, p.vieuUrl, p.personId,
        p.flags.map((f) => `${f.label}${f.detail ? ` (${f.detail})` : ""}`).join("; "),
      ]);
    }
    const scope = company !== "all" ? slugify(companies.find(([id]) => id === company)?.[1].name ?? "company") : "all_companies";
    downloadFile(`${scope}_stakeholders_${tag}_${today()}.csv`, toCsv(lines));
  }

  const resetPage = () => setLimit(PAGE);

  if (entries === null) return null;

  if (!allRows.length) {
    return (
      <section className="card">
        <p className="eyebrow">Stakeholders</p>
        <h2>No stakeholders yet</h2>
        <p className="muted">
          Stakeholders from every lookup and batch collect here, so you can browse and export them in one place.
          {!isSavingEnabled() && " Saving is turned off in History, so new results won't appear here."}
        </p>
      </section>
    );
  }

  return (
    <section className="card table-card">
      <div className="table-toolbar st-toolbar">
        <div className="row gap wrap">
          {tenants.length > 1 && (
            <select className="select select-lg" value={tenant} onChange={(e) => (setTenant(e.target.value), setCompany("all"), resetPage())} aria-label="Tenant">
              <option value="all">All tenants</option>
              {tenants.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          )}
          <select className="select select-lg" value={company} onChange={(e) => (setCompany(e.target.value), setPod("all"), resetPage())} aria-label="Company">
            <option value="all">All companies ({companies.length})</option>
            {companies.map(([id, c]) => (
              <option key={id} value={id}>
                {c.name} ({c.n})
              </option>
            ))}
          </select>
          <select className="select select-lg" value={pod} onChange={(e) => (setPod(e.target.value), resetPage())} aria-label="Power pod">
            <option value="all">All power pods ({pods.length})</option>
            {pods.map(([name, n]) => (
              <option key={name} value={name}>
                {name} ({n})
              </option>
            ))}
          </select>
          <div className="input-wrap input-sm grow">
            <SearchIcon size={16} className="input-icon" aria-hidden="true" />
            <input className="input" value={q} onChange={(e) => (setQ(e.target.value), resetPage())} placeholder="Search name, title, location, company" aria-label="Search stakeholders" />
          </div>
          <label className="toggle">
            <input type="checkbox" checked={flaggedOnly} onChange={(e) => (setFlaggedOnly(e.target.checked), resetPage())} /> Flagged only
          </label>
        </div>
        <div className="row gap wrap st-summary">
          <span className="muted">
            <strong className="kpi-inline">{sorted.length.toLocaleString()}</strong> stakeholders
            {company === "all" && <> across {companies.length} {companies.length === 1 ? "company" : "companies"}</>}
          </span>
          <span className="grow" />
          <button className="btn btn-ghost small" onClick={() => exportRows(sorted, "filtered")} disabled={!sorted.length}>
            <Download size={14} /> Export {sorted.length === allRows.length ? "all" : "filtered"}
          </button>
        </div>
      </div>

      {selected.size > 0 && (
        <div className="bulk-bar" role="toolbar" aria-label="Selected stakeholders">
          <span className="strong">{selectedRows.length} selected</span>
          <button className="btn btn-primary small" onClick={() => exportRows(selectedRows, `${selectedRows.length}_selected`)} disabled={!selectedRows.length}>
            <Download size={14} /> Export selected
          </button>
          <span className="grow" />
          <button className="link-btn small" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
        </div>
      )}

      <div className="table-scroll">
        <table className="table st-table">
          <thead>
            <tr>
              <th className="col-check">
                <input
                  type="checkbox"
                  aria-label="Select all shown"
                  checked={allShownSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = !allShownSelected && someShownSelected;
                  }}
                  onChange={() => {
                    const next = new Set(selected);
                    shown.forEach((r) => (allShownSelected ? next.delete(r.id) : next.add(r.id)));
                    setSelected(next);
                  }}
                />
              </th>
              <Th label="Name" k="name" sort={sort} onSort={sortBy} />
              <Th label="Title" k="title" sort={sort} onSort={sortBy} />
              <Th label="Power pod" k="pod" sort={sort} onSort={sortBy} />
              {company === "all" && <Th label="Company" k="company" sort={sort} onSort={sortBy} />}
              <Th label="Location" k="location" sort={sort} onSort={sortBy} />
              <Th label="Flags" k="flags" sort={sort} onSort={sortBy} />
              <th aria-label="LinkedIn" />
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={8} className="empty-cell">
                  No stakeholders match these filters.
                </td>
              </tr>
            )}
            {shown.map((r) => {
              const p = r.person;
              return (
                <tr key={r.id} className={`${selected.has(r.id) ? "row-selected" : ""} ${p.flags.length ? "row-flagged" : ""}`}>
                  <td className="col-check">
                    <input type="checkbox" aria-label={`Select ${p.name}`} checked={selected.has(r.id)} onChange={() => {}} onClick={(e) => toggleRow(r.id, e.shiftKey)} />
                  </td>
                  <td className="st-name">
                    {p.vieuUrl ? (
                      <a className="person-name" href={p.vieuUrl} target="_blank" rel="noreferrer">
                        {p.name} <ExternalLink size={12} aria-hidden="true" />
                      </a>
                    ) : (
                      <span className="person-name">{p.name}</span>
                    )}
                  </td>
                  <td>{p.title || <span className="muted">No title</span>}</td>
                  <td>
                    <button className="pod-tag" onClick={() => (setPod(p.pod), resetPage())} title={`Show only ${p.pod}`}>
                      {p.pod}
                    </button>
                  </td>
                  {company === "all" && (
                    <td>
                      <button className="link-btn plain" onClick={() => (setCompany(r.companyId), setPod("all"), resetPage())} title={`Show only ${r.company}`}>
                        {r.company}
                      </button>
                      {tenant === "all" && r.tenant && (
                        <span className="muted small nowrap">
                          {" "}
                          <Tag size={11} /> {r.tenant}
                        </span>
                      )}
                    </td>
                  )}
                  <td className="muted">{p.location}</td>
                  <td>
                    {p.flags.map((f) => (
                      <span key={f.kind} className={`flag flag-${f.kind}`} title={f.detail}>
                        {f.label}
                      </span>
                    ))}
                  </td>
                  <td>
                    {p.linkedInUrl && (
                      <a className="icon-link" href={p.linkedInUrl} target="_blank" rel="noreferrer" aria-label={`${p.name} on LinkedIn`}>
                        <LinkedInIcon size={18} />
                      </a>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {sorted.length > shown.length && (
        <div className="show-more">
          <span className="muted small">
            Showing {shown.length.toLocaleString()} of {sorted.length.toLocaleString()}
          </span>
          <button className="btn btn-ghost small" onClick={() => setLimit((l) => l + PAGE)}>
            Show {Math.min(PAGE, sorted.length - shown.length)} more
          </button>
        </div>
      )}
    </section>
  );
}

function Th({
  label,
  k,
  sort,
  onSort,
}: {
  label: string;
  k: SortKey;
  sort: { key: SortKey; dir: 1 | -1 } | null;
  onSort: (k: SortKey) => void;
}) {
  const active = sort?.key === k;
  return (
    <th aria-sort={active ? (sort!.dir === 1 ? "ascending" : "descending") : "none"}>
      <button className={`th-sort ${active ? "th-sort-active" : ""}`} onClick={() => onSort(k)}>
        {label}
        <span className="th-arrow" aria-hidden="true">
          {active ? sort!.dir === 1 ? <ArrowUp size={13} /> : <ArrowDown size={13} /> : <ChevronsUpDown size={13} />}
        </span>
      </button>
    </th>
  );
}
