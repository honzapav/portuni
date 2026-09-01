// REST tests for GET /overview (#196, "Přehled (overview tab)" of
// docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md).
// Same methodology as api-sessions.test.ts / api-access-requests.test.ts:
// routeApiRequest with a lightweight mock req/res and RequestIdentity
// objects constructed directly.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";
import { ulid } from "ulid";
import { createClient as createDbClient, type Client as DbClient } from "@libsql/client";
import { ensureSchemaOn } from "../apps/server/infra/schema.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { routeApiRequest } from "../apps/server/api/router.js";
import {
  createSession,
  setSessionScopeWritable,
  upsertSessionScopeRead,
} from "../apps/server/domain/sessions.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";
import type { OverviewPayload } from "../apps/server/shared/api-types.js";
import type { IncomingMessage, ServerResponse } from "node:http";

const SOLO = "01SOLO0000000000000000000";
const OTHER_USER = "01OTHR0000000000000000000";
const MANAGER_GROUP = "GID_MANAGERS";

function makeIdentity(
  userId: string,
  scope: RequestIdentity["globalScope"] = "read",
  groupIds: string[] = [],
): RequestIdentity {
  return {
    userId,
    email: `${userId.toLowerCase()}@x.com`,
    name: userId,
    globalScope: scope,
    groups: [],
    groupIds,
    via: "env",
  };
}

interface MockResponse {
  statusCode: number;
  body: string;
}

function makeMockReqRes(
  method: string,
  pathname: string,
): { req: IncomingMessage; res: ServerResponse; captured: MockResponse } {
  const captured: MockResponse = { statusCode: 0, body: "" };
  const req = new Readable({
    read() {
      this.push(null);
    },
  }) as unknown as IncomingMessage;
  req.method = method;
  req.url = pathname;
  req.headers = {};

  const res = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      captured.body += chunk.toString();
      cb();
    },
  }) as unknown as ServerResponse;
  (res as unknown as { writeHead: (code: number, hdrs?: Record<string, string>) => void }).writeHead =
    (code: number) => {
      captured.statusCode = code;
    };
  (res as unknown as { end: (data?: string) => void }).end = (data?: string) => {
    if (data) captured.body += data;
  };

  return { req, res, captured };
}

async function call(identity: RequestIdentity, path: string): Promise<MockResponse> {
  const { req, res, captured } = makeMockReqRes("GET", path);
  await routeApiRequest(req, res, new URL(`http://localhost${path}`), identity);
  return captured;
}

describe("GET /overview", () => {
  let db: DbClient;
  let workspace: string;
  let orgId: string;
  let visibleNodeId: string;
  let restrictedNodeId: string;

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "portuni-api-overview-"));
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();

    db = createDbClient({ url: ":memory:" });
    await ensureSchemaOn(db);
    setDbForTesting(db);

    // ensureSchemaOn already seeds SOLO_USER ("Solo User") -- only OTHER_USER
    // is new here.
    await db.execute({
      sql: "INSERT INTO users (id, email, name) VALUES (?, ?, ?)",
      args: [OTHER_USER, "other@x.com", "Other"],
    });

    orgId = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, 'organization', 'Org', 'org', ?)",
      args: [orgId, SOLO],
    });

    visibleNodeId = ulid();
    await db.execute({
      sql: `INSERT INTO nodes (id, type, name, health, sync_key, created_by)
            VALUES (?, 'project', 'Visible Project', 'off_track', 'proj-visible', ?)`,
      args: [visibleNodeId, SOLO],
    });
    await db.execute({
      sql: "INSERT INTO edges (id, source_id, target_id, relation, created_by) VALUES (?, ?, ?, 'belongs_to', ?)",
      args: [ulid(), visibleNodeId, orgId, SOLO],
    });

    // A group-restricted node: invisible to a plain read-scope caller with
    // no matching group, visible to a manager in MANAGER_GROUP.
    restrictedNodeId = ulid();
    await db.execute({
      sql: `INSERT INTO nodes (id, type, name, visibility, access_mode, health, sync_key, created_by)
            VALUES (?, 'project', 'Restricted Project', 'group', 'private', 'at_risk', 'proj-restricted', ?)`,
      args: [restrictedNodeId, SOLO],
    });
    await db.execute({
      sql: "INSERT INTO edges (id, source_id, target_id, relation, created_by) VALUES (?, ?, ?, 'belongs_to', ?)",
      args: [ulid(), restrictedNodeId, orgId, SOLO],
    });
    await db.execute({
      sql: `INSERT INTO node_access (node_id, kind, principal, display_email, added_by)
            VALUES (?, 'group', ?, ?, ?)`,
      args: [restrictedNodeId, MANAGER_GROUP, "managers@x.com", SOLO],
    });
  });

  after(async () => {
    resetLocalDbForTests();
    delete process.env.PORTUNI_WORKSPACE_ROOT;
    await rm(workspace, { recursive: true, force: true });
  });

  test("lists running and suspended sessions, excludes closed", async () => {
    const running = await createSession(db, SOLO, { node_id: visibleNodeId, session_type: "interactive_task" });
    const toClose = await createSession(db, SOLO, { node_id: visibleNodeId, session_type: "interactive_task" });
    await db.execute({ sql: "UPDATE sessions SET state = 'closed' WHERE id = ?", args: [toClose.id] });
    const suspended = await createSession(db, SOLO, { node_id: visibleNodeId, session_type: "interactive_task" });
    await db.execute({ sql: "UPDATE sessions SET state = 'suspended' WHERE id = ?", args: [suspended.id] });

    const res = await call(makeIdentity(SOLO, "admin"), "/overview");
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as OverviewPayload;
    const runningIds = body.sessions.running.map((s) => s.id);
    const suspendedIds = body.sessions.suspended.map((s) => s.id);
    assert.ok(runningIds.includes(running.id));
    assert.ok(suspendedIds.includes(suspended.id));
    assert.ok(!runningIds.includes(toClose.id) && !suspendedIds.includes(toClose.id));
    assert.equal(body.sessions.running.find((s) => s.id === running.id)?.node_name, "Visible Project");
  });

  test("an anchor-less (interactive_chat) session is visible only to its own owner", async () => {
    const chat = await createSession(db, OTHER_USER, { node_id: null, session_type: "interactive_chat" });

    const own = await call(makeIdentity(OTHER_USER, "admin"), "/overview");
    const ownBody = JSON.parse(own.body) as OverviewPayload;
    assert.ok(ownBody.sessions.running.some((s) => s.id === chat.id));

    const other = await call(makeIdentity(SOLO, "admin"), "/overview");
    const otherBody = JSON.parse(other.body) as OverviewPayload;
    assert.ok(!otherBody.sessions.running.some((s) => s.id === chat.id));
  });

  test("headless review queue lists disconnected jumps, excludes non-headless sessions", async () => {
    const headless = await createSession(db, SOLO, { node_id: visibleNodeId, session_type: "headless" });
    await upsertSessionScopeRead(db, headless.id, visibleNodeId, "disconnected", "found via search");
    const interactive = await createSession(db, SOLO, { node_id: visibleNodeId, session_type: "interactive_task" });
    await upsertSessionScopeRead(db, interactive.id, visibleNodeId, "disconnected", "found via search");

    const res = await call(makeIdentity(SOLO, "admin"), "/overview");
    const body = JSON.parse(res.body) as OverviewPayload;
    const sessionIds = body.sessions.disconnected_jumps.map((j) => j.session_id);
    assert.ok(sessionIds.includes(headless.id));
    assert.ok(!sessionIds.includes(interactive.id));
  });

  test("attention section surfaces at_risk/broken processes, needs_attention areas, and off_track/at_risk projects", async () => {
    const processId = ulid();
    await db.execute({
      sql: `INSERT INTO nodes (id, type, name, lifecycle_state, sync_key, created_by)
            VALUES (?, 'process', 'Broken Process', 'broken', 'proc-1', ?)`,
      args: [processId, SOLO],
    });
    await db.execute({
      sql: "INSERT INTO edges (id, source_id, target_id, relation, created_by) VALUES (?, ?, ?, 'belongs_to', ?)",
      args: [ulid(), processId, orgId, SOLO],
    });
    const areaId = ulid();
    await db.execute({
      sql: `INSERT INTO nodes (id, type, name, lifecycle_state, sync_key, created_by)
            VALUES (?, 'area', 'Needs Attention Area', 'needs_attention', 'area-1', ?)`,
      args: [areaId, SOLO],
    });
    await db.execute({
      sql: "INSERT INTO edges (id, source_id, target_id, relation, created_by) VALUES (?, ?, ?, 'belongs_to', ?)",
      args: [ulid(), areaId, orgId, SOLO],
    });
    const onTrackProjectId = ulid();
    await db.execute({
      sql: `INSERT INTO nodes (id, type, name, health, sync_key, created_by)
            VALUES (?, 'project', 'On Track Project', 'on_track', 'proj-ontrack', ?)`,
      args: [onTrackProjectId, SOLO],
    });
    await db.execute({
      sql: "INSERT INTO edges (id, source_id, target_id, relation, created_by) VALUES (?, ?, ?, 'belongs_to', ?)",
      args: [ulid(), onTrackProjectId, orgId, SOLO],
    });

    const res = await call(makeIdentity(SOLO, "admin"), "/overview");
    const body = JSON.parse(res.body) as OverviewPayload;
    const ids = body.attention.nodes.map((n) => n.id);
    assert.ok(ids.includes(processId));
    assert.ok(ids.includes(areaId));
    assert.ok(ids.includes(visibleNodeId), "off_track project from before() must appear");
    assert.ok(!ids.includes(onTrackProjectId));
  });

  test("sync issues surface stuck pending_file_ops (last_error set)", async () => {
    const fileId = ulid();
    await db.execute({
      sql: `INSERT INTO pending_file_ops (id, user_id, node_id, file_id, payload, attempts, last_error)
            VALUES (?, ?, ?, ?, '{}', 2, 'remote 500')`,
      args: [ulid(), SOLO, visibleNodeId, fileId],
    });

    const res = await call(makeIdentity(SOLO, "admin"), "/overview");
    const body = JSON.parse(res.body) as OverviewPayload;
    assert.ok(body.attention.sync_issues.some((s) => s.node_id === visibleNodeId && s.last_error === "remote 500"));
  });

  test("activity section lists recent active events and recent session writes", async () => {
    await db.execute({
      sql: `INSERT INTO events (id, node_id, type, content, created_by) VALUES (?, ?, 'note', 'Something happened', ?)`,
      args: [ulid(), visibleNodeId, SOLO],
    });
    const session = await createSession(db, SOLO, { node_id: visibleNodeId, session_type: "interactive_task" });
    await upsertSessionScopeRead(db, session.id, visibleNodeId, "seed", null);
    await setSessionScopeWritable(db, session.id, visibleNodeId);

    const res = await call(makeIdentity(SOLO, "admin"), "/overview");
    const body = JSON.parse(res.body) as OverviewPayload;
    assert.ok(body.activity.events.some((e) => e.node_id === visibleNodeId && e.content === "Something happened"));
    assert.ok(body.activity.session_writes.some((w) => w.session_id === session.id && w.node_id === visibleNodeId));
  });

  test("new_nodes lists recently created nodes with creator name", async () => {
    const res = await call(makeIdentity(SOLO, "admin"), "/overview");
    const body = JSON.parse(res.body) as OverviewPayload;
    const visible = body.new_nodes.find((n) => n.id === visibleNodeId);
    assert.ok(visible);
    assert.equal(visible!.created_by_name, "Solo User");
  });

  test("pending access requests appear for manage scope, empty for write scope", async () => {
    await db.execute({
      sql: "INSERT INTO access_requests (id, node_id, user_id, status) VALUES (?, ?, ?, 'pending')",
      args: [ulid(), visibleNodeId, OTHER_USER],
    });

    const manager = await call(makeIdentity(SOLO, "manage"), "/overview");
    const managerBody = JSON.parse(manager.body) as OverviewPayload;
    assert.ok(managerBody.attention.access_requests.some((r) => r.node_id === visibleNodeId));

    const writer = await call(makeIdentity(SOLO, "write"), "/overview");
    const writerBody = JSON.parse(writer.body) as OverviewPayload;
    assert.equal(writerBody.attention.access_requests.length, 0);
  });

  test("nodes restricted to a group are invisible to a caller outside that group, visible to a member", async () => {
    const outsider = await call(makeIdentity(OTHER_USER, "write"), "/overview");
    const outsiderBody = JSON.parse(outsider.body) as OverviewPayload;
    assert.ok(!outsiderBody.attention.nodes.some((n) => n.id === restrictedNodeId));
    assert.ok(!outsiderBody.new_nodes.some((n) => n.id === restrictedNodeId));

    const member = await call(makeIdentity(OTHER_USER, "write", [MANAGER_GROUP]), "/overview");
    const memberBody = JSON.parse(member.body) as OverviewPayload;
    assert.ok(memberBody.attention.nodes.some((n) => n.id === restrictedNodeId));
  });
});
