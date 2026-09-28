import { NextRequest } from "next/server";
import { proxy } from "../_lib/proxy";

// Used only to detect which tenant a key belongs to (point-of-contact email domains).
export function GET(req: NextRequest) {
  return proxy(req, { path: "/introductions", method: "GET", optional: ["page", "pageSize"] });
}
