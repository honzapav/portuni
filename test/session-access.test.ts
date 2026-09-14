// Unit tests for auth/session-access.ts's sessionAccess table (spec:
// docs/superpowers/specs/2026-09-12-remote-hosts-and-task-queue-design.md,
// "Visibility and control"), row by row, against makeSharedDb fixtures.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ulid } from "ulid";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { sessionAccess, SessionAccessError } from "../apps/server/auth/session-access.js";
import { createSession } from "../apps/server/domain/sessions.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";
import { makeSharedDb, type SharedDb } from "./helpers/shared-db.js";
import { insertIgnore } from "../apps/server/infra/sql.js";

const OWNER = "U1";
const OTHER = "U2";

afterEach(() => {
  setDbForTesting(null);
});

function identity(userId: string, globalScope: RequestIdentity["globalScope"] = "write"): RequestIdentity {
  return {
    userId,
    email: `${userId.toLowerCase()}@x.com`,
    name: userId,
    globalScope,
    groups: [],
    groupIds: [],
    via: "env",
  };
}

async function shared(): Promise<SharedDb> {
  const s = await makeSharedDb();
  await s.db.execute({
    sql: insertIgnore(s.db.dialect, "INSERT OR IGNORE INTO users (id, email, name) VALUES (?, ?, ?)"),
    args: [OTHER, "u2@x.com", "U2"],
  });
  setDbForTesting(s.db);
  return s;
}

async function makeHiddenNode(s: SharedDb): Promise<string> {
  const hiddenId = ulid();
  await s.db.execute({
    sql: "INSERT INTO nodes (id, type, name, sync_key, created_by, visibility) VALUES (?, 'project', 'Hidden', 'hidden', ?, 'group')",
    args: [hiddenId, OWNER],
  });
  await s.db.execute({
    sql: "INSERT INTO node_access (node_id, kind, principal, display_email, added_by) VALUES (?, 'user', ?, NULL, ?)",
    args: [hiddenId, OWNER, OWNER],
  });
  return hiddenId;
}

async function expectError(promise: Promise<unknown>, code: "SESSION_NOT_FOUND" | "SESSION_FORBIDDEN") {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof SessionAccessError);
    assert.equal(err.code, code);
    return true;
  });
}

describe("sessionAccess: read", () => {
  it("the owner may always read", async () => {
    const s = await shared();
    const session = await createSession(s.db, OWNER, { node_id: s.nodeId, session_type: "interactive_task" });
    const row = await sessionAccess(s.db, identity(OWNER), session.id, "read");
    assert.equal(row.id, session.id);
  });

  it("anyone who can see the anchor node may read", async () => {
    const s = await shared();
    const session = await createSession(s.db, OWNER, { node_id: s.nodeId, session_type: "interactive_task" });
    const row = await sessionAccess(s.db, identity(OTHER), session.id, "read");
    assert.equal(row.id, session.id);
  });

  it("a session anchored to a node the caller cannot see is SESSION_NOT_FOUND", async () => {
    const s = await shared();
    const hiddenNodeId = await makeHiddenNode(s);
    const session = await createSession(s.db, OWNER, { node_id: hiddenNodeId, session_type: "interactive_task" });
    await expectError(sessionAccess(s.db, identity(OTHER), session.id, "read"), "SESSION_NOT_FOUND");
  });

  it("an unknown session id is SESSION_NOT_FOUND", async () => {
    const s = await shared();
    await expectError(sessionAccess(s.db, identity(OWNER), ulid(), "read"), "SESSION_NOT_FOUND");
  });
});

describe("sessionAccess: message (send a message, answer a question, rename)", () => {
  it("the owner may message", async () => {
    const s = await shared();
    const session = await createSession(s.db, OWNER, { node_id: s.nodeId, session_type: "interactive_task" });
    const row = await sessionAccess(s.db, identity(OWNER), session.id, "message");
    assert.equal(row.id, session.id);
  });

  it("a non-owner on a visible node is SESSION_FORBIDDEN, not hidden", async () => {
    const s = await shared();
    const session = await createSession(s.db, OWNER, { node_id: s.nodeId, session_type: "interactive_task" });
    await expectError(sessionAccess(s.db, identity(OTHER), session.id, "message"), "SESSION_FORBIDDEN");
  });

  it("manage scope does not grant message -- owner-only, no escape hatch", async () => {
    const s = await shared();
    const session = await createSession(s.db, OWNER, { node_id: s.nodeId, session_type: "interactive_task" });
    await expectError(
      sessionAccess(s.db, identity(OTHER, "manage"), session.id, "message"),
      "SESSION_FORBIDDEN",
    );
  });

  it("a non-owner on a hidden node is SESSION_NOT_FOUND", async () => {
    const s = await shared();
    const hiddenNodeId = await makeHiddenNode(s);
    const session = await createSession(s.db, OWNER, { node_id: hiddenNodeId, session_type: "interactive_task" });
    await expectError(sessionAccess(s.db, identity(OTHER), session.id, "message"), "SESSION_NOT_FOUND");
  });
});

describe("sessionAccess: stop (interrupt, suspend, close)", () => {
  it("the owner may stop", async () => {
    const s = await shared();
    const session = await createSession(s.db, OWNER, { node_id: s.nodeId, session_type: "interactive_task" });
    const row = await sessionAccess(s.db, identity(OWNER), session.id, "stop");
    assert.equal(row.id, session.id);
  });

  it("a non-owner with manage scope on a visible node may stop", async () => {
    const s = await shared();
    const session = await createSession(s.db, OWNER, { node_id: s.nodeId, session_type: "interactive_task" });
    const row = await sessionAccess(s.db, identity(OTHER, "manage"), session.id, "stop");
    assert.equal(row.id, session.id);
  });

  it("a non-owner without manage scope on a visible node is SESSION_FORBIDDEN", async () => {
    const s = await shared();
    const session = await createSession(s.db, OWNER, { node_id: s.nodeId, session_type: "interactive_task" });
    await expectError(sessionAccess(s.db, identity(OTHER, "write"), session.id, "stop"), "SESSION_FORBIDDEN");
  });

  it("manage scope does not see past a hidden node -- SESSION_NOT_FOUND", async () => {
    const s = await shared();
    const hiddenNodeId = await makeHiddenNode(s);
    const session = await createSession(s.db, OWNER, { node_id: hiddenNodeId, session_type: "interactive_task" });
    await expectError(
      sessionAccess(s.db, identity(OTHER, "manage"), session.id, "stop"),
      "SESSION_NOT_FOUND",
    );
  });
});

describe("sessionAccess: resume", () => {
  it("the owner may resume", async () => {
    const s = await shared();
    const session = await createSession(s.db, OWNER, { node_id: s.nodeId, session_type: "interactive_task" });
    const row = await sessionAccess(s.db, identity(OWNER), session.id, "resume");
    assert.equal(row.id, session.id);
  });

  it("manage scope does not grant resume -- owner-only", async () => {
    const s = await shared();
    const session = await createSession(s.db, OWNER, { node_id: s.nodeId, session_type: "interactive_task" });
    await expectError(
      sessionAccess(s.db, identity(OTHER, "manage"), session.id, "resume"),
      "SESSION_FORBIDDEN",
    );
  });
});

describe("sessionAccess: node-less session (interactive_chat)", () => {
  it("is owner-only for every action, forbidden (not hidden) for everyone else", async () => {
    const s = await shared();
    const session = await createSession(s.db, OWNER, { node_id: null, session_type: "interactive_chat" });
    const row = await sessionAccess(s.db, identity(OWNER), session.id, "read");
    assert.equal(row.id, session.id);
    for (const action of ["read", "message", "stop", "resume"] as const) {
      await expectError(sessionAccess(s.db, identity(OTHER, "manage"), session.id, action), "SESSION_FORBIDDEN");
    }
  });
});
