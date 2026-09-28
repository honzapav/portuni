// Session access (docs/superpowers/specs/2026-09-22-local-sessions-design.md,
// "Access"). The table is one line:
//
// | action                          | who       |
// |---------------------------------|-----------|
// | read, message, stop, resume     | the owner |
//
// A thread is its owner's. Nobody else reads the record: not a teammate who
// can see the anchor node, not `manage`, not `admin`. Seeing the node says
// nothing about its threads any more, so a non-owner gets SESSION_NOT_FOUND
// for every action on every session -- node-anchored or not: a caller who
// is not the owner is never told the thread exists.
//
// This supersedes the "Visibility and control" table of
// docs/superpowers/specs/2026-09-12-remote-hosts-and-task-queue-design.md,
// where read followed the node's ACL and stop admitted manage scope.

import type { DbClient } from "../infra/db.js";
import { getSession } from "../domain/sessions.js";
import type { RequestIdentity } from "./request-identity.js";
import type { SessionRow } from "../shared/types.js";

export type SessionAccessAction = "read" | "message" | "stop" | "resume";
export type SessionAccessErrorCode = "SESSION_NOT_FOUND";

export class SessionAccessError extends Error {
  readonly code: SessionAccessErrorCode;
  constructor(code: SessionAccessErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

// Returns the session row when `identity` owns it, else throws
// SessionAccessError("SESSION_NOT_FOUND") -- the same "non-members do not
// see it at all" posture auth/node-access.ts applies to a node, with the
// owner as the only member. `action` is kept in the signature because every
// call site names what it is about to do and the audit log records it.
export async function sessionAccess(
  db: DbClient,
  identity: RequestIdentity,
  sessionId: string,
  _action: SessionAccessAction,
): Promise<SessionRow> {
  const row = await getSession(db, sessionId);
  if (!row) throw new SessionAccessError("SESSION_NOT_FOUND", `session ${sessionId} not found`);
  if (row.user_id !== identity.userId) {
    throw new SessionAccessError("SESSION_NOT_FOUND", `session ${sessionId} not found`);
  }
  return row;
}
