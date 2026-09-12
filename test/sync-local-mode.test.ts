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
import { mkdtemp, rm, writeFile, mkdir, stat, readFile } from "node:fs/promises";
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
import {
  adoptFiles,
  deleteFile,
  moveFile,
  renameFile,
  renameFolder,
} from "../apps/server/domain/sync/engine-mutations.js";
import { remoteSweep } from "../apps/server/domain/sync/remote-sweep.js";
import { resolveRemote, listRemotes, listRules, legacyRemoteRowCounts } from "../apps/server/domain/sync/routing.js";
import { getAdapter } from "../apps/server/domain/sync/adapter-cache.js";
import { runNodeSync } from "../apps/server/domain/sync/sync-run.js";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, buildDefaultEnvIdentity } from "../apps/server/mcp/server.js";
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

  it("a legacy remote + routing rule (pre-#310 data) resolves nothing: registration stamps no remote_name and the scan never touches the adapter", async () => {
    const { db, nodeId } = await makeSharedDb();
    await seedLegacyRemote(db);

    // The routing layer is where "behaves as if it had none" is enforced;
    // only the boot warning still sees the raw rows.
    assert.equal(await resolveRemote(db, "project", null), null);
    assert.deepEqual(await listRemotes(db), []);
    assert.deepEqual(await listRules(db), []);
    // makeSharedDb seeds one fs remote + one rule of its own; the legacy pair
    // sits on top of that.
    assert.deepEqual(await legacyRemoteRowCounts(db), { remotes: 2, rules: 2 });

    const mirrorRoot = join(workspace, "mirror");
    await registerMirror(SOLO_USER, nodeId, mirrorRoot);
    const src = join(workspace, "c.txt");
    await writeFile(src, "v1");
    const { file_id, remote_name } = await registerLocalFile(db, { userId: SOLO_USER, nodeId, localPath: src });
    assert.equal(remote_name, null, "a local workspace never routes, whatever rows are left over");

    const scan = await statusScan(db, { userId: SOLO_USER, nodeId, includeDiscovery: false });
    assert.equal(scan.clean.length, 1);
    assert.equal(scan.clean[0].file_id, file_id);
    assert.equal(scan.push_candidates.length, 0);
    assert.equal(scan.remote_missing.length, 0);
  });

  it("getAdapter refuses on a local workspace even for a cached adapter", async () => {
    const { db } = await makeSharedDb();
    await seedLegacyRemote(db);
    await assert.rejects(() => getAdapter(db, "legacy"), (err: unknown) => err instanceof LocalModeNoRemoteError);
  });
});

// A pre-#310 installation: a remote, a wildcard rule, and rows already
// stamped with that remote_name. Every method of the adapter throws, so any
// path that still dials it fails loudly instead of "working" by accident.
async function seedLegacyRemote(db: SharedDb["db"]): Promise<void> {
  await insertRemoteForTests(db, { name: "legacy", type: "fs", config: { root: "/nonexistent" }, created_by: SOLO_USER });
  await insertRuleForTests(db, { priority: 1, node_type: null, org_slug: null, remote_name: "legacy" });
  setAdapterForTests("legacy", throwingAdapter());
}

async function registerLegacyRow(
  db: SharedDb["db"],
  nodeId: string,
  name: string,
  content = "v1",
): Promise<{ file_id: string; local_path: string; remote_path: string }> {
  const src = join(workspace, name);
  await writeFile(src, content);
  const reg = await registerLocalFile(db, { userId: SOLO_USER, nodeId, localPath: src });
  // The row as a pre-#310 installation left it: bound to the legacy remote.
  await db.execute({ sql: "UPDATE files SET remote_name = 'legacy' WHERE id = ?", args: [reg.file_id] });
  return { file_id: reg.file_id, local_path: reg.local_path, remote_path: reg.remote_path };
}

describe("file mutations on a local workspace touch the local copy and the row only", () => {
  it("deleteFile on a legacy-bound row removes the local copy and the row without the adapter", async () => {
    const { db, nodeId } = await makeSharedDb();
    await seedLegacyRemote(db);
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror(SOLO_USER, nodeId, mirrorRoot);
    const f = await registerLegacyRow(db, nodeId, "del.txt");

    const preview = await deleteFile(db, { userId: SOLO_USER, fileId: f.file_id });
    assert.ok("preview" in preview);
    assert.deepEqual(preview.preview.will_remove_from, ["local", "portuni"]);

    const r = await deleteFile(db, { userId: SOLO_USER, fileId: f.file_id, confirmed: true });
    assert.equal(r.status, "ok");
    await assert.rejects(() => stat(f.local_path), (e: NodeJS.ErrnoException) => e.code === "ENOENT");
    const row = await db.execute({ sql: "SELECT id FROM files WHERE id = ?", args: [f.file_id] });
    assert.equal(row.rows.length, 0);
  });

  it("renameFile on a legacy-bound row renames the local copy and the row", async () => {
    const { db, nodeId } = await makeSharedDb();
    await seedLegacyRemote(db);
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror(SOLO_USER, nodeId, mirrorRoot);
    const f = await registerLegacyRow(db, nodeId, "old.txt", "content");

    const r = await renameFile(db, { userId: SOLO_USER, fileId: f.file_id, newFilename: "new.txt" });
    assert.equal(r.status, "ok");
    assert.ok(r.new_local_path);
    assert.equal(await readFile(r.new_local_path!, "utf8"), "content");
    await assert.rejects(() => stat(f.local_path), (e: NodeJS.ErrnoException) => e.code === "ENOENT");
    const row = await db.execute({ sql: "SELECT filename, remote_path FROM files WHERE id = ?", args: [f.file_id] });
    assert.equal(row.rows[0].filename, "new.txt");
    assert.ok((row.rows[0].remote_path as string).endsWith("/new.txt"));
    const pending = await db.execute("SELECT COUNT(*) AS n FROM pending_file_ops");
    assert.equal(Number(pending.rows[0].n), 0, "no remote step, so nothing to retry");
  });

  it("moveFile to another section moves the local copy, rewrites the row and clears the legacy remote_name", async () => {
    const { db, nodeId } = await makeSharedDb();
    await seedLegacyRemote(db);
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror(SOLO_USER, nodeId, mirrorRoot);
    const f = await registerLegacyRow(db, nodeId, "mv.txt", "moved");

    const preview = await moveFile(db, { userId: SOLO_USER, fileId: f.file_id, newSection: "outputs" });
    assert.ok("preview" in preview);
    assert.equal(preview.preview.old_remote_name, null);
    assert.equal(preview.preview.new_remote_name, null);
    assert.equal(preview.preview.cross_remote, false);

    const r = await moveFile(db, { userId: SOLO_USER, fileId: f.file_id, newSection: "outputs", confirmed: true });
    assert.ok("status" in r && r.status === "ok");
    assert.equal(r.new_remote_name, null);
    assert.ok(r.new_local_path?.includes("/outputs/"));
    assert.equal(await readFile(r.new_local_path!, "utf8"), "moved");
    const row = await db.execute({ sql: "SELECT remote_name, remote_path FROM files WHERE id = ?", args: [f.file_id] });
    assert.equal(row.rows[0].remote_name, null);
    assert.equal(row.rows[0].remote_path, r.new_remote_path);
  });

  it("renameFolder applies to the local copies and rows, no pending op", async () => {
    const { db, nodeId } = await makeSharedDb();
    await seedLegacyRemote(db);
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror(SOLO_USER, nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip", "a"), { recursive: true });
    await writeFile(join(mirrorRoot, "wip", "a", "one.md"), "1");
    const reg = await registerLocalFile(db, { userId: SOLO_USER, nodeId, localPath: join(mirrorRoot, "wip", "a", "one.md") });
    await db.execute({ sql: "UPDATE files SET remote_name = 'legacy' WHERE id = ?", args: [reg.file_id] });

    const r = await renameFolder(db, { userId: SOLO_USER, nodeId, oldPrefix: "wip/a", newPrefix: "wip/b", dryRun: false });
    assert.equal(r.type, "applied");
    if (r.type !== "applied") return;
    assert.equal(r.renamed, 1);
    assert.equal(r.failed, 0);
    assert.equal(await readFile(join(mirrorRoot, "wip", "b", "one.md"), "utf8"), "1");
    const pending = await db.execute("SELECT COUNT(*) AS n FROM pending_file_ops");
    assert.equal(Number(pending.rows[0].n), 0);
  });

  it("adoptFiles and remoteSweep refuse", async () => {
    const { db, nodeId } = await makeSharedDb();
    await seedLegacyRemote(db);
    await assert.rejects(
      () => adoptFiles(db, { userId: SOLO_USER, nodeId, paths: ["x"] }),
      (err: unknown) => err instanceof LocalModeNoRemoteError,
    );
    await assert.rejects(
      () => remoteSweep(db, { userId: SOLO_USER, nodeId }),
      (err: unknown) => err instanceof LocalModeNoRemoteError,
    );
  });
});

describe("MCP tools return LOCAL_MODE_NO_REMOTE as a structured error result", () => {
  it("portuni_setup_remote -> isError with code (same code REST sends as 409)", async () => {
    const shared = await makeSharedDb();
    setDbForTesting(shared.db);
    const { server } = createMcpServer(buildDefaultEnvIdentity());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new McpClient({ name: "local-mode-test", version: "0.0.1" }, { capabilities: {} });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: "portuni_setup_remote",
        arguments: { name: "gdrive", type: "fs", config: { root: workspace } },
      });
      assert.equal(result.isError, true);
      const payload = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text) as {
        code?: string;
        error?: string;
      };
      assert.equal(payload.code, "LOCAL_MODE_NO_REMOTE");
      assert.equal(payload.error, new LocalModeNoRemoteError().message);
      const remotes = await shared.db.execute("SELECT COUNT(*) AS n FROM remotes WHERE name = 'gdrive'");
      assert.equal(Number(remotes.rows[0].n), 0, "refused before any write");
    } finally {
      await client.close();
      setDbForTesting(null);
    }
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

  it("POST /nodes/:id/sync/remote-sweep -> 409 LOCAL_MODE_NO_REMOTE", async () => {
    const res = await fetch(`${base}/nodes/${shared.nodeId}/sync/remote-sweep`, { method: "POST" });
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
