"use client";

import { useState } from "react";
import { History as HistoryIcon, KeyRound, Layers, Search as SearchIcon, X } from "lucide-react";
import type { Company } from "@/lib/types";
import { KeyGate } from "@/components/KeyGate";
import { Search } from "@/components/Search";
import { Run } from "@/components/Run";
import { Batch, type ResumeBatch } from "@/components/Batch";
import { History } from "@/components/History";

type Tab = "lookup" | "batch" | "history";
type Selection = { company: Company; domainHint?: string; run: number };

const TABS: { id: Tab; label: string; icon: typeof SearchIcon }[] = [
  { id: "lookup", label: "Lookup", icon: SearchIcon },
  { id: "batch", label: "Batch", icon: Layers },
  { id: "history", label: "History", icon: HistoryIcon },
];

export default function Home() {
  // The key lives only in React state: no localStorage, no cookies.
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("lookup");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [resume, setResume] = useState<ResumeBatch | null>(null);
  const [session, setSession] = useState(0);

  function clearKey(error: string | null = null) {
    setApiKey(null);
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
                  onKeyInvalid={clearKey}
                />
              )}
            </div>
            <div className="stack" hidden={tab !== "batch"} key={`batch-${session}`}>
              <Batch apiKey={apiKey} onKeyInvalid={clearKey} resume={resume} />
            </div>
          </>
        )}

        {tab === "history" && (
          <History
            hasKey={!!apiKey}
            onResumeBatch={(b) => {
              setResume(b);
              setTab("batch");
            }}
            onRerunLookup={(company, domainHint) => {
              setSelection({ company, domainHint, run: Date.now() });
              setTab("lookup");
            }}
          />
        )}
      </main>

      <footer className="footer">©Vieu {new Date().getFullYear()} • Connect to Close</footer>
    </div>
  );
}
