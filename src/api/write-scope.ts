// GET /scope?cwd=<abs>&target=<abs> -- classifies a write target into the
// three tiers (current mirror / sibling mirror / outside PORTUNI_ROOT).
// Used by the optional portuni-guard PreToolUse hook so every harness gets
// a uniform decision surface.
//
// GET /sandbox-profile?cwd=<abs> -- resolves the mirror containing cwd and
// returns its Seatbelt disk-scope profile. Used by the `portuni run`
// wrapper to sandbox agents launched from a plain shell (outside the
// desktop app's pty_spawn path).

import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../infra/db.js";
import { SOLO_USER } from "../infra/schema.js";
import { listUserMirrors } from "../domain/sync/mirror-registry.js";
import { classifyWrite, resolvePortuniRoot } from "../domain/write-scope.js";
import {
  buildSeatbeltProfile,
  resolveSandboxScopeForCwd,
} from "../domain/sandbox-profile.js";
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

export async function handleSandboxProfileByCwd(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    respondJson(res, 400, { error: "cwd parameter required" });
    return;
  }
  try {
    const r = await resolveSandboxScopeForCwd(getDb(), SOLO_USER, cwd);
    if (!r) {
      respondJson(res, 409, {
        error: `cwd is not inside any registered mirror: ${cwd}`,
        code: "NO_MIRROR",
      });
      return;
    }
    respondJson(res, 200, {
      node_id: r.nodeId,
      profile: buildSeatbeltProfile(r.scope),
      portuni_root: r.scope.portuniRoot,
      home_mirror: r.scope.homeMirror,
      neighbor_mirrors: r.scope.neighborMirrors,
    });
  } catch (err) {
    respondError(res, `${req.method} ${url.pathname}`, err);
  }
}
