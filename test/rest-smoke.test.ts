// Smoke test for the HTTP REST surface. Boots a real http server on a
// loopback port, talks to it over fetch, asserts the wire-level contract
// for /health, /graph, and /nodes (create + read + archive).
//
// Also serves as the regression test for the org-invariant fix in
// handleCreateNode: a non-organization node created via REST must come
// out with a belongs_to edge to the named organization, and a request
// without organization_id must be rejected with 400.

// Pre-wire the server port BEFORE importing anything from src/. The
// middleware reads process.env.PORT at module load to compute
// ALLOWED_HOSTS, so this has to be set first.
process.env.PORT = "14910";
process.env.HOST = "127.0.0.1";
process.env.PORTUNI_AUTH_TOKEN = "";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient } from "@libsql/client";
import { ulid } from "ulid";
import { ensureSchemaOn } from "../src/infra/schema.js";
import { setDbForTesting } from "../src/infra/db.js";
import { resetGateCachesForTesting } from "../src/http/middleware.js";
import { resetLocalDbForTests } from "../src/domain/sync/local-db.js";
import { startHttpServer, type HttpServerHandle } from "../src/http/server.js";

const BASE = "http://127.0.0.1:14910";

let handle: HttpServerHandle;
let orgId: string;
let workspace: string;

before(async () => {
  resetGateCachesForTesting();
  workspace = await mkdtemp(join(tmpdir(), "portuni-rest-smoke-"));
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
  const db = createClient({ url: ":memory:" });
  await ensureSchemaOn(db);
  setDbForTesting(db);

  // Seed one organization so we have something to attach non-org nodes to.
  orgId = ulid();
  await db.execute({
    sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
    args: [orgId, "organization", "Acme", "acme", "01SOLO0000000000000000000"],
  });

  handle = startHttpServer({
    port: 14910,
    host: "127.0.0.1",
    registerSigint: false,
  });
  // Give the listener a tick to bind.
  await new Promise((r) => setImmediate(r));
});

after(async () => {
  await handle.shutdown();
  setDbForTesting(null);
  resetLocalDbForTests();
  await rm(workspace, { recursive: true, force: true });
});

describe("HTTP smoke", () => {
  it("GET /health returns 200", async () => {
    const res = await fetch(`${BASE}/health`);
    assert.equal(res.status, 200);
  });

  it("GET /graph returns a payload with the seeded organization", async () => {
    const res = await fetch(`${BASE}/graph`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { nodes: Array<{ id: string; type: string }> };
    assert.ok(Array.isArray(body.nodes));
    assert.ok(body.nodes.some((n) => n.id === orgId && n.type === "organization"));
  });

  it("GET / returns 404 for unknown paths", async () => {
    const res = await fetch(`${BASE}/no-such-route`);
    assert.equal(res.status, 404);
  });
});

describe("POST /nodes regression: org-invariant", () => {
  it("creates an organization node without organization_id", async () => {
    const res = await fetch(`${BASE}/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "organization", name: "Org Two" }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { id: string; type: string };
    assert.equal(body.type, "organization");
  });

  it("rejects a non-organization node without organization_id (400)", async () => {
    const res = await fetch(`${BASE}/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "project", name: "Orphan project" }),
    });
    const body = (await res.json()) as { error: string };
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${body.error}`);
    assert.match(body.error, /organization_id is required/);
  });

  it("creates a non-organization node with organization_id and attaches the belongs_to edge", async () => {
    const res = await fetch(`${BASE}/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "project",
        name: "Real project",
        organization_id: orgId,
      }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      id: string;
      type: string;
      edges: Array<{ relation: string; direction: string; peer_id: string }>;
    };
    assert.equal(body.type, "project");
    const belongsTo = body.edges.find(
      (e) => e.relation === "belongs_to" && e.direction === "outgoing",
    );
    assert.ok(belongsTo, "expected an outgoing belongs_to edge");
    assert.equal(belongsTo.peer_id, orgId);
  });

  it("rejects unknown node type with 400", async () => {
    const res = await fetch(`${BASE}/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "fungus", name: "Nope", organization_id: orgId }),
    });
    assert.equal(res.status, 400);
  });
});
