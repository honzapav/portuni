import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient, type Client } from "@libsql/client";
import { DDL_REMOTES_TABLE, DDL_REMOTE_ROUTING_TABLE, INDEX_REMOTE_ROUTING_PRIORITY } from "../src/infra/schema.js";
import { upsertRemote, addRule, resolveRemote } from "../src/domain/sync/routing.js";
import { createOpenDALAdapter } from "../src/domain/sync/opendal-adapter.js";
import { buildRemotePath, buildNodeRoot } from "../src/domain/sync/remote-path.js";
import { sha256Buffer } from "../src/domain/sync/hash.js";
import {
  upsertLocalMirror, listLocalMirrors,
  upsertFileState, getFileState,
  resetLocalDbForTests,
} from "../src/domain/sync/local-db.js";

let workspace: string;
let remoteRoot: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-foundation-smoke-ws-"));
  remoteRoot = await mkdtemp(join(tmpdir(), "portuni-foundation-smoke-remote-"));
  originalEnv = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
});
afterEach(async () => {
  resetLocalDbForTests();
  if (originalEnv === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalEnv;
  await rm(workspace, { recursive: true, force: true });
  await rm(remoteRoot, { recursive: true, force: true });
});

async function makeShared(): Promise<Client> {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL)`);
  await db.execute(`CREATE TABLE nodes (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL,
    sync_key TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL,
    created_at DATETIME DEFAULT (datetime('now')),
    updated_at DATETIME DEFAULT (datetime('now'))
  )`);
  await db.execute(`CREATE TABLE edges (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL,
    relation TEXT NOT NULL, created_by TEXT NOT NULL,
    created_at DATETIME DEFAULT (datetime('now'))
  )`);
  await db.execute(DDL_REMOTES_TABLE);
  await db.execute(DDL_REMOTE_ROUTING_TABLE);
  await db.execute(INDEX_REMOTE_ROUTING_PRIORITY);
  await db.execute("INSERT INTO users (id,email,name) VALUES ('U1','a@b','A')");
  await db.execute("INSERT INTO nodes (id,type,name,sync_key,created_by) VALUES ('Norg','organization','Workflow','workflow','U1')");
  await db.execute("INSERT INTO nodes (id,type,name,sync_key,created_by) VALUES ('Nproj','project','Stan GWS','stan-gws','U1')");
  await db.execute("INSERT INTO edges (id,source_id,target_id,relation,created_by) VALUES ('E1','Nproj','Norg','belongs_to','U1')");
  return db;
}

describe("foundation smoke", () => {
  it("wires routing, adapter, local state together", async () => {
    const db = await makeShared();
    await upsertRemote(db, { name: "smoke-fs", type: "fs", config: { root: remoteRoot }, created_by: "U1" });
    await addRule(db, { priority: 10, node_type: null, org_slug: null, remote_name: "smoke-fs" });

    const remoteName = await resolveRemote(db, "project", "workflow");
    assert.equal(remoteName, "smoke-fs");

    const adapter = createOpenDALAdapter({ name: "smoke-fs", type: "fs", config: { root: remoteRoot } }, {});
    const path = buildRemotePath({ orgSyncKey: "workflow", nodeType: "project", nodeSyncKey: "stan-gws", section: "wip", subpath: null, filename: "hello.txt" });
    const content = Buffer.from("hi");
    const ref = await adapter.put(path, content);
    assert.equal(ref.path, path);
    assert.equal(ref.size, 2);

    const stat = await adapter.stat(path);
    assert.ok(stat);
    assert.equal(stat!.size, 2);

    const mirrorRoot = join(workspace, "mirror");
    await upsertLocalMirror({ user_id: "U1", node_id: "Nproj", local_path: mirrorRoot });
    const mirrors = await listLocalMirrors("U1");
    assert.equal(mirrors.length, 1);
    assert.equal(mirrors[0].node_id, "Nproj");

    const hash = sha256Buffer(content);
    await upsertFileState({
      file_id: "F1", last_synced_hash: hash,
      cached_local_hash: hash, cached_mtime: Date.now(), cached_size: 2,
    });
    const state = await getFileState("F1");
    assert.ok(state);
    assert.equal(state!.last_synced_hash, hash);
    assert.equal(state!.cached_size, 2);

    const nodeRoot = buildNodeRoot({ orgSyncKey: "workflow", nodeType: "project", nodeSyncKey: "stan-gws" });
    assert.equal(nodeRoot, "workflow/projects/stan-gws");
  });
});
