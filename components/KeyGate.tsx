"use client";

import { useState } from "react";
import { Eye, EyeOff, KeyRound } from "lucide-react";

export function KeyGate({ error, onSubmit }: { error: string | null; onSubmit: (key: string) => void }) {
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);

  return (
    <section className="card">
      <p className="eyebrow">Step 1</p>
      <h2>Paste your Partner API key</h2>
      <p className="muted">The key picks the tenant. It stays in this tab&apos;s memory. It is never saved, and refreshing the page clears it.</p>
      <form
        className="row gap wrap"
        onSubmit={(e) => {
          e.preventDefault();
          const k = value.trim();
          if (k) onSubmit(k);
        }}
      >
        <div className="input-wrap grow">
          <KeyRound size={18} className="input-icon" aria-hidden="true" />
          <input
            className="input"
            type={show ? "text" : "password"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="x-api-key"
            aria-label="Vieu Partner API key"
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            autoFocus
          />
          <button type="button" className="icon-btn" onClick={() => setShow((s) => !s)} aria-label={show ? "Hide key" : "Show key"}>
            {show ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        </div>
        <button className="btn btn-primary" disabled={!value.trim()}>
          Use key
        </button>
      </form>
      {error && <p className="error-text" role="alert">{error}. Paste a different key.</p>}
    </section>
  );
}
