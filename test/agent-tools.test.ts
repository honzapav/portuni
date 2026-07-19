import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
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
  snapshotForDiskMutation,
  applyLocalAfterProxiedMutation,
} from "../apps/server/mcp/agent-tools.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import {
  resetLocalDbForTests,
  upsertFileState,
  getFileState,
} from "../apps/server/domain/sync/local-db.js";
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

  neighbours: string[] = [];
  async nodeNeighbours(_nodeId: string): Promise<string[]> {
    return this.neighbours;
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

  it("scans across all mirrors when no node_id is given (cross-mirror)", async () => {
    const fake = new FakeCentral();
    await setupMirror();
    await writeFile(join(mirrorRoot, "wip", "loose.txt"), "x");
    // No node_id: fans out over the user's mirror registry and aggregates.
    const r = await callLocalTool(fake, "U1", "portuni_status", {});
    assert.notEqual(r.isError, true);
    const payload = JSON.parse(r.content[0].text);
    assert.equal(payload.new_local.length, 1);
    assert.ok(Array.isArray(payload.clean));
    assert.ok(Array.isArray(payload.moved));
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

  it("stores cleanly and ignores a legacy description arg (field was removed)", async () => {
    const fake = new FakeCentral();
    await setupMirror();
    const abs = join(mirrorRoot, "wip", "meta.md");
    await writeFile(abs, "x");
    const r = await callLocalTool(fake, "U1", "portuni_store", {
      node_id: NODE_ID,
      local_path: abs,
      description: "no longer a thing",
    });
    assert.notEqual(r.isError, true);
    const payload = JSON.parse(r.content[0].text);
    assert.ok(payload.file_id);
    assert.equal(fake.bytes.get(posix.join(NODE_ROOT, "wip/meta.md"))?.toString(), "x");
    // description is gone: no such field on the result, no leftover note.
    assert.equal(payload.description, undefined);
    assert.equal(payload.note, undefined);
  });

  it("copies a source outside the mirror into the routed section and pushes it", async () => {
    const fake = new FakeCentral();
    await setupMirror();
    const outside = join(workspace, "external.md");
    await writeFile(outside, "outside the mirror");
    const r = await callLocalTool(fake, "U1", "portuni_store", {
      node_id: NODE_ID,
      local_path: outside,
      status: "wip",
    });
    assert.notEqual(r.isError, true);
    const payload = JSON.parse(r.content[0].text);
    assert.equal(payload.remote_path, posix.join(NODE_ROOT, "wip/external.md"));
    assert.equal(payload.local_path, join(mirrorRoot, "wip", "external.md"));
    assert.equal(
      fake.bytes.get(posix.join(NODE_ROOT, "wip/external.md"))?.toString(),
      "outside the mirror",
    );
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

  it("honours `paths`: adopts only matching untracked files", async () => {
    const fake = new FakeCentral();
    await setupMirror();
    await writeFile(join(mirrorRoot, "wip", "keep.md"), "adopt me");
    await writeFile(join(mirrorRoot, "wip", "ignore.md"), "leave me");
    const r = await callLocalTool(fake, "U1", "portuni_adopt_files", {
      node_id: NODE_ID,
      paths: ["wip/keep.md"],
    });
    const payload = JSON.parse(r.content[0].text);
    assert.equal(payload.adopted.length, 1);
    assert.equal(payload.adopted[0].filename, "keep.md");
    assert.equal("note" in payload, false);
    assert.equal("not_found" in payload, false);
  });

  it("reports requested paths that match no untracked file as not_found", async () => {
    const fake = new FakeCentral();
    await setupMirror();
    await writeFile(join(mirrorRoot, "wip", "loose.txt"), "adopt me");
    const r = await callLocalTool(fake, "U1", "portuni_adopt_files", {
      node_id: NODE_ID,
      // Full remote-path form (as the local tool takes) still matches by suffix;
      // this one genuinely is not present.
      paths: [posix.join(NODE_ROOT, "wip/nope.md")],
    });
    const payload = JSON.parse(r.content[0].text);
    assert.equal(payload.adopted.length, 0);
    assert.deepEqual(payload.not_found, [posix.join(NODE_ROOT, "wip/nope.md")]);
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
    const fake = new FakeCentral(); // no neighbours -> seed set is {home}
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
    const out = await enrichGetContextResult(fake, "U1", NODE_ID, result);
    const payload = JSON.parse(out.content[0].text as string);
    assert.equal(payload.root.local_path, mirrorRoot);
    assert.equal(payload.connected[0].local_path, mirrorRoot);
    // Non-seed node stays null (not readable under the sandbox).
    assert.equal(payload.connected[1].local_path, null);
  });

  it("fills a depth-1 neighbour's local_path with its OWN real mirror", async () => {
    const fake = new FakeCentral();
    const neighbourId = "N00000000000000000NEIGHB";
    fake.neighbours = [neighbourId]; // central reports it as a depth-1 neighbour
    await setupMirror();
    const neighbourDir = join(workspace, ORG_KEY, "areas", "lidi");
    await mkdir(neighbourDir, { recursive: true });
    await registerMirror("U1", neighbourId, neighbourDir);
    const result = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            root: { id: NODE_ID, local_path: null, depth: 0 },
            connected: [{ id: neighbourId, local_path: null, depth: 1 }],
          }),
        },
      ],
    };
    const out = await enrichGetContextResult(fake, "U1", NODE_ID, result);
    const payload = JSON.parse(out.content[0].text as string);
    assert.equal(payload.connected[0].local_path, neighbourDir);
  });

  it("is a no-op when there is no home node id", async () => {
    const fake = new FakeCentral();
    await setupMirror();
    const result = {
      content: [{ type: "text", text: JSON.stringify({ root: { id: NODE_ID, local_path: null } }) }],
    };
    const out = await enrichGetContextResult(fake, "U1", null, result);
    const payload = JSON.parse(out.content[0].text as string);
    assert.equal(payload.root.local_path, null);
  });

  it("passes error results through untouched", async () => {
    const fake = new FakeCentral();
    const result = { content: [{ type: "text", text: "boom" }], isError: true };
    const out = await enrichGetContextResult(fake, "U1", NODE_ID, result);
    assert.equal(out, result);
  });
});

// GH #78: proxied disk mutations (delete/move/rename_folder) run their
// remote/record step on central, whose local disk step no-ops (no mirror on
// the server). The front door snapshots the affected record(s) before the
// proxy and applies the disk step on this device after a successful result.
describe("proxied disk mutations (GH #78)", () => {
  it("applies the local rm + file_state cleanup after a confirmed delete", async () => {
    const fake = new FakeCentral();
    await setupMirror();
    const abs = join(mirrorRoot, "wip", "a.md");
    await writeFile(abs, "obsah");
    const fileId = fake.seedRemote("wip/a.md", "obsah");
    await upsertFileState({
      file_id: fileId,
      last_synced_hash: sha(Buffer.from("obsah")),
      cached_local_hash: sha(Buffer.from("obsah")),
      cached_mtime: 1,
      cached_size: 5,
    });

    const args = { file_id: fileId, confirmed: true };
    const snapshot = await snapshotForDiskMutation(fake, "U1", "portuni_delete_file", args);
    assert.ok(snapshot);
    // Central applied the delete: record gone, success payload returned.
    fake.records.delete(posix.join(NODE_ROOT, "wip/a.md"));
    await applyLocalAfterProxiedMutation(
      fake,
      "U1",
      snapshot!,
      JSON.stringify({ file_id: fileId, mode: "complete", deleted_at: "now", status: "ok" }),
    );
    await assert.rejects(() => readFile(abs));
    assert.equal(await getFileState(fileId), null);
  });

  it("does not snapshot an unconfirmed (preview) call", async () => {
    const fake = new FakeCentral();
    await setupMirror();
    const fileId = fake.seedRemote("wip/a.md", "obsah");
    const snapshot = await snapshotForDiskMutation(fake, "U1", "portuni_delete_file", {
      file_id: fileId,
    });
    assert.equal(snapshot, null);
  });

  it("leaves the disk alone when the central result is not a success payload", async () => {
    const fake = new FakeCentral();
    await setupMirror();
    const abs = join(mirrorRoot, "wip", "a.md");
    await writeFile(abs, "obsah");
    const fileId = fake.seedRemote("wip/a.md", "obsah");
    const snapshot = await snapshotForDiskMutation(fake, "U1", "portuni_delete_file", {
      file_id: fileId,
      confirmed: true,
    });
    await applyLocalAfterProxiedMutation(
      fake,
      "U1",
      snapshot!,
      JSON.stringify({ status: "repair_needed", detail: { phase: "remote" } }),
    );
    assert.equal((await readFile(abs, "utf8")), "obsah");
  });

  it("renames the local copy after a confirmed same-node move", async () => {
    const fake = new FakeCentral();
    await setupMirror();
    const abs = join(mirrorRoot, "wip", "a.md");
    await writeFile(abs, "obsah");
    const fileId = fake.seedRemote("wip/a.md", "obsah");

    const args = { file_id: fileId, new_section: "outputs", confirmed: true };
    const snapshot = await snapshotForDiskMutation(fake, "U1", "portuni_move_file", args);
    assert.ok(snapshot);
    // Central moved the record.
    const newRemote = posix.join(NODE_ROOT, "outputs/a.md");
    fake.records.delete(posix.join(NODE_ROOT, "wip/a.md"));
    fake.records.set(newRemote, { id: fileId, filename: "a.md", status: "output", is_native_format: false });
    await applyLocalAfterProxiedMutation(
      fake,
      "U1",
      snapshot!,
      JSON.stringify({
        status: "ok",
        file_id: fileId,
        new_remote_name: "test-fs",
        new_remote_path: newRemote,
        new_local_path: null,
        moved_at: "now",
      }),
    );
    await assert.rejects(() => readFile(abs));
    assert.equal(await readFile(join(mirrorRoot, "outputs", "a.md"), "utf8"), "obsah");
  });

  it("renames every affected local file after an applied rename_folder", async () => {
    const fake = new FakeCentral();
    await setupMirror();
    await mkdir(join(mirrorRoot, "wip", "old"), { recursive: true });
    const absA = join(mirrorRoot, "wip", "old", "a.md");
    const absB = join(mirrorRoot, "wip", "old", "b.md");
    await writeFile(absA, "A");
    await writeFile(absB, "B");
    fake.seedRemote("wip/old/a.md", "A");
    fake.seedRemote("wip/old/b.md", "B");

    const args = { node_id: NODE_ID, old_prefix: "wip/old", new_prefix: "wip/new", confirmed: true };
    const snapshot = await snapshotForDiskMutation(fake, "U1", "portuni_rename_folder", args);
    assert.ok(snapshot);
    await applyLocalAfterProxiedMutation(
      fake,
      "U1",
      snapshot!,
      JSON.stringify({
        type: "applied",
        renamed: 2,
        failed: 0,
        files: [
          {
            file_id: "F1",
            status: "ok",
            old_remote_path: posix.join(NODE_ROOT, "wip/old/a.md"),
            new_remote_path: posix.join(NODE_ROOT, "wip/new/a.md"),
          },
          {
            file_id: "F2",
            status: "ok",
            old_remote_path: posix.join(NODE_ROOT, "wip/old/b.md"),
            new_remote_path: posix.join(NODE_ROOT, "wip/new/b.md"),
          },
        ],
      }),
    );
    assert.equal(await readFile(join(mirrorRoot, "wip", "new", "a.md"), "utf8"), "A");
    assert.equal(await readFile(join(mirrorRoot, "wip", "new", "b.md"), "utf8"), "B");
    await assert.rejects(() => readFile(absA));
  });
});
