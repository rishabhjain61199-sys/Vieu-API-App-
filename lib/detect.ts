/** The identifiers `GET /accounts/search` accepts, in the order we trust them. */
export const SEARCH_PARAMS = ["accountId", "companyId", "linkedInUrl", "webDomain", "query"] as const;
export type SearchParam = (typeof SEARCH_PARAMS)[number];

export type Detected = { param: SearchParam; value: string; label: string };

export const PARAM_LABEL: Record<SearchParam, string> = {
  accountId: "account id",
  companyId: "company id",
  linkedInUrl: "LinkedIn URL",
  webDomain: "domain",
  query: "name",
};

const DOMAIN = /^(?:https?:\/\/)?(?:www\.)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(?:[/?#].*)?$/i;

export function detectInput(raw: string): Detected | null {
  const v = raw.trim().replace(/^["']|["']$/g, "").trim();
  if (!v) return null;
  if (/linkedin\.com\/company\//i.test(v)) {
    const url = /^https?:\/\//i.test(v) ? v : `https://${v}`;
    return { param: "linkedInUrl", value: url, label: PARAM_LABEL.linkedInUrl };
  }
  if (/^COMP-[0-9a-f-]{36}$/i.test(v)) return { param: "companyId", value: v, label: PARAM_LABEL.companyId };
  if (/^[0-9a-f]{24}$/i.test(v)) return { param: "accountId", value: v, label: PARAM_LABEL.accountId };
  const email = v.match(/^[^\s@]+@((?:[a-z0-9-]+\.)+[a-z]{2,})$/i);
  if (email) return { param: "webDomain", value: email[1].toLowerCase(), label: "email domain" };
  const domain = v.match(DOMAIN);
  if (domain && !/\s/.test(v)) return { param: "webDomain", value: domain[1].toLowerCase(), label: PARAM_LABEL.webDomain };
  return { param: "query", value: v, label: PARAM_LABEL.query };
}
