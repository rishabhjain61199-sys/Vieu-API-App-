import { detectInput, PARAM_LABEL, SEARCH_PARAMS, type SearchParam } from "./detect";

/** RFC 4180-ish parser: quoted fields, escaped quotes, CRLF, commas or tabs. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const delim = firstLine.includes("\t") && !firstLine.includes(",") ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delim) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some(Boolean));
}

const HEADER_MAP: Record<string, SearchParam> = {
  accountid: "accountId", vieuaccountid: "accountId",
  companyid: "companyId", vieucompanyid: "companyId", globalcompanyid: "companyId",
  linkedin: "linkedInUrl", linkedinurl: "linkedInUrl", companylinkedin: "linkedInUrl",
  companylinkedinurl: "linkedInUrl", linkedincompanyurl: "linkedInUrl", linkedinpage: "linkedInUrl",
  domain: "webDomain", website: "webDomain", webdomain: "webDomain", url: "webDomain", websiteurl: "webDomain",
  companydomain: "webDomain", companywebsite: "webDomain", emaildomain: "webDomain", email: "webDomain",
  name: "query", company: "query", companyname: "query", account: "query", accountname: "query",
  organization: "query", organisation: "query", org: "query",
};

export type BatchInput = { label: string; inputs: Partial<Record<SearchParam, string>> };

export const MAX_BATCH_ROWS = 250;

/**
 * Turns an uploaded CSV or a pasted list into search inputs. With a recognised
 * header, columns are mapped by name. Without one, every cell is sniffed
 * (domain, LinkedIn URL, id, email, else name).
 */
export function toBatchInputs(text: string): { items: BatchInput[]; mapped: string[]; truncated: boolean } {
  const rows = parseCsv(text);
  if (!rows.length) return { items: [], mapped: [], truncated: false };

  const headerKeys = rows[0].map((h) => HEADER_MAP[h.toLowerCase().replace(/[^a-z]/g, "")]);
  const hasHeader = headerKeys.filter(Boolean).length > 0;
  const body = hasHeader ? rows.slice(1) : rows;
  const mapped = hasHeader
    ? rows[0].flatMap((h, i) => (headerKeys[i] ? [`${h} → ${PARAM_LABEL[headerKeys[i]]}`] : []))
    : [];

  const seen = new Set<string>();
  const items: BatchInput[] = [];
  for (const r of body) {
    const inputs: Partial<Record<SearchParam, string>> = {};
    const names: string[] = [];
    r.forEach((cell, i) => {
      if (!cell) return;
      if (hasHeader) {
        const k = headerKeys[i];
        if (!k) return;
        if (k === "query") names.push(cell);
        else {
          const d = detectInput(cell);
          // Keep the column's meaning, but normalise the value (e.g. strip https://www.).
          inputs[k] = d && d.param === k ? d.value : cell;
        }
      } else {
        const d = detectInput(cell);
        if (!d) return;
        if (d.param === "query") names.push(cell);
        else inputs[d.param] ??= d.value;
      }
    });
    if (names.length) inputs.query = names.join(", ");
    const primary = SEARCH_PARAMS.find((p) => inputs[p]);
    if (!primary) continue;
    const dedupe = `${primary}:${inputs[primary]!.toLowerCase()}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    items.push({ label: inputs.query || inputs[primary]!, inputs });
  }
  return { items: items.slice(0, MAX_BATCH_ROWS), mapped, truncated: items.length > MAX_BATCH_ROWS };
}

export function csvCell(v: unknown) {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: unknown[][]) {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}

export function downloadFile(filename: string, text: string, type = "text/csv;charset=utf-8") {
  const blob = new Blob([type.startsWith("text/csv") ? "﻿" + text : text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function slugify(s: string) {
  return s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "") || "company";
}

export const TEMPLATE_CSV = "name,domain,linkedin_url,company_id\nMerck & Co.,merck.com,,\nStripe,,https://www.linkedin.com/company/stripe,\n";
