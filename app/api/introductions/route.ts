import { NextRequest } from "next/server";
import { proxy } from "../_lib/proxy";

// Vieu's introductions list takes ~50s to answer, so allow well over that.
export const maxDuration = 120;

// Used only to detect which tenant a key belongs to (point-of-contact email domains).
export function GET(req: NextRequest) {
  return proxy(req, { path: "/introductions", method: "GET", optional: ["page", "pageSize"], timeoutMs: 110_000 });
}
