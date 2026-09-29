import { ApiError, vieu } from "./api";

export type Tenant =
  | { status: "detecting" }
  | { status: "known"; name: string }
  | { status: "unknown"; reason: string };

type Person = { email?: string | null } | null | undefined;
type Intro = { pointOfContact?: Person; introducer?: Person };

// Vieu staff are often the point of contact on a customer's introductions (managed tenants),
// and introducers sometimes use personal mail, so neither names the tenant.
const VIEU_DOMAINS = new Set(["vieu.com", "vieu.api", "seeqe.com"]);
const PERSONAL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com", "live.com", "icloud.com",
  "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "yandex.com", "zoho.com",
]);
const domainOf = (p: Person) => p?.email?.split("@")[1]?.trim().toLowerCase() || "";

/**
 * The Partner API has no "who am I" endpoint, so the tenant is inferred from the
 * email domains on its introductions: points of contact and introducers are the
 * tenant's own people, except Vieu staff (managed tenants) and personal mail.
 * The most common remaining domain names the tenant; a tenant whose only
 * domain is Vieu's is Vieu itself. Several keys for one tenant agree.
 * Throws on 401 so the caller can treat the key as invalid.
 */
export async function detectTenant(key: string, signal?: AbortSignal): Promise<Tenant> {
  try {
    const r = await vieu<{ introductions?: Intro[] }>(key, "GET", "/introductions", { pageSize: "25" }, { signal });
    const counts = new Map<string, number>();
    let vieuSeen = false;
    for (const intro of r.introductions ?? []) {
      for (const domain of [domainOf(intro.pointOfContact), domainOf(intro.introducer)]) {
        if (!domain || PERSONAL_DOMAINS.has(domain)) continue;
        if (VIEU_DOMAINS.has(domain)) vieuSeen = true;
        else counts.set(domain, (counts.get(domain) ?? 0) + 1);
      }
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top) return { status: "known", name: top[0] };
    if (vieuSeen) return { status: "known", name: "vieu.com" };
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

/** Tenant names group case- and space-insensitively; several keys can share one tenant. */
export const tenantKey = (t?: string) => (t ?? "").trim().replace(/\s+/g, " ").toLowerCase();
