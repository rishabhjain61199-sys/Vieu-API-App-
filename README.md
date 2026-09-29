# Stakeholder Lookup (Vieu Partner API)

A small Next.js app. Paste a Vieu Partner API key (the key decides the tenant), find a company or upload a list, and get that tenant's stakeholders grouped by power pod. If they don't exist yet, it generates them and says whether each result was **already seeded** or **newly generated**.

## What it does

| Tab | What you get |
| --- | --- |
| **Lookup** | Search by name, domain, email, LinkedIn URL, company id or account id. Pick the right match (every match's seeding status is checked in parallel). Summary card, pods, data-quality flags, CSV export. |
| **Batch** | Upload a CSV or paste a list (up to 250). Columns such as `name`, `domain`, `website`, `linkedin_url`, `company_id`, `account_id` are detected automatically. Rows resolve and check in parallel (5 at a time). Rows matched by name only against several candidates are marked **Check match**. One confirmation generates for every eligible row, then they're all polled together. Exports: all stakeholders, plus a one-row-per-company summary. |
| **History** | Past lookups and batches, stored in this browser's IndexedDB and saved as soon as generation starts, so a closed tab can pick up where it left off. Reopen, re-export, **Run again**, or **Resume and re-check** anything still generating. Entries are tagged with the tenant and can be filtered by it. Saving can be turned off, and history can be cleared. The API key is never stored. |

## Large batches (up to 2,000 companies)

- **Pace:** every call in the tab goes through one limiter at 25/s (1,500/min), half the tenant's 3,000/min limit. A 429 pauses all calls until `Retry-After` passes.
- **Generation queue:** at most N seeds run at once (default 50, set in the Generate confirmation). The rest wait as "Queued to generate" and start as others finish. Each row's 12-minute watch starts when its own seed starts. The progress line shows running, queued and done, plus an estimate. **Stop queue** puts not-yet-started rows back.
- **Sleep:** if the laptop sleeps, running seeds keep going in Vieu and the queue pauses. On wake, rows are re-checked, and time asleep doesn't count toward the watch window. **Keep screen awake** (Wake Lock) stops the display sleeping while the tab is in front.
- **Table:** 100 rows per page, with filters, sorting, and select-all across every page.

## History storage

Always on, one History row per batch (however many companies) and one per looked-up company, updated on re-run. Batch companies are stored as separate IndexedDB records, and only changed rows are written (at most every 1.5s), so large batches don't stall the page. The app requests persistent storage, so the browser doesn't clear it under disk pressure. **Download backup / Restore backup** in History moves everything between browsers. Deleting asks first. Every field Vieu returns for a stakeholder is kept, and exports add any fields beyond the standard 12 columns at the end.

## Tenant detection

The Partner API has no "who am I" endpoint, so when a key is pasted the app calls `GET /introductions?pageSize=50` once. The most common point-of-contact email domain (users inside the key's tenant) becomes the tenant name, e.g. `vieu.com`. Several keys for the same tenant resolve to the same name. If the key lacks `introduction:read-write`, or the tenant has no introductions, the tenant shows as "unknown" and everything else still works. The same call rejects an invalid key right away. Re-running a History entry with a key for a different tenant asks for confirmation first. Two tenants at once means two browser tabs.

## Notifications

Opt in from the Generate confirmation (or the "Generating…" panel): a desktop notification and/or a chime when a lookup finishes or a whole batch finishes. The tab title and icon always show `(n) Generating` while seeds run, and `✓ Done` if you were away when they finished. Everything runs in the tab, so the tab must stay open. Generation itself keeps running in Vieu if the tab closes.

## Flow per company

1. `GET /accounts/search` (the most precise identifier wins: accountId > companyId > LinkedIn > domain > name). In a batch it falls back to the next identifier when one finds nothing.
2. `GET /accounts/stakeholders` with `accountId`, else `companyId`. A 404 by companyId with no account means **no account yet**.
3. `generated: true` gives **Already seeded**. `pending` joins polling without a POST. `not_started` shows **Generate** (with confirmation). `failed` offers retry.
4. `POST /accounts/stakeholders/generate`. A `created: true` response means **Account created now**.
5. Poll every 15s (never faster, per account) for up to 12 min. Completion gives **Newly generated** with the generation time. Timeout gives **Still generating**, with **Check again**.

`GET /accounts/profile` runs in parallel with step 2 to show domain, industry and HQ.

## Key handling

- The key is held in React state only: no localStorage, no cookies. Refreshing the tab clears it. **Clear key** stops all polling.
- The browser sends it to our API routes in an `x-vieu-key` header (never in a URL, so it can't land in access logs). The route forwards it upstream as `x-api-key`.
- Routes never log it, and scrub it from any upstream body before responding. Every API response is `Cache-Control: no-store`. HSTS is on. Vercel serves HTTPS only.
- Each route makes exactly one upstream call, and all polling runs in the browser, so no function runs long.

## Errors

401 → Invalid or revoked key (the app returns to key entry) · 403 → key lacks `account:read-write` · 404 → account not found in this tenant · 429 → "Rate limited, retrying", with back-off that honours `Retry-After` · 5xx → Vieu API error, try again.

## Data-quality flags (display only, nothing is removed)

- **Possible duplicate**: the same normalized name (accents, titles, credentials stripped) or the same LinkedIn profile appears more than once in the account.
- **Possibly off-target**: a title matching Owner, Founder, CEO, Angel Investor, Available, Open to work, Self-employed, Freelance, Retired, Student or Intern; a listed company that doesn't match the target; or a title like "… at Other Co".

## Run locally

```bash
npm install
npm run dev              # http://localhost:3000, live API
```

Read-only live check (prints field names, never the key, never generates):

```bash
VIEU_API_KEY=... npm run smoke -- merck.com
```

Try every branch without touching a real tenant:

```bash
npm run mock             # mock Partner API on :8787
VIEU_API_BASE=http://localhost:8787/api/v2 npm run dev
```

With the mock, the key `bad` returns 401 and `noscope` returns 403. Any other key works. Search terms: `seeded`, `fresh` (no account, so generate creates one), `pending`, `failed`, `merck` (two lookalikes), `ratelimit …` (one 429).

## Deploy (Vercel)

1. Push this repo to GitHub.
2. In Vercel: **Add New → Project**, import the repo. The framework is detected as Next.js, and there's nothing to configure.
3. Don't set `VIEU_API_KEY` or `VIEU_API_BASE` in Vercel. Users paste their own key.

## Layout

```
app/api/_lib/proxy.ts            single-call proxy, key handling, param allow-list
app/api/accounts/*/route.ts      search, stakeholders, stakeholders/generate, profile
app/api/introductions/route.ts   tenant detection only
app/page.tsx                     tabs + key state
components/Run.tsx               single lookup state machine + polling
components/Batch.tsx             batch import, parallel resolve/check/generate/poll, BatchView
components/History.tsx           saved runs
lib/stakeholders.ts              normalize, flags, pod grouping, CSV rows
lib/csv.ts / lib/detect.ts       CSV parse, column mapping, input detection
lib/history.ts                   IndexedDB store (results only)
lib/tenant.ts                    infer the key's tenant
lib/notify.ts                    desktop notification, chime, tab title/icon
scripts/mock-upstream.mjs        local mock of the Partner API
scripts/smoke.mjs                read-only live check
```
