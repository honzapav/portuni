// Composition root for the startup session-projection sweep (#208): shared
// by index.ts (standalone) and desktop.ts (sidecar) the same way
// mirror-watch.ts is, since both entry points can serve a sandbox profile
// (api/nodes.ts's handleNodeSandboxProfile, api/write-scope.ts's
// handleSandboxProfileByCwd for the `portuni run` wrapper) and therefore can
// both accumulate <portuniRoot>/.portuni-sessions/<nodeId>/<sessionId>/
// directories. A crashed process never runs the graceful session-end cleanup
// (transport.ts's onclose -> disposeSessionProjection), so this runs once at
// boot to remove whatever it left behind -- see
// domain/session-projection.ts's sweepStaleSessionProjections for the
// removal rule.
//
// Solo (env auth) only, matching mirror-watch.ts: local mirrors (and thus
// their sandbox projections) belong to a single local user in this mode;
// central/google mode has no local sandbox profile concept here.

import { getDb } from "../infra/db.js";
import { SOLO_USER } from "../infra/schema.js";
import { listUserMirrors } from "../domain/sync/mirror-registry.js";
import { resolvePortuniRoot } from "../domain/write-scope.js";
import { sweepStaleSessionProjections } from "../domain/session-projection.js";

export async function sweepStaleSessionProjectionsOnBoot(): Promise<void> {
  const mode = (process.env.PORTUNI_AUTH_MODE ?? "env") === "google" ? "google" : "env";
  if (mode !== "env") return;
  try {
    const mirrors = await listUserMirrors(SOLO_USER);
    const portuniRoot = resolvePortuniRoot({
      envValue: process.env.PORTUNI_ROOT ?? null,
      knownMirrors: mirrors.map((m) => m.local_path),
    });
    if (!portuniRoot) return;
    const { removed } = await sweepStaleSessionProjections(getDb(), portuniRoot, SOLO_USER);
    if (removed.length > 0) {
      console.log(`[boot] session projection sweep removed ${removed.length} stale dir(s)`);
    }
  } catch (e) {
    console.error("[boot] session projection sweep failed:", e);
  }
}
