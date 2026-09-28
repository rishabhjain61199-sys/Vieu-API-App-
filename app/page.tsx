"use client";

import { useEffect, useRef, useState } from "react";
import { History as HistoryIcon, KeyRound, Layers, Search as SearchIcon, X } from "lucide-react";
import type { Company, LookupResume } from "@/lib/types";
import { setTitleLabel } from "@/lib/notify";
import { detectTenant, type Tenant } from "@/lib/tenant";
import type { ApiError } from "@/lib/api";
import { KeyGate } from "@/components/KeyGate";
import { Search } from "@/components/Search";
import { Run } from "@/components/Run";
import { Batch, type ResumeBatch } from "@/components/Batch";
import { History } from "@/components/History";

type Tab = "lookup" | "batch" | "history";
type Selection = { company: Company; domainHint?: string; run: number; resume?: LookupResume };

const TABS: { id: Tab; label: string; icon: typeof SearchIcon }[] = [
  { id: "lookup", label: "Lookup", icon: SearchIcon },
  { id: "batch", label: "Batch", icon: Layers },
  { id: "history", label: "History", icon: HistoryIcon },
];

export default function Home() {
  // The key lives only in React state: no localStorage, no cookies.
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  // Which tenant the key belongs to, inferred from the API (see lib/tenant.ts). Tags History entries.
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const keyLabel = tenant?.status === "known" ? tenant.name : "";
  const currentKey = useRef<string | null>(null);
  currentKey.current = apiKey;
  const [tab, setTab] = useState<Tab>("lookup");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [resume, setResume] = useState<ResumeBatch | null>(null);
  const [session, setSession] = useState(0);

  useEffect(() => setTitleLabel(apiKey ? keyLabel : ""), [apiKey, keyLabel]);

  function clearKey(error: string | null = null) {
    setApiKey(null);
    setTenant(null);
    setSelection(null);
    setResume(null);
    setSession((s) => s + 1); // unmounts Lookup/Batch, which stops any polling
    setKeyError(error);
  }

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <p className="eyebrow">Vieu Partner API</p>
          <h1>Stakeholder Lookup</h1>
        </div>
        {apiKey && (
          <div className="key-status">
            <span className="key-pill">
              <KeyRound size={14} aria-hidden="true" /> Key in memory
              <span className="key-label" title={tenant?.status === "unknown" ? tenant.reason : undefined}>
                {tenant?.status === "known" && <>· {tenant.name}</>}
                {tenant?.status === "detecting" && <>· identifying tenant…</>}
                {tenant?.status === "unknown" && <>· tenant unknown</>}
              </span>
            </span>
            <button className="btn btn-ghost small" onClick={() => clearKey()}>
              <X size={14} /> Clear key
            </button>
          </div>
        )}
      </header>

      <nav className="tabs" role="tablist" aria-label="Sections">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`tab ${tab === id ? "tab-active" : ""}`} onClick={() => setTab(id)}>
            <Icon size={16} aria-hidden="true" /> {label}
          </button>
        ))}
      </nav>

      <main className="stack">
        {!apiKey && tab !== "history" && (
          <KeyGate
            error={keyError}
            onSubmit={(k) => {
              setApiKey(k);
              setKeyError(null);
              setTenant({ status: "detecting" });
              // Runs alongside whatever the user does next; also rejects a bad key right away.
              // Ignore the answer if the key was cleared or replaced in the meantime.
              detectTenant(k)
                .then((t) => currentKey.current === k && setTenant(t))
                .catch((e: ApiError) => currentKey.current === k && clearKey(e.message));
            }}
          />
        )}

        {apiKey && (
          <>
            {/* Kept mounted while hidden so a running seed keeps polling when you switch tabs. */}
            <div className="stack" hidden={tab !== "lookup"} key={`lookup-${session}`}>
              <Search
                apiKey={apiKey}
                selected={selection?.company ?? null}
                onSelect={(company, domainHint) => setSelection(company ? { company, domainHint, run: Date.now() } : null)}
                onKeyInvalid={clearKey}
              />
              {selection && (
                <Run
                  key={`${selection.company.companyId}-${selection.run}`}
                  apiKey={apiKey}
                  company={selection.company}
                  domainHint={selection.domainHint}
                  tenant={keyLabel || undefined}
                  resume={selection.resume}
                  onKeyInvalid={clearKey}
                />
              )}
            </div>
            <div className="stack" hidden={tab !== "batch"} key={`batch-${session}`}>
              <Batch apiKey={apiKey} tenant={keyLabel || undefined} onKeyInvalid={clearKey} resume={resume} />
            </div>
          </>
        )}

        {tab === "history" && (
          <History
            hasKey={!!apiKey}
            currentTenant={apiKey ? keyLabel : undefined}
            onResumeBatch={(b) => {
              setResume(b);
              setTab("batch");
            }}
            onRerunLookup={(company, domainHint, lookupResume) => {
              setSelection({ company, domainHint, run: Date.now(), resume: lookupResume });
              setTab("lookup");
            }}
          />
        )}
      </main>

      <footer className="footer">©Vieu {new Date().getFullYear()} • Connect to Close</footer>
    </div>
  );
}
