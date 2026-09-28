import { downloadFile, slugify, today, toCsv } from "./csv";
import type { Outcome } from "./types";

export type Flag = { kind: "duplicate" | "off_target"; label: string; detail: string };

export type Stakeholder = {
  key: string;
  personId: string;
  name: string;
  title: string;
  location: string;
  linkedInUrl: string;
  vieuUrl: string;
  company: string;
  pod: string;
  flags: Flag[];
};

export type Pod = { name: string; people: Stakeholder[]; flagged: number };

const str = (v: unknown) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));

/**
 * The spec names the schema `AccountStakeholder` (swimlane = power pod). Read those
 * fields first and tolerate a few plausible aliases so a renamed field degrades
 * gracefully instead of blanking the UI.
 */
function normalize(raw: Record<string, unknown>, i: number): Stakeholder {
  const name =
    str(raw.name) || [str(raw.firstName), str(raw.lastName)].filter(Boolean).join(" ") || "Unnamed";
  const personId = str(raw.personId ?? raw.id);
  return {
    key: personId || `row-${i}`,
    personId,
    name,
    title: str(raw.title ?? raw.jobTitle),
    location: str(raw.location),
    linkedInUrl: str(raw.linkedInUrl ?? raw.linkedinUrl),
    vieuUrl: str(raw.vieuUrl ?? raw.vieuLink),
    company: str(raw.company ?? raw.companyName),
    pod: str(raw.swimlane ?? raw.powerPod ?? raw.pod) || "Unassigned",
    flags: [],
  };
}

export function normalizeName(n: string) {
  return n
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .split(",")[0]
    .replace(/\b(dr|mr|mrs|ms|prof|jr|sr|ii|iii|iv|phd|mba|md|cpa|pmp|cissp)\b\.?/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function linkedInSlug(url: string) {
  const m = url.toLowerCase().match(/linkedin\.com\/in\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

const COMPANY_NOISE =
  /\b(the|inc|incorporated|corp|corporation|co|company|llc|llp|ltd|limited|plc|gmbh|kgaa|ag|sa|nv|bv|group|holdings?|international|intl)\b/g;

export function companyCore(n: string) {
  return n
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(COMPANY_NOISE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Loose match: "Merck & Co., Inc." ~ "Merck Sharp & Dohme" ~ merck.com. */
function sameCompany(listed: string, targets: string[]) {
  const a = companyCore(listed);
  if (!a) return true;
  return targets.some((t) => {
    const b = companyCore(t);
    if (!b) return false;
    if (a.includes(b) || b.includes(a)) return true;
    return a.split(" ")[0] === b.split(" ")[0];
  });
}

const OFF_TARGET_TITLE =
  /\b(owner|co-?founder|founder|ceo|chief executive officer|angel investor|available|open to work|seeking (new )?opportunit\w*|looking for (new )?(opportunit\w*|roles?)|self[- ]employed|freelancer?|retired|student|intern)\b/i;

export function analyze(
  raws: Record<string, unknown>[],
  company: { name: string; domain?: string },
  /** Every pod known for the tenant; any this account lacks are listed with 0 people. */
  allPods: string[] = [],
): { people: Stakeholder[]; pods: Pod[]; flaggedCount: number } {
  const people = raws.map(normalize);
  const targets = [company.name, company.domain?.split(".")[0] ?? ""].filter(Boolean);

  // Duplicates: same normalized name (or same LinkedIn profile) anywhere in the account.
  const byKey = new Map<string, Stakeholder[]>();
  for (const p of people) {
    const keys = new Set([`n:${normalizeName(p.name)}`]);
    const slug = linkedInSlug(p.linkedInUrl);
    if (slug) keys.add(`l:${slug}`);
    for (const k of keys) byKey.set(k, [...(byKey.get(k) ?? []), p]);
  }
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    for (const p of group) {
      if (p.flags.some((f) => f.kind === "duplicate")) continue;
      const others = group.filter((o) => o !== p);
      const samePod = others.filter((o) => o.pod === p.pod).length;
      const elsewhere = [...new Set(others.filter((o) => o.pod !== p.pod).map((o) => o.pod))];
      const parts = [];
      if (samePod) parts.push(`${samePod + 1}× in this pod`);
      if (elsewhere.length) parts.push(`also in ${elsewhere.join(", ")}`);
      p.flags.push({ kind: "duplicate", label: "Possible duplicate", detail: parts.join("; ") });
    }
  }

  for (const p of people) {
    const reasons: string[] = [];
    const m = p.title.match(OFF_TARGET_TITLE);
    if (m) reasons.push(`title mentions "${m[0]}"`);
    if (p.company && !sameCompany(p.company, targets)) reasons.push(`listed at ${p.company}`);
    const at = p.title.match(/\s(?:at|@)\s+([^|,;]+)$/i);
    if (at && !sameCompany(at[1], targets)) reasons.push(`title says ${at[0].trim()}`);
    if (reasons.length) p.flags.push({ kind: "off_target", label: "Possibly off-target", detail: reasons.join("; ") });
  }

  const podMap = new Map<string, Stakeholder[]>();
  for (const p of people) podMap.set(p.pod, [...(podMap.get(p.pod) ?? []), p]);
  for (const name of allPods) if (!podMap.has(name)) podMap.set(name, []);
  const pods = [...podMap.entries()]
    .map(([name, list]) => ({ name, people: list, flagged: list.filter((p) => p.flags.length).length }))
    .sort((a, b) => b.people.length - a.people.length || a.name.localeCompare(b.name));

  return { people, pods, flaggedCount: people.filter((p) => p.flags.length).length };
}

export const CSV_COLUMNS = [
  "company", "companyId", "accountId", "outcome", "pod", "name", "title",
  "location", "linkedInUrl", "vieuUrl", "personId", "flags",
] as const;

export type CsvMeta = { company: string; companyId: string; accountId: string; outcome: Outcome };

/** Stakeholder rows (no header) in CSV_COLUMNS order. */
export function stakeholderCsvRows(pods: Pod[], meta: CsvMeta): string[][] {
  return pods.flatMap((pod) =>
    pod.people.map((p) => [
      meta.company, meta.companyId, meta.accountId, meta.outcome, pod.name, p.name, p.title,
      p.location, p.linkedInUrl, p.vieuUrl, p.personId,
      p.flags.map((f) => `${f.label}${f.detail ? ` (${f.detail})` : ""}`).join("; "),
    ]),
  );
}

export function downloadStakeholderCsv(pods: Pod[], meta: CsvMeta) {
  const text = toCsv([[...CSV_COLUMNS], ...stakeholderCsvRows(pods, meta)]);
  downloadFile(`${slugify(meta.company)}_stakeholders_${meta.outcome}_${today()}.csv`, text);
}
