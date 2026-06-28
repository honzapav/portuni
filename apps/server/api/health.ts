// GET /health -- public liveness probe. No auth, no body.

import type { ServerResponse } from "node:http";
import { respondJson } from "../http/middleware.js";

export function handleHealth(res: ServerResponse): void {
  respondJson(res, 200, { status: "ok" });
}
