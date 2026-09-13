// Session access tiers (docs/superpowers/specs/2026-09-12-remote-hosts-and-
// task-queue-design.md, "Visibility and control" -- the table step-1's own
// API issue (#321) is told to follow instead of the terminal-era "a session
// is a personal work record" rule). Local mode has no host yet, so the
// table's "the host owner" column is vacuous here; it collapses to
// "the owner, or manage scope" for stop actions.
//
// | action    | who                                                    |
// |-----------|---------------------------------------------------------|
// | read      | anyone who can see the anchor node (nodeVisibleTo)       |
// | message   | the owner                                                |
// | stop      | the owner, or manage scope                               |
// | resume    | the owner                                                |
//
// A session with no anchor node (interactive_chat) is owner-only for every
// action -- there is no node to check visibility against, so a non-owner is
// SESSION_FORBIDDEN rather than hidden. A node-anchored session the caller
// cannot see at all is SESSION_NOT_FOUND for every action instead, manage
// scope included -- manage does not see past a node's own ACL.

import type { Client } from "@libsql/client";
import { getSession } from "../domain/sessions.js";
import { nodeVisibleTo } from "./node-access.js";
import { scopeAtLeast } from "./roles.js";
import type { RequestIdentity } from "./request-identity.js";
import type { SessionRow } from "../shared/types.js";

export type SessionAccessAction = "read" | "message" | "stop" | "resume";
export type SessionAccessErrorCode = "SESSION_NOT_FOUND" | "SESSION_FORBIDDEN";

export class SessionAccessError extends Error {
  readonly code: SessionAccessErrorCode;
  constructor(code: SessionAccessErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

// Returns the session row when `identity` may perform `action` on it, else
// throws SessionAccessError. Node visibility gates existence itself
// (SESSION_NOT_FOUND) -- same "non-members do not see it at all" rule
// auth/node-access.ts applies to the node -- while a visible session with
// an insufficient action tier is SESSION_FORBIDDEN: the caller already
// knows it exists (it shows up in the node's Relace tab), it just can't do
// this particular thing to it.
export async function sessionAccess(
  db: Client,
  identity: RequestIdentity,
  sessionId: string,
  action: SessionAccessAction,
): Promise<SessionRow> {
  const row = await getSession(db, sessionId);
  if (!row) throw new SessionAccessError("SESSION_NOT_FOUND", `session ${sessionId} not found`);

  if (row.user_id === identity.userId) return row;

  // interactive_chat (no anchor node): owner-only for every action, but
  // still FORBIDDEN rather than hidden -- unlike a node-anchored session,
  // there is no ACL to say whether a non-owner may even know it exists.
  if (row.node_id === null) {
    throw new SessionAccessError("SESSION_FORBIDDEN", "session has no anchor node; owner-only");
  }

  // A node-anchored session the caller cannot see at all is hidden
  // entirely -- same "non-members do not see it AT ALL" rule
  // auth/node-access.ts applies to the node itself.
  if (!(await nodeVisibleTo(db, identity, row.node_id))) {
    throw new SessionAccessError("SESSION_NOT_FOUND", `session ${sessionId} not found`);
  }

  if (action === "read") return row;

  if (action === "stop") {
    if (scopeAtLeast(identity.globalScope, "manage")) return row;
    throw new SessionAccessError("SESSION_FORBIDDEN", "stop requires ownership or manage scope");
  }

  // message / resume: owner-only, already returned above if identity owns it.
  throw new SessionAccessError("SESSION_FORBIDDEN", `${action} requires session ownership`);
}
