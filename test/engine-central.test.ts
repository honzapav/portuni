import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import type { CentralClient } from "../apps/server/domain/sync/central/client.js";
import { CentralHttpError } from "../apps/server/domain/sync/central/client.js";
import {
  statusScanCentral,
  registerLocalFileCentral,
  storeFileCentral,
  pullFileCentral,
  reconcilePathCentral,
  syncRunCentral,
  computeSyncPendingCentral,
  createMirrorForNodeCentral,
} from "../apps/server/domain/sync/central/engine-central.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { resetLocalDbForTests, getFileState } from "../apps/server/domain/sync/local-db.js";
import type { NodeSyncInfo } from "../apps/server/domain/sync/sync-remote-api.js";
import type { RemoteSweepResult } from "../apps/server/domain/sync/remote-sweep.js";
import { MirrorCreateError } from "../apps/server/domain/sync/mirror-create.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const NODE_ID = "N000000000000000000000PROJ";
const ORG_KEY = "workflow";
const NODE_KEY = "stan-gws";
// buildNodeRoot for a project under an org: "<org>/projects/<sync_key>"
const NODE_ROOT = posix.join(ORG_KEY, "projects", NODE_KEY);

// In-memory fake of the central server: file records + a byte store keyed by
// remote_path. Canonical hash = sha256 (matches the fs adapter).
class FakeCentral implements CentralClient {
  records = new Map<
    string,
    { id: string; filename: string; status: string; is_native_format: boolean }
  >();
  bytes = new Map<string, Buffer>();
  // Delete tombstones the server would derive from audit_log (GH #79).
  deleted: Array<{ file_id: string; remote_path: string }> = [];
  nextId = 1;
  nodeName = "Stan GWS";
  nodeType = "project";

  private info(): NodeSyncInfo {
    return {
      node: {
        id: NODE_ID,
        name: this.nodeName,
        type: this.nodeType,
        sync_key: NODE_KEY,
        org_sync_key: ORG_KEY,
      },
      remote_name: "test-fs",
      files: Array.from(this.records.entries()).map(([remotePath, r]) => ({
        id: r.id,
        filename: r.filename,
        status: r.status,
        remote_path: remotePath,
        current_remote_hash: this.bytes.has(remotePath)
          ? sha(this.bytes.get(remotePath) as Buffer)
          : null,
        is_native_format: r.is_native_format,
        mime_type: null,
      })),
      deleted: this.deleted,
    };
  }

  async syncInfo(nodeId: string): Promise<NodeSyncInfo> {
    if (nodeId !== NODE_ID) throw new CentralHttpError("not found", 404, "NOT_FOUND");
    return this.info();
  }

  async registerFile(nodeId: string, relPath: string) {
    if (nodeId !== NODE_ID) throw new CentralHttpError("not found", 404, "NOT_FOUND");
    const remotePath = posix.join(NODE_ROOT, relPath);
    const existing = this.records.get(remotePath);
    if (existing) {
      return {
        id: existing.id,
        filename: existing.filename,
        remote_name: "test-fs",
        remote_path: remotePath,
      };
    }
    const id = `F${this.nextId++}`;
    const filename = relPath.split("/").pop() as string;
    this.records.set(remotePath, {
      id,
      filename,
      status: relPath.startsWith("outputs/") ? "output" : "wip",
      is_native_format: false,
    });
    return { id, filename, remote_name: "test-fs", remote_path: remotePath };
  }

  async syncInfoBatch(nodeIds: string[]): Promise<NodeSyncInfo[]> {
    const out: NodeSyncInfo[] = [];
    for (const id of nodeIds) {
      try {
        out.push(await this.syncInfo(id));
      } catch {
        /* omitted, like the server */
      }
    }
    return out;
  }

  async registerFiles(nodeId: string, relPaths: string[]) {
    const out = [];
    for (const rel of relPaths) out.push(await this.registerFile(nodeId, rel));
    return out;
  }

  invalidateSyncInfo(_nodeId: string): void {
    /* fake has no cache */
  }

  async getFileRaw(_nodeId: string, relPath: string) {
    const remotePath = posix.join(NODE_ROOT, relPath);
    const b = this.bytes.get(remotePath);
    if (!b) throw new CentralHttpError("not found", 404, "NOT_FOUND");
    return { bytes: b, version: sha(b), canonicalHash: sha(b) };
  }

  async putFileRaw(
    _nodeId: string,
    relPath: string,
    bytes: Buffer,
    opts?: { baseVersion?: string; force?: boolean },
  ) {
    const remotePath = posix.join(NODE_ROOT, relPath);
    const cur = this.bytes.get(remotePath);
    if (opts?.baseVersion && !opts.force && cur && sha(cur) !== opts.baseVersion) {
      throw new CentralHttpError("changed", 409, "CONFLICT", sha(cur));
    }
    this.bytes.set(remotePath, Buffer.from(bytes));
    return { version: sha(bytes), canonicalHash: sha(bytes) };
  }

  moveCalls: Array<{ fileId: string; newRemotePath: string }> = [];
  async moveFileRecord(
    nodeId: string,
    fileId: string,
    body: {
      new_section?: string;
      new_subpath?: string | null;
      new_filename?: string;
      new_node_id?: string;
      confirmed: boolean;
    },
  ): Promise<Record<string, unknown>> {
    if (nodeId !== NODE_ID) throw new CentralHttpError("not found", 404, "NOT_FOUND");
    const entry = [...this.records.entries()].find(([, r]) => r.id === fileId);
    if (!entry) throw new CentralHttpError("not found", 404, "NOT_FOUND");
    const [oldRemotePath, r] = entry;
    const rel = [body.new_section, body.new_subpath, body.new_filename ?? r.filename]
      .filter((x): x is string => typeof x === "string" && x.length > 0)
      .join("/");
    const newRemotePath = posix.join(NODE_ROOT, rel);
    this.records.delete(oldRemotePath);
    this.records.set(newRemotePath, { ...r, filename: body.new_filename ?? r.filename });
    const bytes = this.bytes.get(oldRemotePath);
    if (bytes) {
      this.bytes.delete(oldRemotePath);
      this.bytes.set(newRemotePath, bytes);
    }
    this.moveCalls.push({ fileId, newRemotePath });
    return { status: "ok", file_id: fileId, new_remote_path: newRemotePath, moved_at: "now" };
  }

  async deleteFileRecord(nodeId: string, fileId: string): Promise<Record<string, unknown>> {
    if (nodeId !== NODE_ID) throw new CentralHttpError("not found", 404, "NOT_FOUND");
    const entry = [...this.records.entries()].find(([, r]) => r.id === fileId);
    if (entry) {
      this.records.delete(entry[0]);
      this.bytes.delete(entry[0]);
    }
    return { status: "ok", file_id: fileId, mode: "complete", deleted_at: "now" };
  }

  async dataSources() {
    return [];
  }

  async nodeNeighbours(_nodeId: string): Promise<string[]> {
    return [];
  }

  async nodeExists(nodeId: string) {
    return nodeId === NODE_ID;
  }

  sweepCalls = 0;
  sweepResult: RemoteSweepResult = {
    adopted: [],
    deleted_on_remote: [],
    errors: [],
    repaired: [],
    pending_repairs: [],
  };
  // Content to install for each `sweepResult.adopted` entry -- keyed by
  // remote_path. The real remoteSweep confirms the object on the remote
  // *before* adopting it, i.e. the record + bytes exist on the remote by
  // the time it returns; this fake mirrors that by actually mutating
  // `this.records`/`this.bytes` (which `syncInfo()` reads live) rather than
  // just returning a canned result, so a caller that reads sync-info AFTER
  // calling remoteSweep sees the adopted file, and one that reads it BEFORE
  // (i.e. an incorrectly reordered syncRunCentral) does not.
  sweepBytes = new Map<string, Buffer>();
  // Set to make the sweep call fail the way a real central server can:
  // CentralHttpError for a 403/404, anything else for a genuine bug.
  sweepError: Error | null = null;
  async remoteSweep(nodeId: string): Promise<RemoteSweepResult> {
    if (this.sweepError) throw this.sweepError;
    if (nodeId !== NODE_ID) throw new CentralHttpError("not found", 404, "NOT_FOUND");
    this.sweepCalls++;
    for (const f of this.sweepResult.adopted) {
      if (!this.records.has(f.remote_path)) {
        this.records.set(f.remote_path, {
          id: f.file_id,
          filename: f.filename,
          status: f.remote_path.includes("/outputs/") ? "output" : "wip",
          is_native_format: false,
        });
      }
      if (!this.bytes.has(f.remote_path)) {
        this.bytes.set(f.remote_path, this.sweepBytes.get(f.remote_path) ?? Buffer.from(""));
      }
    }
    for (const f of this.sweepResult.deleted_on_remote) {
      this.records.delete(f.remote_path);
      this.bytes.delete(f.remote_path);
    }
    return this.sweepResult;
  }

  // Test helper: seed a record whose bytes exist remotely.
  seedRemote(relPath: string, content: string): string {
    const remotePath = posix.join(NODE_ROOT, relPath);
    const id = `F${this.nextId++}`;
    this.records.set(remotePath, {
      id,
      filename: relPath.split("/").pop() as string,
      status: "wip",
      is_native_format: false,
    });
    this.bytes.set(remotePath, Buffer.from(content));
    return id;
  }
}

let workspace: string;
let mirrorRoot: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-central-"));
  mirrorRoot = join(workspace, ORG_KEY, "projects", NODE_KEY);
  originalEnv = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
});

afterEach(async () => {
  resetLocalDbForTests();
  if (originalEnv === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalEnv;
  await rm(workspace, { recursive: true, force: true });
});

async function setupMirror(): Promise<void> {
  await mkdir(join(mirrorRoot, "wip"), { recursive: true });
  await mkdir(join(mirrorRoot, "outputs"), { recursive: true });
  await mkdir(join(mirrorRoot, "resources"), { recursive: true });
  await registerMirror("U1", NODE_ID, mirrorRoot);
}

describe("statusScanCentral", () => {
  it("classifies never-synced remote content as pull", async () => {
    const c = new FakeCentral();
    await setupMirror();
    c.seedRemote("wip/doc.md", "remote content");
    const scan = await statusScanCentral(c, { userId: "U1", nodeId: NODE_ID });
    assert.equal(scan.pull_candidates.length, 1);
    assert.equal(scan.pull_candidates[0].filename, "doc.md");
  });

  it("classifies registered-but-never-pushed local file as push", async () => {
    const c = new FakeCentral();
    await setupMirror();
    const abs = join(mirrorRoot, "wip", "new.md");
    await writeFile(abs, "local only");
    await registerLocalFileCentral(c, { userId: "U1", nodeId: NODE_ID, localPath: abs });
    const scan = await statusScanCentral(c, { userId: "U1", nodeId: NODE_ID });
    assert.equal(scan.push_candidates.length, 1);
    assert.equal(scan.push_candidates[0].filename, "new.md");
  });

  it("finds untracked files as new_local", async () => {
    const c = new FakeCentral();
    await setupMirror();
    await writeFile(join(mirrorRoot, "wip", "loose.txt"), "x");
    const scan = await statusScanCentral(c, { userId: "U1", nodeId: NODE_ID });
    assert.equal(scan.new_local.length, 1);
    assert.equal(scan.new_local[0].filename, "loose.txt");
  });

  it("clean after a full sync roundtrip", async () => {
    const c = new FakeCentral();
    await setupMirror();
    await writeFile(join(mirrorRoot, "wip", "a.md"), "hello");
    const run = await syncRunCentral(c, { userId: "U1", nodeId: NODE_ID });
    assert.equal(run.adopted.length, 1);
    assert.equal(run.errors.length, 0);
    const scan = await statusScanCentral(c, { userId: "U1", nodeId: NODE_ID });
    assert.equal(scan.clean.length, 1);
    assert.equal(scan.new_local.length, 0);
  });

  it("local edit after sync classifies push; remote edit classifies pull; both = conflict", async () => {
    const c = new FakeCentral();
    await setupMirror();
    const abs = join(mirrorRoot, "wip", "a.md");
    await writeFile(abs, "v1");
    await syncRunCentral(c, { userId: "U1", nodeId: NODE_ID });

    // Local edit -> push.
    await writeFile(abs, "v2-local");
    let scan = await statusScanCentral(c, { userId: "U1", nodeId: NODE_ID });
    assert.equal(scan.push_candidates.length, 1);

    // Restore local to synced content, move remote -> pull.
    await writeFile(abs, "v1");
    c.bytes.set(posix.join(NODE_ROOT, "wip/a.md"), Buffer.from("v2-remote"));
    scan = await statusScanCentral(c, { userId: "U1", nodeId: NODE_ID });
    assert.equal(scan.pull_candidates.length, 1);

    // Divergence on both sides -> conflict.
    await writeFile(abs, "v3-local");
    scan = await statusScanCentral(c, { userId: "U1", nodeId: NODE_ID });
    assert.equal(scan.conflicts.length, 1);
  });

  it("deleted local file (after sync) reports deleted_local", async () => {
    const c = new FakeCentral();
    await setupMirror();
    const abs = join(mirrorRoot, "wip", "a.md");
    await writeFile(abs, "v1");
    await syncRunCentral(c, { userId: "U1", nodeId: NODE_ID });
    await rm(abs);
    // Watcher would clear the cache; simulate via reconcile.
    await reconcilePathCentral(c, { userId: "U1", nodeId: NODE_ID, absPath: abs });
    const scan = await statusScanCentral(c, { userId: "U1", nodeId: NODE_ID, fast: true });
    assert.equal(scan.deleted_local.length, 1);
  });

  it("watcher-observed mv of a pushed file pairs by inode and calls the central move", async () => {
    const c = new FakeCentral();
    await setupMirror();
    const oldAbs = join(mirrorRoot, "wip", "a.md");
    await writeFile(oldAbs, "obsah-mv");
    await syncRunCentral(c, { userId: "U1", nodeId: NODE_ID });

    const newAbs = join(mirrorRoot, "outputs", "b.md");
    await mkdir(join(mirrorRoot, "outputs"), { recursive: true });
    const { rename } = await import("node:fs/promises");
    await rename(oldAbs, newAbs);
    // Watcher fires both paths; order old -> new.
    const r1 = await reconcilePathCentral(c, { userId: "U1", nodeId: NODE_ID, absPath: oldAbs });
    const r2 = await reconcilePathCentral(c, { userId: "U1", nodeId: NODE_ID, absPath: newAbs });
    assert.equal(r1.action, "deleted");
    assert.equal(r2.action, "moved");
    assert.equal(c.moveCalls.length, 1);
    assert.match(c.moveCalls[0].newRemotePath, /outputs\/b\.md$/);
    assert.equal(c.records.size, 1);
  });

  it("watcher-observed mv of a never-pushed file unregisters and re-registers (one record)", async () => {
    const c = new FakeCentral();
    await setupMirror();
    const oldAbs = join(mirrorRoot, "wip", "a.md");
    await writeFile(oldAbs, "lokalni-mv");
    // Register only (watcher path), never push.
    const reg = await reconcilePathCentral(c, { userId: "U1", nodeId: NODE_ID, absPath: oldAbs });
    assert.equal(reg.action, "registered");

    const newAbs = join(mirrorRoot, "wip", "b.md");
    const { rename } = await import("node:fs/promises");
    await rename(oldAbs, newAbs);
    const r1 = await reconcilePathCentral(c, { userId: "U1", nodeId: NODE_ID, absPath: newAbs });
    const r2 = await reconcilePathCentral(c, { userId: "U1", nodeId: NODE_ID, absPath: oldAbs });
    assert.equal(r1.action, "moved");
    assert.equal(r2.action, "noop");
    assert.equal(c.records.size, 1);
    assert.equal([...c.records.values()][0].filename, "b.md");
    assert.equal(c.bytes.size, 0); // nothing was ever uploaded
  });

  it("tombstoned local copy classifies deleted_remote and the sync run cleans it up", async () => {
    const c = new FakeCentral();
    await setupMirror();
    const abs = join(mirrorRoot, "wip", "a.md");
    await writeFile(abs, "v1");
    await syncRunCentral(c, { userId: "U1", nodeId: NODE_ID });
    // Deletion observed elsewhere: record gone, tombstone published, local
    // copy + file_state left behind on this device.
    const remotePath = posix.join(NODE_ROOT, "wip/a.md");
    const fileId = c.records.get(remotePath)!.id;
    c.records.delete(remotePath);
    c.bytes.delete(remotePath);
    c.deleted.push({ file_id: fileId, remote_path: remotePath });

    const scan = await statusScanCentral(c, { userId: "U1", nodeId: NODE_ID });
    assert.equal(scan.new_local.length, 0);
    assert.equal(scan.deleted_remote.length, 1);
    assert.equal(scan.deleted_remote[0].file_id, fileId);

    const run = await syncRunCentral(c, { userId: "U1", nodeId: NODE_ID });
    assert.equal(run.deleted_remote.length, 1);
    await assert.rejects(() => readFile(abs));
    assert.equal(await getFileState(fileId), null);
    // Nothing was adopted back -- the deletion stays deleted.
    assert.equal(run.adopted.length, 0);
  });

  it("tombstoned copy modified after the delete stays new_local (adopted, not destroyed)", async () => {
    const c = new FakeCentral();
    await setupMirror();
    const abs = join(mirrorRoot, "wip", "a.md");
    await writeFile(abs, "v1");
    await syncRunCentral(c, { userId: "U1", nodeId: NODE_ID });
    const remotePath = posix.join(NODE_ROOT, "wip/a.md");
    const fileId = c.records.get(remotePath)!.id;
    c.records.delete(remotePath);
    c.bytes.delete(remotePath);
    c.deleted.push({ file_id: fileId, remote_path: remotePath });
    await writeFile(abs, "upraveno po smazani");

    const scan = await statusScanCentral(c, { userId: "U1", nodeId: NODE_ID });
    assert.equal(scan.deleted_remote.length, 0);
    assert.equal(scan.new_local.length, 1);
    assert.equal(await readFile(abs, "utf8"), "upraveno po smazani");
  });
});

describe("push/pull via syncRunCentral", () => {
  it("push uploads bytes and records the canonical baseline", async () => {
    const c = new FakeCentral();
    await setupMirror();
    const abs = join(mirrorRoot, "outputs", "r.bin");
    const content = Buffer.from([0x00, 0x01, 0x02]);
    await writeFile(abs, content);
    const run = await syncRunCentral(c, { userId: "U1", nodeId: NODE_ID });
    assert.equal(run.adopted.length, 1);
    const remote = c.bytes.get(posix.join(NODE_ROOT, "outputs/r.bin"));
    assert.deepEqual(remote, content);
    const st = await getFileState(run.adopted[0].file_id);
    assert.equal(st?.last_synced_hash, sha(content));
  });

  it("pull writes remote bytes and refuses to clobber dirty local without force", async () => {
    const c = new FakeCentral();
    await setupMirror();
    const id = c.seedRemote("wip/doc.md", "remote v1");
    const scan = await statusScanCentral(c, { userId: "U1", nodeId: NODE_ID });
    const entry = scan.pull_candidates[0];
    const r = await pullFileCentral(c, { userId: "U1", nodeId: NODE_ID, entry });
    assert.equal(await readFile(r.local_path, "utf8"), "remote v1");
    assert.equal(r.file_id, id);

    // Local diverges AND remote moves -> pull must refuse without force.
    await writeFile(r.local_path, "local edit");
    c.bytes.set(posix.join(NODE_ROOT, "wip/doc.md"), Buffer.from("remote v2"));
    await assert.rejects(
      () => pullFileCentral(c, { userId: "U1", nodeId: NODE_ID, entry }),
      /local changes/,
    );
    // Force overwrites.
    await pullFileCentral(c, { userId: "U1", nodeId: NODE_ID, entry, force: true });
    assert.equal(await readFile(r.local_path, "utf8"), "remote v2");
  });

  it("push conflict: remote moved after scan is caught, not clobbered", async () => {
    const c = new FakeCentral();
    await setupMirror();
    const abs = join(mirrorRoot, "wip", "a.md");
    await writeFile(abs, "v1");
    await syncRunCentral(c, { userId: "U1", nodeId: NODE_ID });
    // Local edit; remote moves underneath.
    await writeFile(abs, "v2-local");
    c.bytes.set(posix.join(NODE_ROOT, "wip/a.md"), Buffer.from("v2-remote"));
    const run = await syncRunCentral(c, { userId: "U1", nodeId: NODE_ID });
    // The scan itself already classifies it conflict -- nothing pushed.
    assert.equal(run.pushed.length, 0);
    assert.equal(run.conflicts.length, 1);
    assert.equal(
      c.bytes.get(posix.join(NODE_ROOT, "wip/a.md"))?.toString(),
      "v2-remote",
    );
  });

  it("sync run's scan sees the sweep's new record -- the sweep must run before loadNodeContext", async () => {
    const fake = new FakeCentral();
    await setupMirror();
    const remotePath = posix.join(NODE_ROOT, "outputs/report.md");
    const content = Buffer.from("swept in from remote");
    fake.sweepResult = {
      adopted: [{ file_id: "F9", filename: "report.md", remote_path: remotePath }],
      deleted_on_remote: [],
      errors: [],
      repaired: [],
      pending_repairs: [],
    };
    fake.sweepBytes.set(remotePath, content);
    const r = await syncRunCentral(fake, { userId: "U1", nodeId: NODE_ID });
    assert.equal(fake.sweepCalls, 1);
    assert.deepEqual(r.adopted_remote, [{ file_id: "F9", filename: "report.md" }]);
    // FakeCentral.remoteSweep() only puts the "F9" record + bytes into
    // fake.records/fake.bytes when it runs -- FakeCentral.syncInfo() is a
    // live snapshot of that state at call time, with no caching of its own.
    // So the scan classifying this file as a pull, and this same run
    // pulling it down to disk, is only possible if loadNodeContext's
    // syncInfo() call happened AFTER remoteSweep() ran, not before.
    // Swapping the two lines in syncRunCentral makes this assertion fail
    // (pulled stays empty, the file is never written locally) even though
    // the assertions above it still pass.
    assert.deepEqual(r.pulled, [{ file_id: "F9", filename: "report.md" }]);
    const localPath = join(mirrorRoot, "outputs", "report.md");
    assert.equal(await readFile(localPath, "utf8"), "swept in from remote");
  });

  // The sweep is an ADDITION to the teammate sync run, so a central server
  // that refuses it (a write-scope teammate against a manage-gated route ->
  // 403) or does not know the route yet (desktop updated before the VPS ->
  // 404) must degrade to the pre-branch behaviour, not take the whole run
  // down. Anything that is not a CentralHttpError (a bug in our own code)
  // still propagates.
  for (const [status, code] of [
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
  ] as const) {
    it(`a sweep rejected with ${status} degrades to an empty sweep and the run still pushes`, async () => {
      const fake = new FakeCentral();
      await setupMirror();
      fake.sweepError = new CentralHttpError(`sweep ${status}`, status, code);
      await writeFile(join(mirrorRoot, "wip", "a.md"), "local only");

      const r = await syncRunCentral(fake, { userId: "U1", nodeId: NODE_ID });

      assert.equal(r.adopted.length, 1, "the adopt/push half of the run must still happen");
      assert.equal(
        fake.bytes.get(posix.join(NODE_ROOT, "wip/a.md"))?.toString(),
        "local only",
      );
      assert.equal(r.sweep_errors.length, 1);
      assert.match(r.sweep_errors[0].error, new RegExp(String(status)));
    });
  }

  it("a non-CentralHttpError from the sweep still fails the run", async () => {
    const fake = new FakeCentral();
    await setupMirror();
    fake.sweepError = new TypeError("undefined is not a function");
    await assert.rejects(
      () => syncRunCentral(fake, { userId: "U1", nodeId: NODE_ID }),
      /undefined is not a function/,
    );
  });
});

describe("reconcilePathCentral", () => {
  it("registers a new file, rehashes a change, clears cache on delete", async () => {
    const c = new FakeCentral();
    await setupMirror();
    const abs = join(mirrorRoot, "wip", "w.md");
    await writeFile(abs, "v1");

    const r1 = await reconcilePathCentral(c, { userId: "U1", nodeId: NODE_ID, absPath: abs });
    assert.equal(r1.action, "registered");

    await writeFile(abs, "v2");
    const r2 = await reconcilePathCentral(c, { userId: "U1", nodeId: NODE_ID, absPath: abs });
    assert.equal(r2.action, "rehashed");

    await rm(abs);
    // Never pushed (registered only): deletion unregisters the record
    // entirely -- one user action, one outcome.
    const r3 = await reconcilePathCentral(c, { userId: "U1", nodeId: NODE_ID, absPath: abs });
    assert.equal(r3.action, "unregistered");
    assert.equal(await getFileState(r3.file_id as string), null);
    assert.equal(c.records.size, 0);
  });

  it("deletion of a PUSHED file keeps the record and clears the cache (deleted)", async () => {
    const c = new FakeCentral();
    await setupMirror();
    const abs = join(mirrorRoot, "wip", "w.md");
    await writeFile(abs, "v1");
    await syncRunCentral(c, { userId: "U1", nodeId: NODE_ID });

    await rm(abs);
    const r = await reconcilePathCentral(c, { userId: "U1", nodeId: NODE_ID, absPath: abs });
    assert.equal(r.action, "deleted");
    const st = await getFileState(r.file_id as string);
    assert.equal(st?.cached_local_hash, null);
    assert.ok(st?.last_synced_hash);
    assert.equal(c.records.size, 1); // remote copy + record intentionally kept
  });

  it("ignores paths outside tracked sections", async () => {
    const c = new FakeCentral();
    await setupMirror();
    const abs = join(mirrorRoot, "README.md");
    await writeFile(abs, "x");
    const r = await reconcilePathCentral(c, { userId: "U1", nodeId: NODE_ID, absPath: abs });
    assert.equal(r.action, "ignored");
  });
});

describe("computeSyncPendingCentral", () => {
  it("aggregates pending work across mirrors with node names", async () => {
    const c = new FakeCentral();
    await setupMirror();
    await writeFile(join(mirrorRoot, "wip", "pending.md"), "x");
    const r = await computeSyncPendingCentral(c, "U1");
    assert.equal(r.total, 1);
    assert.equal(r.nodes[0].node_name, "Stan GWS");
    assert.equal(r.nodes[0].untracked, 1);
  });

  it("a node whose only pending files are deleted_local is absent, total 0", async () => {
    const c = new FakeCentral();
    await setupMirror();
    const abs = join(mirrorRoot, "wip", "a.md");
    await writeFile(abs, "v1");
    await syncRunCentral(c, { userId: "U1", nodeId: NODE_ID });
    await rm(abs);
    await reconcilePathCentral(c, { userId: "U1", nodeId: NODE_ID, absPath: abs });

    const r = await computeSyncPendingCentral(c, "U1");

    assert.equal(r.nodes.find((n) => n.node_id === NODE_ID), undefined);
    assert.equal(r.total, 0);
  });

  it("matches the local engine's total rule: push counts, deleted_local does not", async () => {
    const c = new FakeCentral();
    await setupMirror();
    const gone = join(mirrorRoot, "wip", "gone.md");
    await writeFile(gone, "v1");
    await syncRunCentral(c, { userId: "U1", nodeId: NODE_ID });
    await rm(gone);
    await reconcilePathCentral(c, { userId: "U1", nodeId: NODE_ID, absPath: gone });
    await writeFile(join(mirrorRoot, "outputs", "new.md"), "local only");
    await registerLocalFileCentral(c, {
      userId: "U1",
      nodeId: NODE_ID,
      localPath: join(mirrorRoot, "outputs", "new.md"),
    });

    const r = await computeSyncPendingCentral(c, "U1");

    const node = r.nodes.find((n) => n.node_id === NODE_ID);
    assert.ok(node);
    assert.equal(node.deleted_local, 1);
    assert.equal(node.total, node.push);
    assert.ok(node.push >= 1);
  });

  it("skips a mirror whose root directory was removed from disk", async () => {
    const c = new FakeCentral();
    await setupMirror();
    await writeFile(join(mirrorRoot, "wip", "draft.md"), "x");
    await rm(mirrorRoot, { recursive: true, force: true });

    const r = await computeSyncPendingCentral(c, "U1");

    assert.equal(r.nodes.find((n) => n.node_id === NODE_ID), undefined);
    assert.equal(r.total, 0);
  });
});

describe("createMirrorForNodeCentral", () => {
  it("creates the standard folder layout and registers the mirror", async () => {
    const c = new FakeCentral();
    const r = await createMirrorForNodeCentral(c, "U1", { nodeId: NODE_ID });
    assert.equal(r.created, true);
    assert.equal(r.local_path, mirrorRoot);
    // Folders exist.
    for (const s of ["wip", "outputs", "resources"]) {
      const st = await import("node:fs/promises").then((fs) => fs.stat(join(mirrorRoot, s)));
      assert.ok(st.isDirectory());
    }
    // Idempotent second call.
    const r2 = await createMirrorForNodeCentral(c, "U1", { nodeId: NODE_ID });
    assert.equal(r2.created, false);
    assert.equal(r2.local_path, mirrorRoot);
  });

  it("maps a central 404 to NODE_NOT_FOUND", async () => {
    const c = new FakeCentral();
    await assert.rejects(
      () => createMirrorForNodeCentral(c, "U1", { nodeId: "NOPE" }),
      (e: unknown) => e instanceof MirrorCreateError && e.code === "NODE_NOT_FOUND",
    );
  });
});

describe("storeFileCentral copy-in + section routing", () => {
  it("copies an outside-mirror source into wip/ and pushes it", async () => {
    const c = new FakeCentral();
    await setupMirror();
    const external = join(workspace, "external-note.md");
    await writeFile(external, "outside content");

    const res = await storeFileCentral(c, {
      userId: "U1",
      nodeId: NODE_ID,
      localPath: external,
      status: "wip",
    });

    // Pushed at wip/<name>, and the file now lives inside the mirror.
    assert.equal(res.remote_path, posix.join(NODE_ROOT, "wip/external-note.md"));
    assert.equal(res.local_path, join(mirrorRoot, "wip", "external-note.md"));
    assert.equal(await readFile(res.local_path, "utf8"), "outside content");
    assert.ok(c.bytes.has(posix.join(NODE_ROOT, "wip/external-note.md")));
    // Original outside source is untouched (copy, not move).
    assert.equal(await readFile(external, "utf8"), "outside content");
  });

  it("routes status:output to the outputs/ section (server derives status from path)", async () => {
    const c = new FakeCentral();
    await setupMirror();
    const external = join(workspace, "report.md");
    await writeFile(external, "final");

    const res = await storeFileCentral(c, {
      userId: "U1",
      nodeId: NODE_ID,
      localPath: external,
      status: "output",
    });

    assert.equal(res.remote_path, posix.join(NODE_ROOT, "outputs/report.md"));
    // The mock's registerFile derives status from the section, exactly like
    // the real registerFileRecordRemote -- confirms status sticks via routing.
    assert.equal(
      c.records.get(posix.join(NODE_ROOT, "outputs/report.md"))?.status,
      "output",
    );
  });

  it("honours subpath for an outside source", async () => {
    const c = new FakeCentral();
    await setupMirror();
    const external = join(workspace, "deep.md");
    await writeFile(external, "x");

    const res = await storeFileCentral(c, {
      userId: "U1",
      nodeId: NODE_ID,
      localPath: external,
      status: "wip",
      subpath: "sub/dir",
    });

    assert.equal(res.remote_path, posix.join(NODE_ROOT, "wip/sub/dir/deep.md"));
    assert.equal(res.local_path, join(mirrorRoot, "wip", "sub", "dir", "deep.md"));
  });

  it("stores an already-in-mirror file without duplicating it", async () => {
    const c = new FakeCentral();
    await setupMirror();
    const inside = join(mirrorRoot, "wip", "already.md");
    await writeFile(inside, "here");

    const res = await storeFileCentral(c, {
      userId: "U1",
      nodeId: NODE_ID,
      localPath: inside,
    });

    assert.equal(res.remote_path, posix.join(NODE_ROOT, "wip/already.md"));
    assert.equal(res.local_path, inside);
    assert.equal(await readFile(inside, "utf8"), "here");
  });
});
