// REST auth endpoints: /me, /device-tokens, /auth/login (env mode -> 404).
// Uses the same in-process server bootstrapping as rest-smoke.test.ts.

process.env.PORT = "14920";
process.env.HOST = "127.0.0.1";
process.env.PORTUNI_AUTH_TOKEN = "";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient, type Client } from "@libsql/client";
import { ulid } from "ulid";
import { ensureSchemaOn } from "../src/infra/schema.js";
import { setDbForTesting } from "../src/infra/db.js";
import { resetGateCachesForTesting } from "../src/http/middleware.js";
import { resetLocalDbForTests } from "../src/domain/sync/local-db.js";
import { startHttpServer, type HttpServerHandle } from "../src/http/server.js";

const base = "http://127.0.0.1:14920";

let handle: HttpServerHandle;
let workspace: string;
let db: Client;

before(async () => {
  resetGateCachesForTesting();
  workspace = await mkdtemp(join(tmpdir(), "portuni-rest-auth-"));
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
  db = createClient({ url: ":memory:" });
  await ensureSchemaOn(db);
  setDbForTesting(db);

  handle = startHttpServer({
    port: 14920,
    host: "127.0.0.1",
    registerSigint: false,
  });
  await new Promise((r) => setImmediate(r));
});

after(async () => {
  await handle.shutdown();
  setDbForTesting(null);
  resetLocalDbForTests();
  await rm(workspace, { recursive: true, force: true });
});

describe("GET /me", () => {
  it("returns the env-mode solo identity", async () => {
    const res = await fetch(`${base}/me`);
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.global_scope, "admin");
    assert.equal(body.via, "env");
  });
});

describe("device token lifecycle over REST", () => {
  it("mint, list, delete cycle works", async () => {
    const mint = await fetch(`${base}/device-tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "test-device" }),
    });
    assert.equal(mint.status, 201);
    const minted = await mint.json() as { id: string; token: string };
    assert.ok(minted.token.startsWith("ptk_"));

    const list = await fetch(`${base}/device-tokens`);
    const rows = await list.json() as Array<{ label: string; token?: string; revoked_at: string | null }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].label, "test-device");
    assert.equal(rows[0].token, undefined, "plaintext never returned again");

    const del = await fetch(`${base}/device-tokens/${minted.id}`, { method: "DELETE" });
    assert.equal(del.status, 200);
    const list2 = await (await fetch(`${base}/device-tokens`)).json() as Array<{ revoked_at: string | null }>;
    assert.ok(list2[0].revoked_at);
  });
});

describe("POST /auth/login", () => {
  it("returns 404 in env mode", async () => {
    const res = await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id_token: "x" }),
    });
    assert.equal(res.status, 404);
  });
});

describe("REST write attribution", () => {
  it("POST /nodes attributes created_by to the request identity (env -> SOLO_USER)", async () => {
    // Seed an organization so we can attach a project to it.
    const orgId = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
      args: [orgId, "organization", "Test Org", "test-org", "01SOLO0000000000000000000"],
    });

    const res = await fetch(`${base}/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "project", name: "Test Project", organization_id: orgId }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { id: string };

    // Query the DB directly to verify created_by was stamped from identity.
    const row = await db.execute({
      sql: "SELECT created_by FROM nodes WHERE id = ?",
      args: [body.id],
    });
    assert.equal(row.rows.length, 1);
    // In env mode the identity resolves to SOLO_USER = 01SOLO0000000000000000000.
    assert.equal(row.rows[0].created_by, "01SOLO0000000000000000000");
  });
});
