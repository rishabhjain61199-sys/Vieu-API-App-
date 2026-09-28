"use client";

import { useState } from "react";
import { ChevronDown, Search, ExternalLink } from "lucide-react";
import type { Pod, Stakeholder } from "@/lib/stakeholders";
import { LinkedInIcon } from "./ui";

function matches(p: Stakeholder, q: string) {
  return !q || `${p.name} ${p.title} ${p.location}`.toLowerCase().includes(q);
}

export function Pods({
  pods,
  open,
  onOpenChange,
}: {
  pods: Pod[];
  open: Set<string>;
  onOpenChange: (s: Set<string>) => void;
}) {
  const [filter, setFilter] = useState("");
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const q = filter.trim().toLowerCase();
  const filtering = !!q || flaggedOnly;

  const visible = pods
    .map((pod) => ({ ...pod, shown: pod.people.filter((p) => matches(p, q) && (!flaggedOnly || p.flags.length)) }))
    .filter((pod) => !filtering || pod.shown.length);
  const allOpen = visible.every((p) => open.has(p.name));

  function toggle(name: string) {
    const next = new Set(open);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    onOpenChange(next);
  }

  return (
    <section className="card">
      <div className="row gap wrap pods-toolbar">
        <h2 className="grow">Stakeholders by power pod</h2>
        <div className="input-wrap input-sm">
          <Search size={16} className="input-icon" aria-hidden="true" />
          <input className="input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter name, title, location" aria-label="Filter stakeholders" />
        </div>
        <label className="toggle">
          <input type="checkbox" checked={flaggedOnly} onChange={(e) => setFlaggedOnly(e.target.checked)} /> Flagged only
        </label>
        <button className="btn btn-ghost small" onClick={() => onOpenChange(allOpen ? new Set() : new Set(visible.map((p) => p.name)))}>
          {allOpen ? "Collapse all" : "Expand all"}
        </button>
      </div>

      {visible.length === 0 && <p className="empty">No stakeholders match this filter.</p>}

      <div className="pods">
        {visible.map((pod) => {
          const isOpen = filtering || open.has(pod.name);
          return (
            <div className="pod" key={pod.name} id={`pod-${encodeURIComponent(pod.name)}`}>
              <button className="pod-head" onClick={() => toggle(pod.name)} aria-expanded={isOpen}>
                <ChevronDown size={18} className={`chev ${isOpen ? "" : "chev-closed"}`} aria-hidden="true" />
                <span className="pod-name">{pod.name}</span>
                <span className="pod-count">{filtering ? `${pod.shown.length} of ${pod.people.length}` : pod.people.length}</span>
                {pod.flagged > 0 && <span className="pod-flagged">{pod.flagged} flagged</span>}
              </button>
              {isOpen && (
                <ul className="people">
                  {pod.shown.map((p) => (
                    <Person key={p.key} p={p} />
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
      <p className="muted small">Flags are hints for review. No one is removed automatically.</p>
    </section>
  );
}

function Person({ p }: { p: Stakeholder }) {
  return (
    <li className={`person ${p.flags.length ? "person-flagged" : ""}`}>
      <div className="person-main">
        {p.vieuUrl ? (
          <a className="person-name" href={p.vieuUrl} target="_blank" rel="noreferrer">
            {p.name} <ExternalLink size={12} aria-hidden="true" />
          </a>
        ) : (
          <span className="person-name">{p.name}</span>
        )}
        <span className="person-title">{p.title || <span className="muted">No title</span>}</span>
        {p.flags.length > 0 && (
          <span className="person-flags">
            {p.flags.map((f) => (
              <span key={f.kind} className={`flag flag-${f.kind}`} title={f.detail}>
                {f.label}
                {f.detail && <span className="flag-detail">: {f.detail}</span>}
              </span>
            ))}
          </span>
        )}
      </div>
      <span className="person-loc">{p.location}</span>
      {p.linkedInUrl ? (
        <a className="icon-link" href={p.linkedInUrl} target="_blank" rel="noreferrer" aria-label={`${p.name} on LinkedIn`}>
          <LinkedInIcon size={18} />
        </a>
      ) : (
        <span className="icon-link" />
      )}
    </li>
  );
}
