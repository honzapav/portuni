// Agent-mode counterpart of domain/session-handoff.ts's
// suspendSessionServerSide: session-runtime.ts's suspend() falls back to
// this when the agent never calls portuni_session_suspend in time. The
// local version writes straight against the graph db (getSession,
// getSessionScope, suspendSession/writeHandoffAndSuspend) -- none of which
// exist in agent mode, so this goes through the SessionStore abstraction
// instead (rule 1: "one implementation" means the caller in session-
// runtime.ts never knows which one it got).
//
// Simplification accepted for phase 1 (a backstop path, not the common
// one -- the agent calling portuni_session_suspend itself is): the write
// set / read set sections of the handoff content are always empty (agent
// mode has no local session_scope tracking to read them from), and the
// handoff file is written to the mirror but not registered as a tracked
// file the way writeHandoffAndSuspend's local counterpart does -- the next
// sync run's untracked-file discovery picks it up instead of it appearing
// immediately in the Files tab.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256Buffer } from "../sync/hash.js";
import { getMirrorPath } from "../sync/mirror-registry.js";
import {
  buildRunSummaryContent,
  handoffRelativePath,
  type ServerHandoffReason,
  type SummaryEvent,
} from "../session-handoff.js";
import type { SessionRow } from "../../shared/types.js";
import type { SessionStore } from "./store.js";

export function createSuspendFallbackCentral(
  store: SessionStore,
): (sessionId: string, reason: ServerHandoffReason) => Promise<SessionRow | null> {
  return async function suspendFallbackCentral(sessionId, reason) {
    const session = await store.getSession(sessionId);
    if (session?.state !== "running") return session;

    // #378: the summary's events come through the same SessionStore
    // abstraction every other agent-mode call already goes through --
    // listEvents works identically to the local path, unlike session_scope
    // (still empty here; agent mode has no local session_scope table).
    const rows = await store.listEvents(sessionId);
    const events: SummaryEvent[] = rows.map((r) => ({ kind: r.kind, payload: JSON.parse(r.payload) as unknown }));
    const content = buildRunSummaryContent({
      nodeName: null,
      sessionName: session.name,
      reason,
      events,
      writeSet: [],
      readSet: [],
      lastActiveAt: session.last_active_at,
    });
    const handoffHash = sha256Buffer(Buffer.from(content, "utf8"));

    const mirrorRoot = session.node_id ? await getMirrorPath(session.user_id, session.node_id) : null;
    let handoffPath: string | null = null;
    if (mirrorRoot) {
      const relPath = handoffRelativePath(session.id);
      const absPath = join(mirrorRoot, relPath);
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, content, "utf8");
      handoffPath = relPath;
    }

    return store.patchSession(sessionId, {
      state: "suspended",
      waiting_since: null,
      handoff_path: handoffPath,
      handoff_hash: handoffHash,
    });
  };
}
