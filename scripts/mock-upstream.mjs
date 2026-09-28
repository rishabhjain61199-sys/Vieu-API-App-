// Local stand-in for the Vieu Partner API, used to exercise every UI branch.
// Run: npm run mock   then   VIEU_API_BASE=http://localhost:8787/api/v2 npm run dev
// Keys: "bad" -> 401, "noscope" -> 403, anything else is accepted.
// Tenant detection (/introductions): a key containing "acme" -> acme.com, "beta" -> beta.io,
// "nointro" -> 403 on introductions only, "empty" -> no introductions, otherwise mocktenant.com.
// Search terms: seeded | fresh | pending | failed | merck (two lookalikes)
import http from "node:http";

const PORT = Number(process.env.PORT || 8787);
const SEED_MS = Number(process.env.SEED_MS || 35_000);

const companies = {
  seeded: { companyId: "COMP-11111111-1111-1111-1111-111111111111", name: "Seeded Corp", accountId: "acc-seeded", verified: true },
  fresh: { companyId: "COMP-22222222-2222-2222-2222-222222222222", name: "Fresh Labs", accountId: null, verified: false },
  pending: { companyId: "COMP-33333333-3333-3333-3333-333333333333", name: "Pending Inc", accountId: "acc-pending", verified: true },
  failed: { companyId: "COMP-44444444-4444-4444-4444-444444444444", name: "Failed LLC", accountId: "acc-failed", verified: false },
  merck: { companyId: "COMP-55555555-5555-5555-5555-555555555555", name: "Merck & Co.", accountId: "acc-merck", verified: true },
  merckkgaa: { companyId: "COMP-66666666-6666-6666-6666-666666666666", name: "Merck KGaA", accountId: null, verified: true },
  mcdmaringa: { companyId: "COMP-77777777-7777-7777-7777-777777777771", name: "Mc Donalds Maringa", accountId: null, verified: true },
  mcdsc: { companyId: "COMP-77777777-7777-7777-7777-777777777772", name: "Mc Donalds SC", accountId: null, verified: false },
  mcdcorp: { companyId: "COMP-abc584e4-e88f-4c21-be4a-ac45ed196549", name: "McDonald's", accountId: "acc-mcd", verified: true },
};
const state = {
  seeded: { status: "completed", at: 0 },
  fresh: { status: "none", at: 0 },
  pending: { status: "pending", at: null }, // clock starts on first request
  failed: { status: "failed", at: 0 },
  merck: { status: "not_started", at: 0 },
  merckkgaa: { status: "none", at: 0 },
  mcdmaringa: { status: "none", at: 0 },
  mcdsc: { status: "none", at: 0 },
  mcdcorp: { status: "completed", at: 0 },
};

const pods = ["Security", "IT Leadership", "Engineering", "Finance", "Procurement"];
const FIRST = ["Ava", "Ben", "Chloe", "Dev", "Elena", "Farid", "Grace", "Hugo", "Iris", "Jonas", "Kira", "Liam"];
const LAST = ["Nguyen", "Patel", "Okafor", "Silva", "Kim", "Rossi", "Weber", "Haddad"];
const people = (slug, company) =>
  Array.from({ length: 23 }, (_, i) => ({
    personId: `PERS-${slug}-${i}`,
    company: i === 7 ? "Some Other Company" : company,
    name: i === 5 ? "Jane Doe" : i === 12 ? "Jane Doe, PhD" : `${FIRST[i % 12]} ${LAST[i % 8]}`,
    title: i === 3 ? "Founder & CEO" : i === 9 ? "Available" : i === 15 ? "Director of Security at Acme Widgets" : `VP ${pods[i % 5]}`,
    linkedInUrl: `https://www.linkedin.com/in/${slug}-${i}`,
    vieuUrl: `https://www.vieu.com/home#pt=person&pid=PERS-${slug}-${i}`,
    location: i % 3 ? "New York, NY" : "London, UK",
    swimlane: i < 9 ? pods[0] : pods[(i % 4) + 1],
  }));

// Synthetic companies for scale tests: coN.test (N = 1..5000), 20s seeds, 6 people each.
const BULK_SEED_MS = Number(process.env.BULK_SEED_MS || 20_000);
function ensureBulk(term) {
  const m = term.match(/^co(\d{1,4})\.test$/);
  if (!m) return null;
  const slug = `co${m[1]}`;
  if (!companies[slug]) {
    const hex = m[1].padStart(12, "0");
    companies[slug] = { companyId: `COMP-00000000-0000-0000-0000-${hex}`, name: `Company ${m[1]}`, accountId: Number(m[1]) % 3 ? `acc-${slug}` : null, verified: true, bulk: true };
    state[slug] = { status: companies[slug].accountId ? "not_started" : "none", at: 0 };
  }
  return slug;
}
const stats = { maxPending: 0, perMinute: new Map(), maxPerMinute: 0 };
function pendingNow() {
  return Object.entries(state).filter(([slug, st]) => st.status === "pending" && companies[slug]?.bulk).length;
}

function view(slug) {
  const c = companies[slug];
  const s = state[slug];
  if (s.at === null) s.at = Date.now();
  if (s.status === "pending" && Date.now() - s.at > (c.bulk ? BULK_SEED_MS : SEED_MS)) s.status = "completed";
  const generated = s.status === "completed";
  return {
    accountId: c.accountId, companyId: c.companyId, generated,
    seedingStatus: s.status === "none" ? "not_started" : s.status,
    ...(generated ? {} : { message: "Power pods have not been generated for this account" }),
    // McDonald's has no one in Procurement, to exercise empty pods.
    stakeholders: !generated
      ? []
      : c.bulk
        ? people(slug, c.name).slice(0, 6).map((p, i) => ({ ...p, seniority: i % 2 ? "VP" : "Director" }))
        : people(slug, c.name).filter((p) => !(slug === "mcdcorp" && p.swimlane === "Procurement")),
  };
}

const find = (q) => {
  for (const [slug, c] of Object.entries(companies)) {
    if (q.get("companyId") === c.companyId || (c.accountId && q.get("accountId") === c.accountId)) return slug;
  }
  return null;
};

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

let rateLimitOnce = true;

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === "/__stats") {
      return send(res, 200, { maxPendingSeeds: stats.maxPending, pendingNow: pendingNow(), maxRequestsPerMinute: stats.maxPerMinute });
    }
    const minute = Math.floor(Date.now() / 60_000);
    stats.perMinute.set(minute, (stats.perMinute.get(minute) ?? 0) + 1);
    stats.maxPerMinute = Math.max(stats.maxPerMinute, stats.perMinute.get(minute));
    const key = req.headers["x-api-key"];
    if (!url.search.includes("co")) console.log(req.method, url.pathname, url.search); // never logs the key
    if (!key) return send(res, 401, { message: "Missing token", reason: "TOKEN_MISSING" });
    if (key === "bad") return send(res, 401, { message: "Invalid Auth Token Provided", reason: "TOKEN_EXPIRED" });
    if (key === "noscope") return send(res, 403, { code: "ERR_FORBIDDEN", message: "Insufficient permissions", reason: "SCOPE_INSUFFICIENT" });
    const p = url.pathname.replace(/^\/api\/v2/, "");
    const q = url.searchParams;

    if (p === "/introductions") {
      if (key.includes("nointro")) return send(res, 403, { code: "ERR_FORBIDDEN", message: "Insufficient permissions", reason: "SCOPE_INSUFFICIENT" });
      const domain = key.includes("acme") ? "acme.com" : key.includes("beta") ? "beta.io" : "mocktenant.com";
      const introductions = key.includes("empty")
        ? []
        : [1, 2, 3].map((i) => ({ introductionId: `intro-${i}`, pointOfContact: i === 3 ? null : { name: "Alex", email: `alex${i}@${domain}` } }));
      return send(res, 200, { introductions, page: 0, pageSize: 50, totalCount: introductions.length });
    }

    if (p === "/accounts/search") {
      const term = (q.get("query") || q.get("webDomain") || "").toLowerCase();
      if (term.includes("ratelimit") && rateLimitOnce) {
        rateLimitOnce = false;
        return send(res, 429, { message: "Too many requests" }, { "retry-after": "2" });
      }
      const bulk = ensureBulk(term);
      if (bulk) {
        const c = companies[bulk];
        return send(res, 200, { companies: [{ ...c, linkedInUrl: null, imageUrl: null, hasAccountPlan: !!c.accountId }] });
      }
      const li = (q.get("linkedInUrl") || "").toLowerCase();
      const slugs = li
        ? li.includes("mcdonald's-corporation") ? ["mcdcorp"] : Object.keys(companies).filter((s) => li.endsWith(`/${s}`))
        : term.replace(/\s+/g, "").includes("mcdonald")
          ? ["mcdmaringa", "mcdsc"]
          : term.includes("merck") ? ["merck", "merckkgaa"] : Object.keys(companies).filter((s) => term.includes(s));
      return send(res, 200, {
        companies: slugs.map((s) => ({
          ...companies[s], linkedInUrl: `https://www.linkedin.com/company/${s}`, imageUrl: null,
          hasAccountPlan: !!companies[s].accountId,
        })),
      });
    }
    const slug = find(q);
    if (p === "/accounts/profile") {
      if (!slug) return send(res, 404, { message: "Not found" });
      const extra = {
        mcdcorp: { domain: "https://corporate.mcdonalds.com/", industry: "Restaurants", employeeCount: 313383, headquarters: "US" },
        mcdmaringa: { domain: "http://mcdonaldsmaringa.com.br", industry: "Restaurants", employeeCount: 42, headquarters: "BR" },
        mcdsc: { industry: "Food and Beverage", employeeCount: 8, headquarters: "BR" },
      }[slug] ?? { domain: `${slug}.com`, industry: "Software", employeeCount: 1200, headquarters: "Boston, MA" };
      return send(res, 200, { profile: { companyId: companies[slug].companyId, name: companies[slug].name, ...extra } });
    }
    if (p === "/accounts/stakeholders" && req.method === "GET") {
      if (!slug || state[slug].status === "none") return send(res, 404, { message: "Account not found" });
      return send(res, 200, view(slug));
    }
    if (p === "/accounts/stakeholders/generate" && req.method === "POST") {
      if (!slug) return send(res, 404, { message: "Account not found" });
      const c = companies[slug];
      let created = false;
      if (!c.accountId) { c.accountId = `acc-${slug}`; created = true; }
      if (["none", "not_started", "failed"].includes(state[slug].status)) state[slug] = { status: "pending", at: Date.now() };
      stats.maxPending = Math.max(stats.maxPending, pendingNow());
      return send(res, 200, { accountId: c.accountId, companyId: c.companyId, status: "accepted", message: "Generation accepted", ...(created ? { created } : {}) });
    }
    send(res, 404, { message: "No route" });
  })
  .listen(PORT, () => console.log(`mock Vieu API on http://localhost:${PORT}/api/v2 (seed takes ${SEED_MS / 1000}s)`));
