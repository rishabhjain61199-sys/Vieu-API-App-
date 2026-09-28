"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { cleanDomain } from "@/lib/detect";
import type { CompanyProfile } from "@/lib/types";

export function LinkedInIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="4" fill="currentColor" />
      <circle cx="7" cy="7.2" r="1.7" fill="#fff" />
      <rect x="5.4" y="9.6" width="3.2" height="8.8" fill="#fff" />
      <path
        d="M10.8 9.6h3v1.3c.5-.9 1.6-1.5 3-1.5 2.6 0 3.2 1.6 3.2 3.9v5.1h-3.2v-4.5c0-1.1-.2-2-1.4-2s-1.5.9-1.5 2v4.5h-3.1z"
        fill="#fff"
      />
    </svg>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <LoaderCircle size={size} className="spin" aria-hidden="true" />;
}

export function Badge({ tone = "neutral", children, title }: { tone?: string; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function CompanyLogo({ src, name, size = 40 }: { src: string | null; name: string; size?: number }) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
  return (
    <span className="logo" style={{ width: size, height: size }}>
      <span aria-hidden="true">{initials}</span>
      {src && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.display = "none")} />
      )}
    </span>
  );
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="dialog" onCancel={onCancel} onClose={onCancel}>
      <h3>{title}</h3>
      <div className="dialog-body">{children}</div>
      <div className="row gap end">
        <button className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={onConfirm} autoFocus>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

function compactCount(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** Domain (clickable), size, industry, HQ and LinkedIn for a matched company. */
export function CompanyFacts({
  profile,
  linkedInUrl,
  loading,
  plain = false,
}: {
  profile?: CompanyProfile | null;
  linkedInUrl?: string | null;
  loading?: boolean;
  /** No links (for use inside a button). */
  plain?: boolean;
}) {
  const domain = cleanDomain(profile?.domain);
  const facts = [
    profile?.industry,
    profile?.employeeCount ? `${compactCount(profile.employeeCount)} employees` : null,
    profile?.headquarters,
  ].filter(Boolean);
  if (!domain && !facts.length && !linkedInUrl) return loading ? <span className="facts muted small">Loading details…</span> : null;
  return (
    <span className="facts small">
      {linkedInUrl && !plain && (
        <a className="facts-li" href={linkedInUrl} target="_blank" rel="noreferrer" aria-label="LinkedIn page" title={linkedInUrl}>
          <LinkedInIcon size={14} />
        </a>
      )}
      {domain &&
        (plain ? (
          <span className="facts-domain">{domain}</span>
        ) : (
          <a href={`https://${domain}`} target="_blank" rel="noreferrer" className="facts-domain">
            {domain}
          </a>
        ))}
      {facts.map((f) => (
        <span key={f as string} className="muted">
          {f}
        </span>
      ))}
      {loading && !facts.length && <span className="muted">…</span>}
    </span>
  );
}
