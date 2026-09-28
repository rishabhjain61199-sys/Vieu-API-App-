"use client";

import { useEffect, useState } from "react";
import { HISTORY_EVENT, listEntries, type HistoryEntry } from "./history";
import { tenantKey } from "./tenant";
import { rowToRecord, type RunRecord } from "./types";

/**
 * The Partner API returns only people, each tagged with a pod (`swimlane`), so an
 * empty pod leaves no trace. Pods are the tenant's stakeholder categories, shared
 * by all its accounts, so the full set is the union of pods seen across every
 * saved account for the tenant.
 */
export function tenantPods(entries: HistoryEntry[], tenant?: string, extra: Record<string, unknown>[] = []) {
  const want = tenantKey(tenant);
  const names = new Set<string>();
  const add = (raws: Record<string, unknown>[]) => {
    for (const s of raws) {
      const pod = typeof s.swimlane === "string" ? s.swimlane.trim() : "";
      if (pod) names.add(pod);
    }
  };
  for (const e of entries) {
    if (tenantKey(e.tenant) !== want) continue;
    const records = e.kind === "lookup" ? [e.data] : e.data.rows.map(rowToRecord).filter((r): r is RunRecord => !!r);
    for (const r of records) add(r.stakeholders);
  }
  add(extra);
  return [...names];
}

/** Live list of the tenant's pods, updated whenever History changes. */
export function useTenantPods(tenant?: string) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  useEffect(() => {
    const load = () => listEntries().then(setEntries);
    load();
    window.addEventListener(HISTORY_EVENT, load);
    return () => window.removeEventListener(HISTORY_EVENT, load);
  }, []);
  return (extra: Record<string, unknown>[] = []) => tenantPods(entries, tenant, extra);
}
