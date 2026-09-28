// Read-only live check against the Partner API. Never prints the key.
//   VIEU_API_KEY=... node scripts/smoke.mjs "merck.com"
// Prints the search matches, the stakeholders response shape (field names), and
// confirms an invalid key gets a 401. It never calls the generate endpoint.
const BASE = process.env.VIEU_API_BASE || "https://api.cloud.seeqe.com/api/v2";
const key = process.env.VIEU_API_KEY;
const input = process.argv[2] || "vieu.com";
if (!key) {
  console.error("Set VIEU_API_KEY first.");
  process.exit(1);
}

async function get(path, params, k = key) {
  const res = await fetch(`${BASE}${path}?${new URLSearchParams(params)}`, { headers: { "x-api-key": k } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const isDomain = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(input);
const search = await get("/accounts/search", isDomain ? { webDomain: input } : { query: input });
console.log(`search ${isDomain ? "webDomain" : "query"}=${input} ->`, search.status);
for (const c of search.body.companies ?? []) {
  console.log(`  ${c.name} | ${c.companyId} | accountId=${c.accountId} | plan=${c.hasAccountPlan} | verified=${c.verified}`);
}

const first = search.body.companies?.[0];
if (first) {
  const params = first.accountId ? { accountId: first.accountId } : { companyId: first.companyId };
  const [sh, profile] = await Promise.all([get("/accounts/stakeholders", params), get("/accounts/profile", { companyId: first.companyId })]);
  const { stakeholders = [], ...rest } = sh.body;
  console.log("stakeholders ->", sh.status, JSON.stringify(rest));
  console.log("  count:", stakeholders.length);
  if (stakeholders[0]) console.log("  stakeholder fields:", Object.keys(stakeholders[0]).join(", "));
  const pods = {};
  for (const s of stakeholders) pods[s.swimlane] = (pods[s.swimlane] ?? 0) + 1;
  if (stakeholders.length) console.log("  pods (swimlane):", pods);
  console.log("profile ->", profile.status, "fields:", Object.keys(profile.body.profile ?? profile.body).join(", "));
}

const bad = await get("/accounts/search", { query: "test" }, "invalid-key-for-smoke-test");
console.log("invalid key ->", bad.status, bad.body.reason ?? "");
