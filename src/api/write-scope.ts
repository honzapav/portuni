// GET /scope?cwd=<abs>&target=<abs> -- classifies a write target into the
// three tiers (current mirror / sibling mirror / outside PORTUNI_ROOT).
// Used by the optional portuni-guard PreToolUse hook so every harness gets
// a uniform decision surface.

import type { IncomingMessage, ServerResponse } from "node:http";
import { SOLO_USER } from "../infra/schema.js";
import { listUserMirrors } from "../domain/sync/mirror-registry.js";
import { classifyWrite, resolvePortuniRoot } from "../domain/write-scope.js";
import { respondError , respondJson} from "../http/middleware.js";

export async function handleWriteScope(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const cwd = url.searchParams.get("cwd");
  const target = url.searchParams.get("target");
  if (!cwd || !target) {
    respondJson(res, 400, { error: "cwd and target parameters required" });
    return;
  }
  try {
    const mirrors = (await listUserMirrors(SOLO_USER)).map((m) => m.local_path);
    const portuniRoot = resolvePortuniRoot({
      envValue: process.env.PORTUNI_ROOT ?? null,
      knownMirrors: mirrors,
    });
    if (!portuniRoot) {
      respondJson(res, 200, {
        decision: "allow",
        reason: "no PORTUNI_ROOT and no mirrors registered — scope not enforceable",
        tier: null,
        portuni_root: null,
      });
      return;
    }
    const cls = classifyWrite({ cwd, target, portuniRoot, mirrors });
    const decision = cls.tier === "tier1_current" ? "allow" : "deny";
    respondJson(res, 200, { decision, ...cls });
  } catch (err) {
    respondError(res, `${req.method} ${url.pathname}`, err);
  }
}
