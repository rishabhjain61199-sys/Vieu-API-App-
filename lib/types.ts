import { cleanDomain, type SearchParam } from "./detect";

export type Company = {
  companyId: string;
  name: string;
  linkedInUrl: string | null;
  imageUrl: string | null;
  verified: boolean;
  accountId: string | null;
  hasAccountPlan: boolean;
};

export type SeedingStatus = "not_started" | "pending" | "completed" | "failed";

export type StakeholdersResponse = {
  accountId?: string;
  companyId?: string;
  generated: boolean;
  seedingStatus: SeedingStatus | string;
  message?: string;
  stakeholders: Record<string, unknown>[];
};

export type GenerateResponse = {
  accountId?: string;
  companyId?: string;
  created?: boolean;
  status: string;
  message?: string;
};

export type CompanyProfile = {
  companyId?: string;
  name?: string;
  domain?: string;
  industry?: string;
  employeeCount?: number;
  headquarters?: string;
};

export type Outcome =
  | "already_seeded"
  | "newly_generated"
  | "seed_in_progress"
  | "still_generating"
  | "failed"
  | "not_generated";

export const OUTCOME_LABEL: Record<Outcome, string> = {
  already_seeded: "Already seeded",
  newly_generated: "Newly generated",
  seed_in_progress: "Seed in progress",
  still_generating: "Still generating (timed out)",
  failed: "Failed",
  not_generated: "Not generated yet",
};

export type Ids = { accountId: string | null; companyId: string };

/** Prefer the tenant's accountId; fall back to the global companyId. */
export function idParam(ids: Ids): Record<string, string> {
  return ids.accountId ? { accountId: ids.accountId } : { companyId: ids.companyId };
}

/** A finished (or last-known) single-company result, as shown and saved to history. */
export type RunRecord = {
  company: Company;
  domain?: string;
  industry?: string;
  headquarters?: string;
  accountId: string | null;
  created: boolean;
  outcome: Outcome;
  genMs: number | null;
  joined: boolean;
  /** When generation started (kept so an in-progress lookup can be resumed). */
  genStart?: number | null;
  /** Generation time is an upper bound (the tab was closed while it ran). */
  genApprox?: boolean;
  stakeholders: Record<string, unknown>[];
  message?: string;
  checkedAt: number;
};

/** Passed to a lookup re-opened from History so it continues the same entry. */
export type LookupResume = {
  entryId: string;
  createdAt: number;
  genStart: number | null;
  created: boolean;
  joined: boolean;
  watching: boolean;
};

export type RowStage =
  | "queued"
  | "resolving"
  | "no_match"
  | "error"
  | "checking"
  | "seeded"
  | "not_started"
  | "gen_queued"
  | "generating"
  | "polling"
  | "timeout"
  | "failed"
  | "completed";

export type BatchRow = {
  id: string;
  label: string;
  inputs: Partial<Record<SearchParam, string>>;
  matchedBy?: SearchParam;
  /** The match was picked by the user in the match picker. */
  manual?: boolean;
  candidates: Company[];
  company: Company | null;
  /** Domain, size, industry, HQ of the matched company, to tell lookalikes apart. */
  profile?: CompanyProfile | null;
  ambiguous: boolean;
  stage: RowStage;
  error?: string;
  accountId: string | null;
  created: boolean;
  noAccount: boolean;
  stakeholders: Record<string, unknown>[];
  message?: string;
  genStart: number | null;
  genEnd: number | null;
  watchStart: number | null;
  joined: boolean;
  checkedAt: number | null;
  /** Vieu has reported this seed as pending (it really started). */
  started?: boolean;
  /** Generate was re-sent once because Vieu never started it. */
  resent?: boolean;
};

export type BatchRecord = { name: string; rows: BatchRow[] };

export const STAGE_OUTCOME: Partial<Record<RowStage, Outcome>> = {
  seeded: "already_seeded",
  completed: "newly_generated",
  polling: "seed_in_progress",
  generating: "seed_in_progress",
  timeout: "still_generating",
  failed: "failed",
  not_started: "not_generated",
  gen_queued: "not_generated",
};

export function rowToRecord(row: BatchRow): RunRecord | null {
  if (!row.company) return null;
  const outcome = STAGE_OUTCOME[row.stage];
  if (!outcome) return null;
  return {
    company: row.company,
    domain: row.inputs.webDomain ?? cleanDomain(row.profile?.domain),
    industry: row.profile?.industry,
    headquarters: row.profile?.headquarters,
    accountId: row.accountId,
    created: row.created,
    outcome,
    genMs: row.stage === "completed" && row.genStart && row.genEnd ? row.genEnd - row.genStart : null,
    joined: row.joined,
    stakeholders: row.stakeholders,
    message: row.message,
    checkedAt: row.checkedAt ?? Date.now(),
  };
}
