export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public reason?: string,
  ) {
    super(message);
  }
}

export function friendlyMessage(status: number, body?: { message?: string }): string {
  if (status === 401) return "Invalid or revoked key";
  if (status === 403) return "This key lacks the account:read-write scope";
  if (status === 404) return "Account not found in this tenant";
  if (status === 429) return "Rate limited. Wait a minute and try again";
  if (status >= 500) return "Vieu API error, try again";
  if (status === 400) return body?.message ? `Request rejected: ${body.message}` : "Request rejected";
  return `Unexpected response (${status})`;
}

export function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

export const isAbort = (e: unknown) => (e as Error)?.name === "AbortError";

export type CallOptions = {
  signal?: AbortSignal;
  /** Called before each 429 back-off with the wait in ms. */
  onRateLimit?: (waitMs: number) => void;
};

const MAX_RATE_LIMIT_RETRIES = 5;

/** One call to our proxy route (which makes exactly one upstream call). Retries 429s with back-off. */
export async function vieu<T>(
  key: string,
  method: "GET" | "POST",
  path: string,
  params: Record<string, string>,
  opts: CallOptions = {},
): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`/api${path}?${qs}`, {
        method,
        headers: { "x-vieu-key": key },
        cache: "no-store",
        signal: opts.signal,
      });
    } catch (e) {
      if (isAbort(e)) throw e;
      throw new ApiError(0, "Network error. Check your connection and try again");
    }

    if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const base = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt;
      const wait = Math.min(60_000, base) + Math.random() * 500;
      opts.onRateLimit?.(wait);
      await sleep(wait, opts.signal);
      continue;
    }

    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, friendlyMessage(res.status, body), body?.reason);
    return body as T;
  }
}

export function formatDuration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}
