// Composition root for the local-mode stale-remote warning (#310). A local
// workspace can no longer register a remote or write routing rules, but a
// workspace that did so before this change still has the rows on disk --
// warn once at boot instead of silently pretending they were never there.
// Same shape as boot/session-sweep.ts: run once, log, never fatal.

import { getDb } from "../infra/db.js";
import { isLocalWorkspace } from "../infra/server-config.js";
import { listRemotes, listRules } from "../domain/sync/routing.js";

export async function warnIfLocalWorkspaceHasStaleRemotesOnBoot(): Promise<void> {
  if (!isLocalWorkspace()) return;
  try {
    const db = getDb();
    const [remotes, rules] = await Promise.all([listRemotes(db), listRules(db)]);
    if (remotes.length === 0 && rules.length === 0) return;
    console.warn(
      `[boot] local workspace has ${remotes.length} remote(s) and ${rules.length} routing rule(s) left over from before a local workspace stopped supporting a remote -- ignored, they cannot be reached from here anymore.`,
    );
  } catch (e) {
    console.error("[boot] local-mode remote check failed:", e);
  }
}
