import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { CentralClient } from "../apps/server/domain/sync/central/client.js";
import { CentralHttpError } from "../apps/server/domain/sync/central/client.js";
import { LOCAL_TOOLS, callLocalTool } from "../apps/server/mcp/agent-tools.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import type { NodeSyncInfo } from "../apps/server/domain/sync/sync-remote-api.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const NODE_ID = "N000000000000000000000PROJ";
const ORG_KEY = "workflow";
const NODE_KEY = "stan-gws";
const NODE_ROOT = posix.join(ORG_KEY, "projects", NODE_KEY);

// Same fake-central pattern as test/engine-central.test.ts -- an in-memory
// stand-in for the central server's file registry + byte store.
class FakeCentral implements CentralClient {
  records = new Map<
    string,
    { id: string; filename: string; status: string; is_native_format: boolean }
  >();
  bytes = new Map<string, Buffer>();
  nextId = 1;
  nodeName = "Stan GWS";
  nodeType = "project";
  exists = true;

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
    if (nodeId !== NODE_ID || !this.exists) {
      throw new CentralHttpError("not found", 404, "NOT_FOUND");
    }
    return this.info();
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

  async registerFiles(nodeId: string, relPaths: string[]) {
    const out = [];
    for (const rel of relPaths) out.push(await this.registerFile(nodeId, rel));
    return out;
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
    opts?: { baseCanonicalHash?: string; ifAbsent?: boolean; force?: boolean },
  ) {
    const remotePath = posix.join(NODE_ROOT, relPath);
    const cur = this.bytes.get(remotePath);
    if (opts?.ifAbsent && cur) {
      throw new CentralHttpError("exists", 409, "EXISTS");
    }
    if (opts?.baseCanonicalHash && !opts.force && cur && sha(cur) !== opts.baseCanonicalHash) {
      throw new CentralHttpError("changed", 409, "CONFLICT", sha(cur));
    }
    this.bytes.set(remotePath, Buffer.from(bytes));
    return { version: sha(bytes), canonicalHash: sha(bytes) };
  }

  async dataSources() {
    return [];
  }

  async nodeExists(nodeId: string) {
    return nodeId === NODE_ID && this.exists;
  }

  invalidateSyncInfo(_nodeId: string): void {
    /* fake has no cache */
  }

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
  workspace = await mkdtemp(join(tmpdir(), "portuni-agent-tools-"));
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

test("LOCAL_TOOLS contains exactly the device-local set", () => {
  assert.deepEqual(
    [...LOCAL_TOOLS].sort(),
    ["portuni_adopt_files", "portuni_mirror", "portuni_pull", "portuni_status", "portuni_store"],
  );
});

test("callLocalTool rejects non-local names", async () => {
  await assert.rejects(
    () => callLocalTool({} as never, "u1", "portuni_get_node", {}),
    /not a local tool/,
  );
});

test("portuni_mirror returns the REST-shaped payload", async () => {
  const fake = new FakeCentral();
  const r = await callLocalTool(fake, "U1", "portuni_mirror", {
    node_id: NODE_ID,
    targets: ["local"],
  });
  const payload = JSON.parse(r.content[0].text);
  assert.ok("local_path" in payload && "subdirs" in payload);
});

describe("portuni_mirror error wrapping", () => {
  it("wraps MirrorCreateError as isError text, not a throw", async () => {
    const fake = new FakeCentral();
    const r = await callLocalTool(fake, "U1", "portuni_mirror", { node_id: "NOPE" });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /^Error: /);
  });
});

describe("portuni_status", () => {
  it("returns the same bucketed shape as the local tool", async () => {
    const fake = new FakeCentral();
    await setupMirror();
    await writeFile(join(mirrorRoot, "wip", "loose.txt"), "x");
    const r = await callLocalTool(fake, "U1", "portuni_status", { node_id: NODE_ID });
    const payload = JSON.parse(r.content[0].text);
    assert.equal(payload.new_local.length, 1);
    assert.ok(Array.isArray(payload.clean));
    assert.ok(Array.isArray(payload.push_candidates));
  });
});

describe("portuni_store", () => {
  it("registers and pushes a brand-new file, matching StoreFileResult shape", async () => {
    const fake = new FakeCentral();
    await setupMirror();
    const abs = join(mirrorRoot, "wip", "new.md");
    await writeFile(abs, "hello world");
    const r = await callLocalTool(fake, "U1", "portuni_store", {
      node_id: NODE_ID,
      local_path: abs,
    });
    const payload = JSON.parse(r.content[0].text);
    assert.ok(payload.file_id);
    assert.equal(payload.remote_name, "test-fs");
    assert.equal(payload.local_path, abs);
    assert.equal(payload.hash, sha(Buffer.from("hello world")));
    // Bytes actually landed on the fake remote.
    const remote = fake.bytes.get(posix.join(NODE_ROOT, "wip/new.md"));
    assert.equal(remote?.toString(), "hello world");
  });

  it("pushes an update to an already-registered file", async () => {
    const fake = new FakeCentral();
    await setupMirror();
    const abs = join(mirrorRoot, "wip", "a.md");
    await writeFile(abs, "v1");
    await callLocalTool(fake, "U1", "portuni_store", { node_id: NODE_ID, local_path: abs });
    await writeFile(abs, "v2");
    const r = await callLocalTool(fake, "U1", "portuni_store", { node_id: NODE_ID, local_path: abs });
    const payload = JSON.parse(r.content[0].text);
    assert.equal(payload.hash, sha(Buffer.from("v2")));
    assert.equal(fake.bytes.get(posix.join(NODE_ROOT, "wip/a.md"))?.toString(), "v2");
  });
});

describe("portuni_pull", () => {
  it("downloads by file_id", async () => {
    const fake = new FakeCentral();
    await setupMirror();
    const id = fake.seedRemote("wip/doc.md", "remote content");
    const r = await callLocalTool(fake, "U1", "portuni_pull", { file_id: id });
    const payload = JSON.parse(r.content[0].text);
    assert.equal(payload.file_id, id);
    assert.ok(payload.local_path.endsWith(join("wip", "doc.md")));
  });

  it("previews by node_id without modifying anything", async () => {
    const fake = new FakeCentral();
    await setupMirror();
    fake.seedRemote("wip/doc.md", "remote content");
    const r = await callLocalTool(fake, "U1", "portuni_pull", { node_id: NODE_ID });
    const payload = JSON.parse(r.content[0].text);
    assert.ok(Array.isArray(payload.files));
    assert.equal(payload.files.length, 1);
    assert.equal(payload.files[0].status, "updated");
  });
});

describe("portuni_adopt_files", () => {
  it("adopts untracked local files under the node's mirror", async () => {
    const fake = new FakeCentral();
    await setupMirror();
    await writeFile(join(mirrorRoot, "wip", "loose.txt"), "adopt me");
    const r = await callLocalTool(fake, "U1", "portuni_adopt_files", {
      node_id: NODE_ID,
      paths: [],
    });
    const payload = JSON.parse(r.content[0].text);
    assert.equal(payload.adopted.length, 1);
    assert.equal(payload.adopted[0].filename, "loose.txt");
    assert.equal(payload.skipped.length, 0);
  });
});
