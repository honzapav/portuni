// Agent-mode counterpart of domain/session-handoff.ts's
// suspendSessionServerSide: session-runtime.ts's suspend() falls back to
// this when the run ends without the thread having been closed. The local
// version writes straight against the graph db (getSession,
// getSessionScope, suspendSession/writeHandoffAndSuspend) -- none of which
// exist in a team-workspace sidecar, so the record half goes through the
// SessionStore abstraction instead (rule 1: "one implementation" means the
// caller in session-runtime.ts never knows which one it got) and the two
// graph-db reads the summary needs (the node's name, the session's scope)
// come over CentralClient.
//
// #427 closed the two simplifications phase 1 accepted here: the summary's
// write/read-set sections are filled from GET /sessions/:id/scope rather
// than left empty, and the handoff file is registered as a tracked file of
// the node right away (registerLocalFileCentral, the same record-only
// registration the watcher uses) instead of waiting for the next sync run's
// untracked-file discovery to notice it.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256Buffer } from "../sync/hash.js";
import { getMirrorPath } from "../sync/mirror-registry.js";
import { registerLocalFileCentral } from "../sync/central/engine-central.js";
import {
  buildRunSummaryContent,
  handoffRelativePath,
  type ServerHandoffReason,
  type SummaryEvent,
} from "../session-handoff.js";
import type { CentralClient } from "../sync/central/client.js";
import type { SessionScopeRecord } from "../../shared/api-types.js";
import type { SessionRow } from "../../shared/types.js";
import type { SessionStore } from "./store.js";
import type { SessionContentStore } from "./store-content.js";

const EMPTY_SCOPE: Omit<SessionScopeRecord, "session_id"> = {
  node_name: null,
  write_set: [],
  read_set: [],
};

export function createSuspendFallbackCentral(
  store: SessionStore,
  content: SessionContentStore,
  client: CentralClient,
): (sessionId: string, reason: ServerHandoffReason) => Promise<SessionRow | null> {
  return async function suspendFallbackCentral(sessionId, reason) {
    const session = await store.getSession(sessionId);
    if (session?.state !== "running") return session;

    // #456: the transcript is this device's, in content.db -- the same
    // store the local path reads, so the summary is built from the very
    // same rows in both workspaces.
    const rows = await content.listEvents(sessionId);
    const events: SummaryEvent[] = rows.map((r) => ({ kind: r.kind, payload: JSON.parse(r.payload) as unknown }));
    // A scope read that fails must not cost the session its suspend: the
    // summary is still worth writing without its scope sections, and the
    // alternative is a thread left 'running' with no handoff at all. Same
    // posture the local path's own callers take (session-runtime.ts reads
    // session_scope with .catch(() => [])).
    const scope = await client.sessionScopeRecord(sessionId).catch((err) => {
      console.error(`[portuni:suspend-fallback] scope read failed for session ${sessionId}:`, err);
      return EMPTY_SCOPE;
    });
    const summary = buildRunSummaryContent({
      nodeName: scope.node_name,
      sessionName: session.name,
      reason,
      events,
      writeSet: scope.write_set,
      readSet: scope.read_set,
      lastActiveAt: session.last_active_at,
    });
    const handoffHash = sha256Buffer(Buffer.from(summary, "utf8"));

    const mirrorRoot = session.node_id ? await getMirrorPath(session.user_id, session.node_id) : null;
    let handoffPath: string | null = null;
    if (mirrorRoot && session.node_id) {
      const relPath = handoffRelativePath(session.id);
      const absPath = join(mirrorRoot, relPath);
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, summary, "utf8");
      handoffPath = relPath;

      // Record-only registration, exactly what the watcher does for a file
      // that appeared in the mirror: the handoff shows up under Files at
      // once, and the push is a later deliberate sync run. Best-effort for
      // the same reason writeHandoffAndSuspend's own registration is --
      // the file is on disk and the session IS suspended; a central that
      // refused the record must not undo either.
      try {
        await registerLocalFileCentral(client, {
          userId: session.user_id,
          nodeId: session.node_id,
          localPath: absPath,
        });
      } catch (err) {
        console.error(
          `[portuni:suspend-fallback] registering ${absPath} failed; the session is suspended and the handoff is written locally, but not yet tracked:`,
          err,
        );
      }
    }

    // #434: without a mirror there is no file to point at, so the summary
    // itself rides along in the content store's handoff_inline, which
    // getResumeInfo falls back to when handoff_path is null. It is content,
    // so it stays on the device (#456) -- only the path and the hash go to
    // the record.
    await content.setContent(sessionId, { handoff_inline: handoffPath ? null : summary });
    return store.patchSession(sessionId, {
      state: "suspended",
      waiting_since: null,
      handoff_path: handoffPath,
      handoff_hash: handoffHash,
    });
  };
}
