// Wire-level contract for GET /nodes/:id/sandbox-profile — the endpoint
// the desktop app calls before spawning a terminal, to wrap the agent in
// a Seatbelt profile matching the node's scope (home mirror rw, depth-1
// neighbor mirrors ro, rest of PORTUNI_ROOT denied).

// Pre-wire the server port BEFORE importing anything from src/ (the
// middleware reads process.env.PORT at module load).
process.env.PORT = "14913";
process.env.HOST = "127.0.0.1";
process.env.PORTUNI_AUTH_TOKEN = "";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient } from "@libsql/client";
import { ulid } from "ulid";
import { ensureSchemaOn, SOLO_USER } from "../apps/server/infra/schema.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { resetGateCachesForTesting } from "../apps/server/http/middleware.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { startHttpServer, type HttpServerHandle } from "../apps/server/http/server.js";

const BASE = "http://127.0.0.1:14913";

let handle: HttpServerHandle;
let workspace: string;
let orgId: string;
let projId: string;
let noMirrorId: string;

before(async () => {
  resetGateCachesForTesting();
  workspace = await mkdtemp(join(tmpdir(), "portuni-rest-sbx-"));
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
  const db = createClient({ url: ":memory:" });
  await ensureSchemaOn(db);
  setDbForTesting(db);

  orgId = ulid();
  projId = ulid();
  noMirrorId = ulid();
  await db.execute({
    sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
    args: [orgId, "organization", "Acme", "acme", SOLO_USER],
  });
  for (const [id, name] of [
    [projId, "Proj"],
    [noMirrorId, "Bare"],
  ] as const) {
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
      args: [id, "project", name, name.toLowerCase(), SOLO_USER],
    });
    await db.execute({
      sql: "INSERT INTO edges (id, source_id, target_id, relation, created_by) VALUES (?, ?, ?, ?, ?)",
      args: [ulid(), id, orgId, "belongs_to", SOLO_USER],
    });
  }

  const homeDir = join(workspace, "acme", "projects", "proj");
  const orgDir = join(workspace, "acme");
  await mkdir(homeDir, { recursive: true });
  await registerMirror(SOLO_USER, projId, homeDir);
  await registerMirror(SOLO_USER, orgId, orgDir);

  handle = startHttpServer({ port: 14913, host: "127.0.0.1", registerSigint: false });
  await new Promise((r) => setImmediate(r));
});

after(async () => {
  await handle.shutdown();
  resetLocalDbForTests();
  await rm(workspace, { recursive: true, force: true });
});

describe("GET /nodes/:id/sandbox-profile", () => {
  it("returns the profile with home rw, neighbor ro, root deny", async () => {
    const res = await fetch(`${BASE}/nodes/${projId}/sandbox-profile`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      profile: string;
      portuni_root: string;
      home_mirror: string;
      neighbor_mirrors: string[];
    };
    assert.ok(body.home_mirror.endsWith(join("acme", "projects", "proj")));
    assert.equal(body.neighbor_mirrors.length, 1);
    assert.ok(body.profile.startsWith("(version 1)"));
    assert.ok(body.profile.includes(`(allow file-read* file-write* (subpath "${body.home_mirror}"))`));
    assert.ok(body.profile.includes(`(allow file-read* (subpath "${body.neighbor_mirrors[0]}"))`));
    assert.ok(body.profile.includes(`(deny file-read* file-write* (subpath "${body.portuni_root}"))`));
  });

  it("409 NO_MIRROR when the node has no local mirror", async () => {
    const res = await fetch(`${BASE}/nodes/${noMirrorId}/sandbox-profile`);
    assert.equal(res.status, 409);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, "NO_MIRROR");
  });

  it("404 for an unknown node", async () => {
    const res = await fetch(`${BASE}/nodes/${ulid()}/sandbox-profile`);
    assert.equal(res.status, 404);
  });
});

describe("GET /sandbox-profile?cwd=", () => {
  it("resolves the node from cwd and returns the same payload shape", async () => {
    const cwd = join(workspace, "acme", "projects", "proj", "wip");
    await mkdir(cwd, { recursive: true });
    const res = await fetch(`${BASE}/sandbox-profile?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { node_id: string; profile: string; home_mirror: string };
    assert.equal(body.node_id, projId);
    assert.ok(body.profile.startsWith("(version 1)"));
    assert.ok(body.home_mirror.endsWith(join("acme", "projects", "proj")));
  });

  it("409 NO_MIRROR when cwd is outside every mirror", async () => {
    const res = await fetch(
      `${BASE}/sandbox-profile?cwd=${encodeURIComponent(join(workspace, "nowhere"))}`,
    );
    assert.equal(res.status, 409);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, "NO_MIRROR");
  });

  it("400 without a cwd param", async () => {
    const res = await fetch(`${BASE}/sandbox-profile`);
    assert.equal(res.status, 400);
  });
});
