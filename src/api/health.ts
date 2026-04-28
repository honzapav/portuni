// GET /health -- public liveness probe. No auth, no body.

import type { ServerResponse } from "node:http";

export function handleHealth(res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok" }));
}
