import { ApiError, vieu } from "./api";

export type Tenant =
  | { status: "detecting" }
  | { status: "known"; name: string }
  | { status: "unknown"; reason: string };

type Intro = { pointOfContact?: { email?: string | null } | null };

/**
 * The Partner API has no "who am I" endpoint, so the tenant is inferred: every
 * introduction's point of contact is a user inside the key's tenant, and their
 * email domain names it. Several keys for one tenant resolve to the same name.
 * Throws on 401 so the caller can treat the key as invalid.
 */
export async function detectTenant(key: string, signal?: AbortSignal): Promise<Tenant> {
  try {
    const r = await vieu<{ introductions?: Intro[] }>(key, "GET", "/introductions", { pageSize: "50" }, { signal });
    const counts = new Map<string, number>();
    for (const intro of r.introductions ?? []) {
      const domain = intro.pointOfContact?.email?.split("@")[1]?.trim().toLowerCase();
      if (domain && !domain.endsWith("vieu.api")) counts.set(domain, (counts.get(domain) ?? 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top) return { status: "known", name: top[0] };
    return {
      status: "unknown",
      reason: r.introductions?.length
        ? "This tenant's introductions have no point of contact, so it can't be identified."
        : "This tenant has no pinned introductions yet, so it can't be identified.",
    };
  } catch (e) {
    const status = (e as ApiError).status;
    if (status === 401) throw e;
    if (status === 403) return { status: "unknown", reason: "This key can't read introductions, so its tenant can't be identified. Everything else works." };
    return { status: "unknown", reason: "Couldn't identify the tenant right now." };
  }
}
