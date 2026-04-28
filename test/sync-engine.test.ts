import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { storeFile, resolveNodeInfo, pullFile, statusScan, previewNode } from "../src/domain/sync/engine.js";
import { registerMirror } from "../src/domain/sync/mirror-registry.js";
import { sha256Buffer, } from "../src/domain/sync/hash.js";
import { getFileState, resetLocalDbForTests } from "../src/domain/sync/local-db.js";
import { resetAdapterCacheForTests } from "../src/domain/sync/adapter-cache.js";

let workspace: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-engine-"));
  originalEnv = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
  resetAdapterCacheForTests();
});
afterEach(async () => {
  resetLocalDbForTests();
  resetAdapterCacheForTests();
  if (originalEnv === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalEnv;
  await rm(workspace, { recursive: true, force: true });
});

describe("resolveNodeInfo", () => {
  it("returns orgSyncKey + type + nodeSyncKey for a project", async () => {
    const { db, nodeId, orgSyncKey, nodeSyncKey } = await makeSharedDb();
    const info = await resolveNodeInfo(db, nodeId);
    assert.equal(info.orgSyncKey, orgSyncKey);
    assert.equal(info.nodeType, "project");
    assert.equal(info.nodeSyncKey, nodeSyncKey);
  });
  it("for an organization, orgSyncKey == nodeSyncKey", async () => {
    const { db, orgId, orgSyncKey } = await makeSharedDb();
    const info = await resolveNodeInfo(db, orgId);
    assert.equal(info.orgSyncKey, orgSyncKey);
    assert.equal(info.nodeType, "organization");
    assert.equal(info.nodeSyncKey, orgSyncKey);
  });
  it("throws for unknown node", async () => {
    const { db } = await makeSharedDb();
    await assert.rejects(() => resolveNodeInfo(db, "NOT_A_NODE"), /not found/);
  });
});

describe("storeFile v3 (sync_key paths)", () => {
  it("uses sync_key for remote_path", async () => {
    const { db, nodeId, orgSyncKey, nodeSyncKey } = await makeSharedDb();
    await registerMirror("U1", nodeId, join(workspace, "mirror"));
    const src = join(workspace, "in.pdf");
    await writeFile(src, "pdf");
    const r = await storeFile(db, { userId: "U1", nodeId, localPath: src });
    assert.ok(
      r.remote_path.startsWith(`${orgSyncKey}/projects/${nodeSyncKey}/`),
      `path was ${r.remote_path}`,
    );
    assert.ok(r.file_id.length > 0);
    assert.ok(r.hash && r.hash.length === 64);
  });
  it("renaming the node does not affect future store remote_paths", async () => {
    const { db, nodeId } = await makeSharedDb();
    await registerMirror("U1", nodeId, join(workspace, "mirror"));
    await db.execute({
      sql: "UPDATE nodes SET name = ? WHERE id = ?",
      args: ["Stan GWS Phase 2", nodeId],
    });
    const src = join(workspace, "x.txt");
    await writeFile(src, "x");
    const r = await storeFile(db, { userId: "U1", nodeId, localPath: src });
    assert.ok(
      r.remote_path.includes("/projects/stan-gws/"),
      `expected original sync_key in path, got ${r.remote_path}`,
    );
  });
  it("copies file into the mirror when source is outside the mirror", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const src = join(workspace, "outside.txt");
    await writeFile(src, "hello");
    const r = await storeFile(db, { userId: "U1", nodeId, localPath: src });
    // Mirror section defaults to wip; file should be at mirrorRoot/wip/outside.txt
    const mirrored = join(mirrorRoot, "wip", "outside.txt");
    const content = await readFile(mirrored, "utf-8");
    assert.equal(content, "hello");
    assert.ok(r.remote_path.endsWith("/wip/outside.txt"));
  });
  it("detects subpath when source is inside the mirror", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "outputs", "research"), { recursive: true });
    const src = join(mirrorRoot, "outputs", "research", "note.md");
    await writeFile(src, "note");
    const r = await storeFile(db, { userId: "U1", nodeId, localPath: src });
    assert.ok(
      r.remote_path.includes("/outputs/research/note.md"),
      `got ${r.remote_path}`,
    );
  });
  it("writes file_state with last_synced_hash and cached fields", async () => {
    const { db, nodeId } = await makeSharedDb();
    await registerMirror("U1", nodeId, join(workspace, "mirror"));
    const src = join(workspace, "h.txt");
    await writeFile(src, "hash-me");
    const r = await storeFile(db, { userId: "U1", nodeId, localPath: src });
    const state = await getFileState(r.file_id);
    assert.ok(state);
    assert.equal(state!.last_synced_hash, sha256Buffer(Buffer.from("hash-me")));
    assert.equal(state!.cached_local_hash, state!.last_synced_hash);
    assert.ok(state!.cached_size !== null && state!.cached_mtime !== null);
  });
});

describe("pullFile", () => {
  it("downloads remote content into the mirror and writes file_state", async () => {
    const { db, nodeId } = await makeSharedDb();
    await registerMirror("U1", nodeId, join(workspace, "mirror"));
    const src = join(workspace, "src.txt");
    await writeFile(src, "source-bytes");
    const stored = await storeFile(db, { userId: "U1", nodeId, localPath: src });
    // Simulate: delete local mirror file; pull should restore.
    await rm(stored.local_path, { force: true });
    const pulled = await pullFile(db, { userId: "U1", fileId: stored.file_id });
    assert.equal(pulled.local_path, stored.local_path);
    assert.equal(pulled.hash, stored.hash);
    const content = await readFile(pulled.local_path, "utf-8");
    assert.equal(content, "source-bytes");
  });
  it("throws when file_id does not exist", async () => {
    const { db } = await makeSharedDb();
    await assert.rejects(() => pullFile(db, { userId: "U1", fileId: "BADID" }));
  });
});

describe("statusScan", () => {
  it("classifies a freshly stored file as clean", async () => {
    const { db, nodeId } = await makeSharedDb();
    await registerMirror("U1", nodeId, join(workspace, "mirror"));
    const src = join(workspace, "ok.txt");
    await writeFile(src, "v1");
    const { file_id } = await storeFile(db, { userId: "U1", nodeId, localPath: src });
    const scan = await statusScan(db, { userId: "U1", nodeId, includeDiscovery: false });
    assert.equal(scan.clean.length, 1);
    assert.equal(scan.clean[0].file_id, file_id);
  });

  it("classifies a locally modified file as push candidate", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const src = join(workspace, "p.txt");
    await writeFile(src, "first");
    const { file_id, local_path } = await storeFile(db, {
      userId: "U1",
      nodeId,
      localPath: src,
    });
    // Modify local. Bump mtime explicitly (some filesystems give same ms when
    // writes happen close together) so the hash cache is invalidated.
    await writeFile(local_path, "second");
    const { utimes } = await import("node:fs/promises");
    const future = new Date(Date.now() + 5000);
    await utimes(local_path, future, future);
    const scan = await statusScan(db, { userId: "U1", nodeId, includeDiscovery: false });
    assert.ok(
      scan.push_candidates.find((e) => e.file_id === file_id),
      "expected file in push_candidates",
    );
  });

  it("reports a stored file's mirror file as known; unknown files become new_local in discovery phase", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    // Add an un-stored file inside wip/.
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    await writeFile(join(mirrorRoot, "wip", "unknown.md"), "u");
    const scan = await statusScan(db, { userId: "U1", nodeId, includeDiscovery: true });
    assert.ok(
      scan.new_local.find((e) => e.filename === "unknown.md"),
      "expected unknown.md in new_local",
    );
  });
});

describe("previewNode", () => {
  it("returns per-file statuses scoped to the node", async () => {
    const { db, nodeId } = await makeSharedDb();
    await registerMirror("U1", nodeId, join(workspace, "mirror"));
    const src = join(workspace, "pv.txt");
    await writeFile(src, "pv");
    const stored = await storeFile(db, { userId: "U1", nodeId, localPath: src });
    const r = await previewNode(db, { userId: "U1", nodeId });
    const entry = r.files.find((f) => f.file_id === stored.file_id);
    assert.ok(entry);
    assert.equal(entry!.status, "unchanged");
  });
});

