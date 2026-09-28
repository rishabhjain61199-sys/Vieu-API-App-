import { NextRequest } from "next/server";
import { proxy } from "../../../_lib/proxy";

export function POST(req: NextRequest) {
  return proxy(req, { path: "/accounts/stakeholders/generate", method: "POST", oneOf: ["accountId", "companyId"] });
}
