// GET /context?path=<abs-path> -- resolves a filesystem path to its
// owning Portuni node + depth-1 neighbors. Powers the SessionStart hook.

import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../infra/db.js";
import { SOLO_USER } from "../infra/schema.js";
import { resolveContext } from "../domain/queries/context.js";
import { respondError , respondJson} from "../http/middleware.js";

export async function handleContext(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const path = url.searchParams.get("path");
  if (!path) {
    respondJson(res, 400, { error: "path parameter required" });
    return;
  }
  try {
    const context = await resolveContext(getDb(), SOLO_USER, path);
    respondJson(res, 200, context);
  } catch (err) {
    respondError(res, `${req.method} ${url.pathname}`, err);
  }
}
