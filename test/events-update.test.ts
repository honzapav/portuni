// In-place event edit: the domain function, the portuni_update_event MCP
// tool and PATCH /events/:id, which all share updateEventInternal.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ulid } from "ulid";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeSharedDb } from "./helpers/shared-db.js";
import { openTestDb } from "./helpers/db.js";
import type { DbClient } from "../apps/server/infra/db.js";
import { ensureSchemaOn } from "../apps/server/infra/schema.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { createMcpServer, buildDefaultEnvIdentity } from "../apps/server/mcp/server.js";
import { routeApiRequest } from "../apps/server/api/router.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";
import {
  EventNotFoundError,
  InvalidEventUpdateError,
  supersedeEventInternal,
  updateEventInternal,
} from "../apps/server/domain/events.js";

async function seedEvent(db: DbClient, nodeId: string): Promise<string> {
  const id = ulid();
  await db.execute({
    sql: `INSERT INTO events (id, node_id, type, content, meta, refs, task_ref, created_by, created_at, logged_at)
          VALUES (?, ?, 'note', 'original', '{"a":1}', '["R1"]', 'T-1', 'U1', '2026-01-10T09:00:00.000Z', '2026-01-10T09:00:00.000Z')`,
    args: [id, nodeId],
  });
  return id;
}

// SQLite hands back the stored ISO string; Postgres stores TIMESTAMPTZ and
// pg-row-normalize renders it as "YYYY-MM-DD HH:MM:SS" (UTC). Compare the
// instant, not the backend's text form.
function instant(ts: string): string {
  const hasZone = /(Z|[+-]\d\d:?\d\d)$/i.test(ts);
  return new Date(hasZone ? ts : `${ts.replace(" ", "T")}Z`).toISOString();
}

describe("updateEventInternal", () => {
  it("rewrites only the given fields and keeps id, node and logged_at", async () => {
    const { db, nodeId } = await makeSharedDb();
    const id = await seedEvent(db, nodeId);

    const r = await updateEventInternal(db, "U1", id, {
      content: "  shorter  ",
      meta: { file: "outputs/meeting.md" },
    });
    assert.equal(r.id, id);
    assert.equal(r.node_id, nodeId);
    assert.equal(r.content, "shorter");
    assert.deepEqual(r.meta, { file: "outputs/meeting.md" });
    assert.deepEqual(r.refs, ["R1"], "refs untouched");
    assert.equal(r.task_ref, "T-1", "task_ref untouched");
    assert.equal(r.type, "note");
    assert.equal(instant(r.created_at), "2026-01-10T09:00:00.000Z");
    assert.equal(instant(r.logged_at), "2026-01-10T09:00:00.000Z");
    assert.deepEqual(r.updated_fields, ["content", "meta"]);

    const count = await db.execute({ sql: "SELECT COUNT(*) AS n FROM events", args: [] });
    assert.equal(Number(count.rows[0].n), 1, "no new event row");
    const audit = await db.execute({
      sql: "SELECT action FROM audit_log WHERE target_id = ?",
      args: [id],
    });
    assert.deepEqual(
      audit.rows.map((row) => row.action),
      ["update_event"],
    );
  });

  it("clears meta, refs and task_ref with null and normalizes created_at", async () => {
    const { db, nodeId } = await makeSharedDb();
    const id = await seedEvent(db, nodeId);

    const r = await updateEventInternal(db, "U1", id, {
      meta: null,
      refs: null,
      taskRef: null,
      createdAt: "2025-12-24",
      type: "decision",
    });
    assert.equal(r.meta, null);
    assert.equal(r.refs, null);
    assert.equal(r.task_ref, null);
    assert.equal(instant(r.created_at), "2025-12-24T00:00:00.000Z");
    assert.equal(r.type, "decision");
  });

  it("brings a superseded event back to active", async () => {
    const { db, nodeId } = await makeSharedDb();
    const id = await seedEvent(db, nodeId);
    await supersedeEventInternal(db, "U1", { eventId: id, newContent: "by mistake" });

    const r = await updateEventInternal(db, "U1", id, { status: "active" });
    assert.equal(r.status, "active");
  });

  it("rejects invalid values and an empty update before writing", async () => {
    const { db, nodeId } = await makeSharedDb();
    const id = await seedEvent(db, nodeId);

    for (const [fields, field] of [
      [{ content: "   " }, "content"],
      [{ type: "issue" }, "type"],
      [{ status: "done" }, "status"],
      [{ createdAt: "not a date" }, "created_at"],
      [{}, "*"],
    ] as const) {
      await assert.rejects(
        () => updateEventInternal(db, "U1", id, fields),
        (e: unknown) => e instanceof InvalidEventUpdateError && e.field === field,
      );
    }
    const row = await db.execute({ sql: "SELECT content, status FROM events WHERE id = ?", args: [id] });
    assert.equal(row.rows[0].content, "original");
    assert.equal(row.rows[0].status, "active");
  });

  it("throws EventNotFoundError for an unknown id", async () => {
    const { db } = await makeSharedDb();
    await assert.rejects(
      () => updateEventInternal(db, "U1", "NOPE", { content: "x" }),
      EventNotFoundError,
    );
  });
});

describe("portuni_update_event and PATCH /events/:id", () => {
  let workspace: string;
  let db: DbClient;
  let mcpClient: Client;
  let nodeId: string;

  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await mcpClient.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text: string }>)[0].text;
    return { isError: result.isError === true, text };
  };

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "portuni-event-update-"));
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();
    db = await openTestDb();
    await ensureSchemaOn(db);
    setDbForTesting(db);

    const orgId = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
      args: [orgId, "organization", "Acme", "acme", "01SOLO0000000000000000000"],
    });

    const { server } = createMcpServer(buildDefaultEnvIdentity());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    mcpClient = new Client({ name: "event-update-test", version: "0.0.1" }, { capabilities: {} });
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const created = await call("portuni_create_node", {
      type: "project",
      name: "Event Update Project",
      organization_id: orgId,
    });
    assert.equal(created.isError, false, created.text);
    nodeId = JSON.parse(created.text).id;
  });

  after(async () => {
    await mcpClient.close();
    setDbForTesting(null);
    resetLocalDbForTests();
    await rm(workspace, { recursive: true, force: true });
  });

  it("edits the event in place over MCP", async () => {
    const logged = await call("portuni_log", {
      node_id: nodeId,
      type: "note",
      content: "a very long meeting transcript",
    });
    assert.equal(logged.isError, false, logged.text);
    const eventId = JSON.parse(logged.text).id;

    const updated = await call("portuni_update_event", {
      event_id: eventId,
      content: "Meeting held; notes in outputs/meeting.md",
      refs: ["outputs/meeting.md"],
    });
    assert.equal(updated.isError, false, updated.text);
    const body = JSON.parse(updated.text);
    assert.equal(body.id, eventId);
    assert.equal(body.content, "Meeting held; notes in outputs/meeting.md");
    assert.deepEqual(body.refs, ["outputs/meeting.md"]);

    const rows = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM events WHERE node_id = ?",
      args: [nodeId],
    });
    assert.equal(Number(rows.rows[0].n), 1, "no replacement event");
  });

  it("answers not-found for an unknown event and an error for an empty update", async () => {
    const missing = await call("portuni_update_event", { event_id: "NOPE", content: "x" });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /not found/);

    const logged = await call("portuni_log", { node_id: nodeId, type: "note", content: "x" });
    const eventId = JSON.parse(logged.text).id;
    const empty = await call("portuni_update_event", { event_id: eventId });
    assert.equal(empty.isError, true);
    assert.match(empty.text, /no fields to update/);
  });

  it("PATCH /events/:id takes meta, refs and task_ref", async () => {
    const logged = await call("portuni_log", { node_id: nodeId, type: "note", content: "rest" });
    const eventId = JSON.parse(logged.text).id;

    const admin: RequestIdentity = {
      userId: "01SOLO0000000000000000000",
      email: "admin@x.com",
      name: "Admin",
      globalScope: "admin",
      groups: [],
      groupIds: [],
      via: "env",
    };
    const patch = async (body: unknown) => {
      const captured = { statusCode: 0, body: "" };
      const raw = JSON.stringify(body);
      const req = new Readable({
        read() {
          this.push(Buffer.from(raw));
          this.push(null);
        },
      }) as unknown as IncomingMessage;
      req.method = "PATCH";
      req.url = `/events/${eventId}`;
      req.headers = { "content-type": "application/json" };
      const res = new Writable({
        write(chunk: Buffer, _enc: string, cb: () => void) {
          captured.body += chunk.toString();
          cb();
        },
      }) as unknown as ServerResponse;
      Object.assign(res, {
        writeHead: (code: number) => {
          captured.statusCode = code;
        },
        setHeader: () => {
          // headers are not asserted here
        },
        end: (data?: string) => {
          if (data) captured.body += data;
        },
      });
      await routeApiRequest(req, res, new URL(`http://localhost/events/${eventId}`), admin);
      return captured;
    };

    const ok = await patch({ meta: { source: "rest" }, refs: ["R9"], task_ref: "T-9" });
    assert.equal(ok.statusCode, 200, ok.body);
    const body = JSON.parse(ok.body);
    assert.deepEqual(body.meta, { source: "rest" });
    assert.deepEqual(body.refs, ["R9"]);
    assert.equal(body.task_ref, "T-9");

    const bad = await patch({ status: "done" });
    assert.equal(bad.statusCode, 400, bad.body);
    const badDate = await patch({ created_at: "nope" });
    assert.equal(badDate.statusCode, 400, badDate.body);
    assert.match(badDate.body, /INVALID_EVENT_DATE/);
  });
});
