import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { CentralClient } from "../apps/server/domain/sync/central/client.js";
import { CentralHttpError } from "../apps/server/domain/sync/central/client.js";
import {
  LOCAL_TOOLS,
  callLocalTool,
  enrichGetNodeResult,
  enrichGetContextResult,
} from "../apps/server/mcp/agent-tools.js";
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

  async nodeNeighbours(_nodeId: string): Promise<string[]> {
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

  it("honors include_discovery: false (no new_local scan)", async () => {
    const fake = new FakeCentral();
    await setupMirror();
    await writeFile(join(mirrorRoot, "wip", "loose.txt"), "x");
    const r = await callLocalTool(fake, "U1", "portuni_status", {
      node_id: NODE_ID,
      include_discovery: false,
    });
    const payload = JSON.parse(r.content[0].text);
    assert.equal(payload.new_local.length, 0);
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

  it("fails loudly when description is passed (agent plane cannot persist it)", async () => {
    const fake = new FakeCentral();
    await setupMirror();
    const abs = join(mirrorRoot, "wip", "meta.md");
    await writeFile(abs, "x");
    const r = await callLocalTool(fake, "U1", "portuni_store", {
      node_id: NODE_ID,
      local_path: abs,
      description: "will be lost",
    });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /not supported by the agent plane/);
    // Nothing was registered or pushed.
    assert.equal(fake.records.size, 0);
  });

  it("fails loudly for a source path outside the mirror sections", async () => {
    const fake = new FakeCentral();
    await setupMirror();
    const outside = join(workspace, "external.md");
    await writeFile(outside, "outside the mirror");
    const r = await callLocalTool(fake, "U1", "portuni_store", {
      node_id: NODE_ID,
      local_path: outside,
    });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /not supported by the agent plane/);
    assert.equal(fake.records.size, 0);
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
    // Payload contract matches the local tool when paths is empty.
    assert.equal("note" in payload, false);
  });

  it("surfaces a note when caller-provided paths are ignored", async () => {
    const fake = new FakeCentral();
    await setupMirror();
    await writeFile(join(mirrorRoot, "wip", "loose.txt"), "adopt me");
    const r = await callLocalTool(fake, "U1", "portuni_adopt_files", {
      node_id: NODE_ID,
      paths: [posix.join(NODE_ROOT, "wip/some-remote-file.md")],
    });
    const payload = JSON.parse(r.content[0].text);
    assert.equal(payload.adopted.length, 1);
    assert.match(payload.note, /ignores `paths`/);
  });
});

describe("enrichGetNodeResult", () => {
  it("fills local_mirror from the device registry", async () => {
    const fake = new FakeCentral();
    await setupMirror();
    const result = {
      content: [
        { type: "text", text: JSON.stringify({ id: NODE_ID, name: "G", local_mirror: null }) },
      ],
    };
    const out = await enrichGetNodeResult(fake, "U1", null, result);
    const node = JSON.parse(out.content[0].text as string);
    assert.equal(node.local_mirror.local_path, mirrorRoot);
    assert.equal(typeof node.local_mirror.registered_at, "string");
  });

  it("leaves local_mirror null when the node is unregistered", async () => {
    const fake = new FakeCentral();
    const result = {
      content: [
        { type: "text", text: JSON.stringify({ id: NODE_ID, name: "G", local_mirror: null }) },
      ],
    };
    const out = await enrichGetNodeResult(fake, "U1", null, result);
    const node = JSON.parse(out.content[0].text as string);
    assert.equal(node.local_mirror, null);
  });

  it("does not clobber an already-populated local_mirror", async () => {
    const fake = new FakeCentral();
    await setupMirror();
    const result = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            id: NODE_ID,
            local_mirror: { local_path: "/pre/existing", registered_at: "x" },
          }),
        },
      ],
    };
    const out = await enrichGetNodeResult(fake, "U1", null, result);
    const node = JSON.parse(out.content[0].text as string);
    assert.equal(node.local_mirror.local_path, "/pre/existing");
  });

  it("derives home-node file local_paths from the real mirror", async () => {
    const fake = new FakeCentral();
    await setupMirror();
    const reg = await fake.registerFile(NODE_ID, "wip/a.md");
    const result = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            id: NODE_ID,
            local_mirror: null,
            files: [{ id: reg.id, filename: "a.md", local_path: null }],
          }),
        },
      ],
    };
    // homeNodeId === NODE_ID -> the node is the session home, so its mirror is
    // readable and file paths are derived.
    const out = await enrichGetNodeResult(fake, "U1", NODE_ID, result);
    const node = JSON.parse(out.content[0].text as string);
    assert.equal(node.files[0].local_path, join(mirrorRoot, "wip", "a.md"));
  });

  it("leaves file local_paths null for a non-home node", async () => {
    const fake = new FakeCentral();
    await setupMirror();
    const reg = await fake.registerFile(NODE_ID, "wip/a.md");
    const result = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            id: NODE_ID,
            local_mirror: null,
            files: [{ id: reg.id, filename: "a.md", local_path: null }],
          }),
        },
      ],
    };
    // homeNodeId is a different node -> not readable under the sandbox, so no
    // file paths are surfaced even though the mirror exists on disk.
    const out = await enrichGetNodeResult(fake, "U1", "N00000000000000000000OTHER", result);
    const node = JSON.parse(out.content[0].text as string);
    assert.equal(node.files[0].local_path, null);
  });

  it("passes error results through untouched", async () => {
    const fake = new FakeCentral();
    const result = { content: [{ type: "text", text: "boom" }], isError: true };
    const out = await enrichGetNodeResult(fake, "U1", null, result);
    assert.equal(out, result);
  });

  it("passes non-JSON text through untouched", async () => {
    const fake = new FakeCentral();
    const result = { content: [{ type: "text", text: "not json" }] };
    const out = await enrichGetNodeResult(fake, "U1", null, result);
    assert.equal(out.content[0].text, "not json");
  });
});

describe("enrichGetContextResult", () => {
  it("fills the home node's local_path as root and as a connected node", async () => {
    await setupMirror();
    const result = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            root: { id: NODE_ID, local_path: null, depth: 0 },
            connected: [
              { id: NODE_ID, local_path: null, depth: 1 },
              { id: "N00000000000000000000OTHER", local_path: null, depth: 1 },
            ],
          }),
        },
      ],
    };
    const out = await enrichGetContextResult("U1", NODE_ID, result);
    const payload = JSON.parse(out.content[0].text as string);
    assert.equal(payload.root.local_path, mirrorRoot);
    assert.equal(payload.connected[0].local_path, mirrorRoot);
    // Non-home node stays null (not readable under the sandbox).
    assert.equal(payload.connected[1].local_path, null);
  });

  it("is a no-op when there is no home node id", async () => {
    await setupMirror();
    const result = {
      content: [{ type: "text", text: JSON.stringify({ root: { id: NODE_ID, local_path: null } }) }],
    };
    const out = await enrichGetContextResult("U1", null, result);
    const payload = JSON.parse(out.content[0].text as string);
    assert.equal(payload.root.local_path, null);
  });

  it("passes error results through untouched", async () => {
    const result = { content: [{ type: "text", text: "boom" }], isError: true };
    const out = await enrichGetContextResult("U1", NODE_ID, result);
    assert.equal(out, result);
  });
});
