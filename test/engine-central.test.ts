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
  pullFileCentral,
  reconcilePathCentral,
  syncRunCentral,
  computeSyncPendingCentral,
  createMirrorForNodeCentral,
} from "../apps/server/domain/sync/central/engine-central.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { resetLocalDbForTests, getFileState } from "../apps/server/domain/sync/local-db.js";
import type { NodeSyncInfo } from "../apps/server/domain/sync/sync-remote-api.js";
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

  async dataSources() {
    return [];
  }

  async nodeExists(nodeId: string) {
    return nodeId === NODE_ID;
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
    const r3 = await reconcilePathCentral(c, { userId: "U1", nodeId: NODE_ID, absPath: abs });
    assert.equal(r3.action, "deleted");
    const st = await getFileState(r3.file_id as string);
    assert.equal(st?.cached_local_hash, null);
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
