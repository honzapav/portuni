// #312: a local workspace (the default test env -- neither PORTUNI_AUTH_MODE=
// google nor PORTUNI_AGENT_MODE=1) never has a remote. statusScan's local
// classification never touches an adapter, and the push/pull surface refuses
// outright with a structured LOCAL_MODE_NO_REMOTE error instead of a generic
// crash. The central engine (engine-central.ts) and the actual central-server
// deployment (PORTUNI_AUTH_MODE=google / PORTUNI_AGENT_MODE=1, exercised by
// the other sync-*.test.ts files) are untouched by this file.

process.env.PORT = "14933";
process.env.HOST = "127.0.0.1";
process.env.PORTUNI_AUTH_TOKEN = "";

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { makeSharedDb, insertRemoteForTests, insertRuleForTests, type SharedDb } from "./helpers/shared-db.js";
import {
  storeFile,
  pullFile,
  registerLocalFile,
  statusScan,
} from "../apps/server/domain/sync/engine.js";
import { runNodeSync } from "../apps/server/domain/sync/sync-run.js";
import { snapshotService, __setSnapshotExporterForTests, __resetSnapshotExporterForTests } from "../apps/server/mcp/tools/sync-snapshot.js";
import { LocalModeNoRemoteError } from "../apps/server/domain/sync/types.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { setAdapterForTests, resetAdapterCacheForTests } from "../apps/server/domain/sync/adapter-cache.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { resetGateCachesForTesting } from "../apps/server/http/middleware.js";
import { startHttpServer, type HttpServerHandle } from "../apps/server/http/server.js";
import { SOLO_USER } from "../apps/server/infra/schema.js";
import type { FileAdapter } from "../apps/server/domain/sync/types.js";

let workspace: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-local-mode-"));
  originalEnv = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  // Deliberately NOT setting PORTUNI_AGENT_MODE/PORTUNI_AUTH_MODE=google --
  // this suite is exercising genuine local-workspace behavior.
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

// Every method throws -- proves the local scan/push/pull path never reaches
// the adapter at all, not just that it happens to return a benign result.
function throwingAdapter(): FileAdapter {
  const boom = () => {
    throw new Error("adapter must not be touched by a local workspace");
  };
  return {
    put: boom,
    get: boom,
    stat: boom,
    list: boom,
    delete: boom,
    rename: boom,
    url: boom,
  } as unknown as FileAdapter;
}

describe("local statusScan classification (no remote, ever)", () => {
  it("tracked + present on disk -> clean", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror(SOLO_USER, nodeId, mirrorRoot);
    const src = join(workspace, "a.txt");
    await writeFile(src, "v1");
    const { file_id } = await registerLocalFile(db, { userId: SOLO_USER, nodeId, localPath: src });
    const scan = await statusScan(db, { userId: SOLO_USER, nodeId, includeDiscovery: false });
    assert.equal(scan.clean.length, 1);
    assert.equal(scan.clean[0].file_id, file_id);
    assert.equal(scan.push_candidates.length, 0);
    assert.equal(scan.conflicts.length, 0);
  });

  it("untracked file on disk -> new_local", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror(SOLO_USER, nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    await writeFile(join(mirrorRoot, "wip", "untracked.md"), "hi");
    const scan = await statusScan(db, { userId: SOLO_USER, nodeId, includeDiscovery: true });
    assert.ok(scan.new_local.some((e) => e.filename === "untracked.md"));
  });

  it("tracked but gone from disk -> deleted_local", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror(SOLO_USER, nodeId, mirrorRoot);
    const src = join(workspace, "b.txt");
    await writeFile(src, "v1");
    const { file_id, local_path } = await registerLocalFile(db, { userId: SOLO_USER, nodeId, localPath: src });
    await rm(local_path);
    const scan = await statusScan(db, { userId: SOLO_USER, nodeId, includeDiscovery: false });
    assert.equal(scan.deleted_local.length, 1);
    assert.equal(scan.deleted_local[0].file_id, file_id);
  });

  it("a legacy row with a remote already configured (pre-#310 data) still classifies clean/deleted_local and never touches the adapter", async () => {
    const { db, nodeId } = await makeSharedDb();
    // Bypasses the LOCAL_MODE_NO_REMOTE guard the same way a pre-existing
    // installation's `remotes`/`remote_routing` rows would (#310's boot
    // warning covers this scenario; the engine must still ignore them).
    await insertRemoteForTests(db, { name: "legacy", type: "fs", config: { root: "/nonexistent" }, created_by: SOLO_USER });
    await insertRuleForTests(db, { priority: 1, node_type: null, org_slug: null, remote_name: "legacy" });
    setAdapterForTests("legacy", throwingAdapter());

    const mirrorRoot = join(workspace, "mirror");
    await registerMirror(SOLO_USER, nodeId, mirrorRoot);
    const src = join(workspace, "c.txt");
    await writeFile(src, "v1");
    const { file_id, remote_name } = await registerLocalFile(db, { userId: SOLO_USER, nodeId, localPath: src });
    assert.equal(remote_name, "legacy", "routing resolves even though this is a local workspace");

    const scan = await statusScan(db, { userId: SOLO_USER, nodeId, includeDiscovery: false });
    assert.equal(scan.clean.length, 1);
    assert.equal(scan.clean[0].file_id, file_id);
    assert.equal(scan.push_candidates.length, 0);
    assert.equal(scan.remote_missing.length, 0);
  });
});

describe("push/pull refuse with LOCAL_MODE_NO_REMOTE on a local workspace", () => {
  it("storeFile refuses", async () => {
    const { db, nodeId } = await makeSharedDb();
    await registerMirror(SOLO_USER, nodeId, join(workspace, "mirror"));
    const src = join(workspace, "d.txt");
    await writeFile(src, "v1");
    await assert.rejects(
      () => storeFile(db, { userId: SOLO_USER, nodeId, localPath: src }),
      (err: unknown) => err instanceof LocalModeNoRemoteError && err.code === "LOCAL_MODE_NO_REMOTE",
    );
  });

  it("pullFile refuses", async () => {
    const { db } = await makeSharedDb();
    await assert.rejects(
      () => pullFile(db, { userId: SOLO_USER, fileId: "nonexistent" }),
      (err: unknown) => err instanceof LocalModeNoRemoteError,
    );
  });

  it("runNodeSync (POST /nodes/:id/sync's domain function) refuses before sweeping or scanning", async () => {
    const { db, nodeId } = await makeSharedDb();
    await assert.rejects(
      () => runNodeSync(db, { userId: SOLO_USER, nodeId }),
      (err: unknown) => err instanceof LocalModeNoRemoteError,
    );
  });

  it("portuni_snapshot's snapshotService refuses", async () => {
    const { db, nodeId } = await makeSharedDb();
    __setSnapshotExporterForTests(async () => Buffer.from("pretend-pdf"));
    try {
      await assert.rejects(
        () =>
          snapshotService(db, {
            userId: SOLO_USER,
            nodeId,
            docUrl: "https://docs.google.com/document/d/ABC123/edit",
          }),
        (err: unknown) => err instanceof LocalModeNoRemoteError,
      );
    } finally {
      __resetSnapshotExporterForTests();
    }
  });
});

describe("REST refuses with 409 LOCAL_MODE_NO_REMOTE on a local workspace", () => {
  let handle: HttpServerHandle;
  let shared: SharedDb;
  let base: string;

  beforeEach(async () => {
    resetGateCachesForTesting();
    shared = await makeSharedDb();
    setDbForTesting(shared.db);
    await registerMirror(SOLO_USER, shared.nodeId, join(workspace, "mirror"));
    handle = startHttpServer({ port: 0, host: "127.0.0.1", registerSigint: false });
    if (!handle.server.listening) {
      await new Promise<void>((r) => handle.server.once("listening", r));
    }
    const addr = handle.server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
    process.env.PORT = String(addr.port);
    resetGateCachesForTesting();
  });

  afterEach(async () => {
    await handle.shutdown();
    setDbForTesting(null);
  });

  it("POST /nodes/:id/sync -> 409 LOCAL_MODE_NO_REMOTE", async () => {
    const res = await fetch(`${base}/nodes/${shared.nodeId}/sync`, { method: "POST" });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, "LOCAL_MODE_NO_REMOTE");
  });

  it("POST /nodes/:id/files/:fileId/resolve -> 409 LOCAL_MODE_NO_REMOTE", async () => {
    const src = join(workspace, "e.txt");
    await writeFile(src, "v1");
    const registered = await registerLocalFile(shared.db, {
      userId: SOLO_USER,
      nodeId: shared.nodeId,
      localPath: src,
    });
    const res = await fetch(`${base}/nodes/${shared.nodeId}/files/${registered.file_id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "restore" }),
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, "LOCAL_MODE_NO_REMOTE");
  });
});
