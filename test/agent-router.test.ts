import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join, posix, sep } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { startHttpServer, type HttpServerHandle } from "../apps/server/http/server.js";
import { createAgentRouter } from "../apps/server/api/agent-router.js";
import type { CentralClient } from "../apps/server/domain/sync/central/client.js";
import { CentralHttpError } from "../apps/server/domain/sync/central/client.js";
import type { NodeSyncInfo } from "../apps/server/domain/sync/sync-remote-api.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { SOLO_USER } from "../apps/server/infra/schema.js";
import { resetGateCachesForTesting } from "../apps/server/http/middleware.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const NODE_ID = "N000000000000000000000PROJ";
const NODE_ROOT = posix.join("workflow", "projects", "stan-gws");

class FakeCentral implements CentralClient {
  records = new Map<string, { id: string; filename: string; status: string }>();
  bytes = new Map<string, Buffer>();
  nextId = 1;

  async syncInfo(nodeId: string): Promise<NodeSyncInfo> {
    if (nodeId !== NODE_ID) throw new CentralHttpError("not found", 404, "NOT_FOUND");
    return {
      node: {
        id: NODE_ID,
        name: "Stan GWS",
        type: "project",
        sync_key: "stan-gws",
        org_sync_key: "workflow",
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
        is_native_format: false,
        mime_type: null,
      })),
    };
  }

  async registerFile(nodeId: string, relPath: string) {
    if (nodeId !== NODE_ID) throw new CentralHttpError("not found", 404, "NOT_FOUND");
    const remotePath = posix.join(NODE_ROOT, relPath);
    const existing = this.records.get(remotePath);
    if (existing) {
      return { id: existing.id, filename: existing.filename, remote_name: "test-fs", remote_path: remotePath };
    }
    const id = `F${this.nextId++}`;
    const filename = relPath.split("/").pop() as string;
    this.records.set(remotePath, { id, filename, status: "wip" });
    return { id, filename, remote_name: "test-fs", remote_path: remotePath };
  }

  async getFileRaw(_nodeId: string, relPath: string) {
    const b = this.bytes.get(posix.join(NODE_ROOT, relPath));
    if (!b) throw new CentralHttpError("not found", 404, "NOT_FOUND");
    return { bytes: b, version: sha(b), canonicalHash: sha(b) };
  }

  // Precondition-enforcing, same pattern as test/agent-tools.test.ts's
  // FakeCentral -- required so the resolve tests below actually exercise
  // force:true bypassing a stale-hash rejection, rather than a fake that
  // always accepts the write regardless of what precondition was sent.
  async putFileRaw(
    _nodeId: string,
    relPath: string,
    bytes: Buffer,
    opts?: { baseCanonicalHash?: string; ifAbsent?: boolean; force?: boolean },
  ) {
    const remotePath = posix.join(NODE_ROOT, relPath);
    const cur = this.bytes.get(remotePath);
    if (opts?.ifAbsent && !opts.force && cur) {
      throw new CentralHttpError("exists", 409, "EXISTS");
    }
    if (opts?.baseCanonicalHash && !opts.force && cur && sha(cur) !== opts.baseCanonicalHash) {
      throw new CentralHttpError("changed", 409, "CONFLICT", sha(cur));
    }
    this.bytes.set(remotePath, Buffer.from(bytes));
    return { version: sha(bytes), canonicalHash: sha(bytes) };
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

  async dataSources() {
    return [];
  }

  async nodeExists(nodeId: string) {
    return nodeId === NODE_ID;
  }

  // Configurable per test: which neighbour ids central reports for a node.
  neighbours: string[] = [];
  async nodeNeighbours(_nodeId: string): Promise<string[]> {
    return this.neighbours;
  }

  async remoteSweep() {
    return { adopted: [], deleted_on_remote: [], errors: [], repaired: [], pending_repairs: [] };
  }
}

let workspace: string;
let mirrorRoot: string;
let originalEnv: string | undefined;
let originalToken: string | undefined;
let handle: HttpServerHandle;
let base: string;
let fake: FakeCentral;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-agentrouter-"));
  mirrorRoot = join(workspace, "workflow", "projects", "stan-gws");
  originalEnv = process.env.PORTUNI_WORKSPACE_ROOT;
  originalToken = process.env.PORTUNI_AUTH_TOKEN;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  // Loopback + no token = trusted local access (the desktop passes a
  // per-launch token in production; the identity resolution is identical).
  delete process.env.PORTUNI_AUTH_TOKEN;
  resetLocalDbForTests();

  fake = new FakeCentral();
  handle = startHttpServer({
    port: 0,
    host: "127.0.0.1",
    registerSigint: false,
    router: createAgentRouter(fake),
    mountMcp: false,
  });
  if (!handle.server.listening) {
    await new Promise<void>((r) => handle.server.once("listening", r));
  }
  const addr = handle.server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
  // Host allowlist derives from PORT; rebuild it for the OS-assigned port.
  process.env.PORT = String(addr.port);
  resetGateCachesForTesting();
});

afterEach(async () => {
  await handle.shutdown();
  resetGateCachesForTesting();
  resetLocalDbForTests();
  if (originalEnv === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalEnv;
  if (originalToken !== undefined) process.env.PORTUNI_AUTH_TOKEN = originalToken;
  await rm(workspace, { recursive: true, force: true });
});

describe("agent router over HTTP", () => {
  it("POST /nodes/:id/mirror creates the mirror (201) and is idempotent (200)", async () => {
    const r1 = await fetch(`${base}/nodes/${NODE_ID}/mirror`, { method: "POST" });
    assert.equal(r1.status, 201);
    const b1 = (await r1.json()) as { local_path: string; created: boolean };
    assert.equal(b1.created, true);
    assert.equal(b1.local_path, mirrorRoot);

    const r2 = await fetch(`${base}/nodes/${NODE_ID}/mirror`, { method: "POST" });
    assert.equal(r2.status, 200);
  });

  it("GET /nodes/:id/sync-status reports untracked files; POST /sync adopts them", async () => {
    await fetch(`${base}/nodes/${NODE_ID}/mirror`, { method: "POST" });
    await writeFile(join(mirrorRoot, "wip", "a.md"), "hello agent");

    const st1 = await fetch(`${base}/nodes/${NODE_ID}/sync-status`);
    assert.equal(st1.status, 200);
    const s1 = (await st1.json()) as { files: unknown[]; untracked: Array<{ filename: string }> };
    assert.equal(s1.untracked.length, 1);
    assert.equal(s1.untracked[0].filename, "a.md");

    const run = await fetch(`${base}/nodes/${NODE_ID}/sync`, { method: "POST" });
    assert.equal(run.status, 200);
    const r = (await run.json()) as { adopted: unknown[]; errors: unknown[] };
    assert.equal(r.adopted.length, 1);
    assert.equal(r.errors.length, 0);
    // Bytes really landed on the fake central.
    assert.equal(
      fake.bytes.get(posix.join(NODE_ROOT, "wip/a.md"))?.toString(),
      "hello agent",
    );

    const st2 = await fetch(`${base}/nodes/${NODE_ID}/sync-status`);
    const s2 = (await st2.json()) as {
      files: Array<{ sync_class: string }>;
      untracked: unknown[];
    };
    assert.equal(s2.untracked.length, 0);
    assert.equal(s2.files[0].sync_class, "clean");
  });

  it("GET /sync/pending aggregates across mirrors", async () => {
    await fetch(`${base}/nodes/${NODE_ID}/mirror`, { method: "POST" });
    await writeFile(join(mirrorRoot, "wip", "pending.md"), "x");
    const r = await fetch(`${base}/sync/pending`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as { total: number; nodes: Array<{ node_name: string }> };
    assert.equal(body.total, 1);
    assert.equal(body.nodes[0].node_name, "Stan GWS");
  });

  it("unknown node maps to 404; graph routes answer 501 agent_mode", async () => {
    const r404 = await fetch(`${base}/nodes/NOPE/sync-status`);
    assert.equal(r404.status, 404);

    const r501 = await fetch(`${base}/graph`);
    assert.equal(r501.status, 501);
    const body = (await r501.json()) as { error: string };
    assert.equal(body.error, "agent_mode");
  });

  it("GET /nodes/:id/sandbox-profile 409 without mirror, 200 with one", async () => {
    const r409 = await fetch(`${base}/nodes/${NODE_ID}/sandbox-profile`);
    assert.equal(r409.status, 409);

    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    await registerMirror(SOLO_USER, NODE_ID, mirrorRoot);
    const r200 = await fetch(`${base}/nodes/${NODE_ID}/sandbox-profile`);
    assert.equal(r200.status, 200);
    const body = (await r200.json()) as {
      profile: string;
      home_mirror: string;
      session_id: string | null;
    };
    assert.ok(body.profile.includes("(deny default)") || body.profile.length > 0);
    assert.ok(body.session_id, "session_id is minted even in central mode (#208 follow-up)");

    // Central mode has no db, so it must never trust a caller-supplied
    // resumeSessionId for the narrowing -- every call mints its own fresh id.
    const r200Again = await fetch(`${base}/nodes/${NODE_ID}/sandbox-profile`);
    const bodyAgain = (await r200Again.json()) as { session_id: string | null };
    assert.notEqual(body.session_id, bodyAgain.session_id);
  });

  it("grants central depth-1 neighbour real mirrors in the sandbox profile", async () => {
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    await registerMirror(SOLO_USER, NODE_ID, mirrorRoot);
    // A neighbour node with a local mirror, reported by central node-detail.
    const neighbourId = "N0000000000000000000NEIGH";
    const neighbourDir = join(workspace, "workflow", "areas", "lidi");
    await mkdir(neighbourDir, { recursive: true });
    await registerMirror(SOLO_USER, neighbourId, neighbourDir);
    fake.neighbours = [neighbourId];

    const res = await fetch(`${base}/nodes/${NODE_ID}/sandbox-profile`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { profile: string };
    // The neighbour's REAL mirror is granted read-only, after the deny line.
    const denyIdx = body.profile.indexOf("(deny file-read*");
    const neighIdx = body.profile.indexOf(`${sep}lidi"`);
    assert.ok(denyIdx >= 0 && neighIdx > denyIdx, "neighbour real mirror granted after deny");
    assert.match(body.profile, /\(allow file-read\* \(subpath "[^"]*lidi"\)\)/);
  });

  it("GET /nodes/:id/mirror returns the registered device mirror", async () => {
    await registerMirror(SOLO_USER, NODE_ID, mirrorRoot);
    const res = await fetch(`${base}/nodes/${NODE_ID}/mirror`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      node_id: string;
      local_mirror: { local_path: string; registered_at: string } | null;
    };
    assert.equal(body.node_id, NODE_ID);
    assert.equal(body.local_mirror?.local_path, mirrorRoot);
    assert.equal(typeof body.local_mirror?.registered_at, "string");
  });

  it("GET /nodes/:id/mirror returns null local_mirror when unregistered", async () => {
    const res = await fetch(`${base}/nodes/${NODE_ID}/mirror`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { node_id: string; local_mirror: unknown };
    assert.equal(body.node_id, NODE_ID);
    assert.equal(body.local_mirror, null);
  });

  // File content over the local mirror: the editor/preview must open files
  // that exist only on this device (registered or untracked, not yet pushed).
  it("GET /nodes/:id/file serves an unsynced local file from the mirror", async () => {
    await fetch(`${base}/nodes/${NODE_ID}/mirror`, { method: "POST" });
    await writeFile(join(mirrorRoot, "wip", "draft.md"), "# jen lokálně");

    const res = await fetch(
      `${base}/nodes/${NODE_ID}/file?path=${encodeURIComponent("wip/draft.md")}`,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      content: string;
      version: string;
      filename: string;
      local_path: string | null;
    };
    assert.equal(body.content, "# jen lokálně");
    assert.equal(body.filename, "draft.md");
    assert.equal(body.local_path, join(mirrorRoot, "wip", "draft.md"));
    assert.equal(body.version, sha(Buffer.from("# jen lokálně")));
  });

  it("GET /nodes/:id/file falls back to central when the file is not on disk", async () => {
    await fetch(`${base}/nodes/${NODE_ID}/mirror`, { method: "POST" });
    // Pull-pending: registered on central with bytes, absent locally.
    fake.bytes.set(posix.join(NODE_ROOT, "wip/remote.md"), Buffer.from("remote body"));

    const res = await fetch(
      `${base}/nodes/${NODE_ID}/file?path=${encodeURIComponent("wip/remote.md")}`,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { content: string; local_path: string | null };
    assert.equal(body.content, "remote body");
    assert.equal(body.local_path, null);
  });

  it("GET /nodes/:id/file is 404 when the file exists nowhere", async () => {
    await fetch(`${base}/nodes/${NODE_ID}/mirror`, { method: "POST" });
    const res = await fetch(
      `${base}/nodes/${NODE_ID}/file?path=${encodeURIComponent("wip/missing.md")}`,
    );
    assert.equal(res.status, 404);
  });

  it("PUT /nodes/:id/file writes the local mirror and detects conflicts", async () => {
    await fetch(`${base}/nodes/${NODE_ID}/mirror`, { method: "POST" });
    const abs = join(mirrorRoot, "wip", "edit.md");
    await writeFile(abs, "v1");
    const baseVersion = sha(Buffer.from("v1"));

    const ok = await fetch(
      `${base}/nodes/${NODE_ID}/file?path=${encodeURIComponent("wip/edit.md")}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "v2", baseVersion }),
      },
    );
    assert.equal(ok.status, 200);
    const okBody = (await ok.json()) as { version: string };
    assert.equal(okBody.version, sha(Buffer.from("v2")));

    // Stale baseVersion -> 409 CONFLICT with the current version.
    const conflict = await fetch(
      `${base}/nodes/${NODE_ID}/file?path=${encodeURIComponent("wip/edit.md")}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "v3", baseVersion }),
      },
    );
    assert.equal(conflict.status, 409);
    const cBody = (await conflict.json()) as { code: string; currentVersion: string };
    assert.equal(cBody.code, "CONFLICT");
    assert.equal(cBody.currentVersion, sha(Buffer.from("v2")));
  });

  it("PUT /nodes/:id/file forwards to central when no device mirror exists", async () => {
    const res = await fetch(
      `${base}/nodes/${NODE_ID}/file?path=${encodeURIComponent("wip/away.md")}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "central body" }),
      },
    );
    assert.equal(res.status, 200);
    assert.equal(
      fake.bytes.get(posix.join(NODE_ROOT, "wip/away.md"))?.toString(),
      "central body",
    );
  });
});

describe("POST /nodes/:id/files/:fileId/resolve (agent mode)", () => {
  async function seedConflict(filename: string): Promise<string> {
    await fetch(`${base}/nodes/${NODE_ID}/mirror`, { method: "POST" });
    const abs = join(mirrorRoot, "wip", filename);
    await writeFile(abs, "v1");
    const sync1 = await fetch(`${base}/nodes/${NODE_ID}/sync`, { method: "POST" });
    assert.equal(sync1.status, 200);
    const synced1 = (await sync1.json()) as { adopted: Array<{ file_id: string }> };
    assert.equal(synced1.adopted.length, 1, `expected one adopted file, got ${JSON.stringify(synced1)}`);
    const fileId = synced1.adopted[0].file_id;

    // Both sides changed since the last push -- a real conflict. The
    // FakeCentral's baseCanonicalHash precondition now sees a stale
    // baseline, so an un-forced push/pull would be refused.
    fake.bytes.set(posix.join(NODE_ROOT, `wip/${filename}`), Buffer.from("remote"));
    await writeFile(abs, "local");
    return fileId;
  }

  it("keep_local force-pushes local bytes past a stale remote hash", async () => {
    const fileId = await seedConflict("a.md");

    const r = await fetch(`${base}/nodes/${NODE_ID}/files/${fileId}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "keep_local" }),
    });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { file_id: string; action: string; status: string };
    assert.deepEqual(body, { file_id: fileId, action: "keep_local", status: "ok" });

    assert.equal(
      fake.bytes.get(posix.join(NODE_ROOT, "wip/a.md"))?.toString(),
      "local",
      "remote must now carry the local version",
    );
    assert.equal(
      await readFile(join(mirrorRoot, "wip", "a.md"), "utf8"),
      "local",
      "local copy must be untouched",
    );
  });

  it("take_remote overwrites the local edit with the remote version", async () => {
    const fileId = await seedConflict("b.md");

    const r = await fetch(`${base}/nodes/${NODE_ID}/files/${fileId}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "take_remote" }),
    });
    assert.equal(r.status, 200);

    assert.equal(
      await readFile(join(mirrorRoot, "wip", "b.md"), "utf8"),
      "remote",
      "local copy must now carry the remote version",
    );
    assert.equal(
      fake.bytes.get(posix.join(NODE_ROOT, "wip/b.md"))?.toString(),
      "remote",
      "remote must be untouched",
    );
  });

  it("rejects an unknown action with 400", async () => {
    const fileId = await seedConflict("c.md");

    const r = await fetch(`${base}/nodes/${NODE_ID}/files/${fileId}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "nope" }),
    });
    assert.equal(r.status, 400);
  });

  it("404s for a file id not on any mirror this device has", async () => {
    await fetch(`${base}/nodes/${NODE_ID}/mirror`, { method: "POST" });
    const r = await fetch(`${base}/nodes/${NODE_ID}/files/NOPE/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "keep_local" }),
    });
    assert.equal(r.status, 404);
  });

  it("404s when the file belongs to a different node than the URL (IDOR)", async () => {
    await fetch(`${base}/nodes/${NODE_ID}/mirror`, { method: "POST" });
    await writeFile(join(mirrorRoot, "wip", "h.md"), "v1");
    const sync1 = await fetch(`${base}/nodes/${NODE_ID}/sync`, { method: "POST" });
    const synced1 = (await sync1.json()) as { adopted: Array<{ file_id: string }> };
    const fileId = synced1.adopted[0].file_id;

    // findEntryByFileId fans out across every node this device has mirrored;
    // OTHER_NODE_ID is not where this file lives, so it must not resolve.
    const OTHER_NODE_ID = "N0000000000000000000OTHER";
    const r = await fetch(`${base}/nodes/${OTHER_NODE_ID}/files/${fileId}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "keep_local" }),
    });
    assert.equal(r.status, 404);

    assert.equal(
      await readFile(join(mirrorRoot, "wip", "h.md"), "utf8"),
      "v1",
      "local copy must be untouched",
    );
    assert.equal(
      fake.bytes.get(posix.join(NODE_ROOT, "wip/h.md"))?.toString(),
      "v1",
      "remote copy must be untouched",
    );
  });

  it("restore over a dirty local copy returns 409 instead of clobbering it", async () => {
    await fetch(`${base}/nodes/${NODE_ID}/mirror`, { method: "POST" });
    await writeFile(join(mirrorRoot, "wip", "i.md"), "v1");
    const sync1 = await fetch(`${base}/nodes/${NODE_ID}/sync`, { method: "POST" });
    const synced1 = (await sync1.json()) as { adopted: Array<{ file_id: string }> };
    const fileId = synced1.adopted[0].file_id;

    // Unpushed local edit -- pullFileCentral's dirty guard must refuse.
    await writeFile(join(mirrorRoot, "wip", "i.md"), "unpushed local edit");

    const r = await fetch(`${base}/nodes/${NODE_ID}/files/${fileId}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "restore" }),
    });
    assert.equal(r.status, 409);
    const body = (await r.json()) as { error: string };
    assert.match(body.error, /never pushed/);

    assert.equal(
      await readFile(join(mirrorRoot, "wip", "i.md"), "utf8"),
      "unpushed local edit",
      "local copy must be untouched",
    );
  });
});

// Showtime handoff on the agent front door: mint against central's node
// verdict, exchange answers with the local sidecar's MCP URL, the node name
// from sync-info and this device's mirror.
describe("agent router: /auth/handoff", () => {
  const post = (path: string, body: unknown, token?: string) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  it("mint -> exchange round trip carries the launch token, MCP URL, name and mirror", async () => {
    await fetch(`${base}/nodes/${NODE_ID}/mirror`, { method: "POST" });
    const mint = await post("/auth/handoff", { node_id: NODE_ID }, "launch-token");
    assert.equal(mint.status, 200);
    const { code } = (await mint.json()) as { code: string };

    const ex = await post("/auth/handoff/exchange", { code });
    assert.equal(ex.status, 200);
    const body = (await ex.json()) as Record<string, unknown>;
    assert.equal(body.token, "launch-token");
    assert.equal(body.mcp_url, `${base}/mcp?home_node_id=${NODE_ID}`);
    assert.equal(body.home_node_id, NODE_ID);
    assert.equal(body.node_name, "Stan GWS");
    assert.equal(body.mirror, mirrorRoot);

    assert.equal((await post("/auth/handoff/exchange", { code })).status, 404, "single use");
  });

  it("mint 404s for a node central does not know, 401s without a bearer", async () => {
    assert.equal((await post("/auth/handoff", { node_id: "N0000000000000000000000000" }, "t")).status, 404);
    assert.equal((await post("/auth/handoff", { node_id: NODE_ID })).status, 401);
  });
});
