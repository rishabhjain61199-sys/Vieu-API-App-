import { NextRequest } from "next/server";
import { proxy } from "../../_lib/proxy";

export function GET(req: NextRequest) {
  return proxy(req, { path: "/accounts/profile", method: "GET", oneOf: ["accountId", "companyId"] });
}
