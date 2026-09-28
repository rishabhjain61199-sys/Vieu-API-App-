import { NextRequest, NextResponse } from "next/server";

// Server-only. VIEU_API_BASE exists so the UI can be exercised against a local mock;
// in production it is unset and every call goes to the real Partner API.
const BASE = (process.env.VIEU_API_BASE || "https://api.cloud.seeqe.com/api/v2").replace(/\/$/, "");
const TIMEOUT_MS = 25_000;
const MAX_PARAM_LEN = 500;

type ProxyOptions = {
  path: string;
  method: "GET" | "POST";
  /** Query params the upstream route accepts. Exactly one must be provided. */
  oneOf: string[];
};

function json(status: number, body: unknown, extra: Record<string, string> = {}) {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store", ...extra },
  });
}

/** Removes any occurrence of the key from an upstream body before it reaches the browser. */
function scrub(text: string, key: string) {
  return key.length >= 6 ? text.split(key).join("[redacted]") : text;
}

/**
 * Forwards one request to the Vieu Partner API with the caller's key.
 * The key arrives in the `x-vieu-key` header (never the URL, so it can't land in
 * access logs) and is never logged, stored, or included in any response.
 */
export async function proxy(req: NextRequest, { path, method, oneOf }: ProxyOptions) {
  const key = req.headers.get("x-vieu-key")?.trim();
  if (!key) return json(401, { message: "No API key provided", reason: "TOKEN_MISSING" });

  const provided = oneOf.filter((p) => req.nextUrl.searchParams.get(p)?.trim());
  if (provided.length !== 1) {
    return json(400, { message: `Provide exactly one of: ${oneOf.join(", ")}` });
  }
  const param = provided[0];
  const value = req.nextUrl.searchParams.get(param)!.trim();
  if (value.length > MAX_PARAM_LEN) return json(400, { message: `${param} is too long` });

  const url = new URL(BASE + path);
  url.searchParams.set(param, value);

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method,
      headers: { "x-api-key": key, accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // Deliberately drop the error object: it can carry request details.
    return json(502, { message: "Could not reach the Vieu API" });
  }

  const raw = scrub(await upstream.text(), key);
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = { message: raw.slice(0, 300) };
  }

  const extra: Record<string, string> = {};
  const retryAfter = upstream.headers.get("retry-after");
  if (retryAfter) extra["retry-after"] = retryAfter;
  return json(upstream.status, body, extra);
}
