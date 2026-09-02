// Scope -> disk projection (#191). readableMirrorRoot maps a node to the
// disk path the agent may read: the real mirror for home/seed nodes, the
// session's hardlink projection directory for ad-hoc ones (once created),
// null otherwise. DiskProjector creates that hardlink projection on demand.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, stat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient as createDbClient, type Client as DbClient } from "@libsql/client";
import { SessionScope } from "../apps/server/mcp/scope.js";
import { readableMirrorRoot, createDiskProjector, disposeSessionProjection } from "../apps/server/mcp/disk-projection.js";
import {
  clearProjectionRegistryForTests,
  UNNARROWED_PROJECTION_ID,
} from "../apps/server/domain/session-projection.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { ensureSchemaOn } from "../apps/server/infra/schema.js";
import { createSession } from "../apps/server/domain/sessions.js";

let dir: string;
let home: string;
let neighbor: string;
let originalPortuniRoot: string | undefined;
let originalWorkspaceRoot: string | undefined;

// disposeSessionProjection's #214 tests need a real DB-backed node (the
// sessions table's node_id FK, and its id CHECK(length = 26)) -- unlike
// every other test in this file, which uses "HOME" as a bare path segment
// with no DB behind it.
const HOME_NODE_ID = "01HOME00000000000000000000";

function fakeResolver(map: Record<string, string>) {
  return async (_userId: string, nodeId: string) => map[nodeId] ?? null;
}

beforeEach(async () => {
  // realpath: macOS tmpdir is a symlink (/var -> /private/var) and the
  // projector resolves real paths, so the expected dir must match.
  dir = await realpath(await mkdtemp(join(tmpdir(), "portuni-diskproj-")));
  home = join(dir, "home");
  neighbor = join(dir, "neighbor");
  await mkdir(join(home, "wip"), { recursive: true });
  await mkdir(join(neighbor, "wip"), { recursive: true });
  originalPortuniRoot = process.env.PORTUNI_ROOT;
  originalWorkspaceRoot = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_ROOT = dir;
  process.env.PORTUNI_WORKSPACE_ROOT = dir;
  resetLocalDbForTests();
  clearProjectionRegistryForTests();
});

afterEach(async () => {
  if (originalPortuniRoot === undefined) delete process.env.PORTUNI_ROOT;
  else process.env.PORTUNI_ROOT = originalPortuniRoot;
  if (originalWorkspaceRoot === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalWorkspaceRoot;
  resetLocalDbForTests();
  clearProjectionRegistryForTests();
  await rm(dir, { recursive: true, force: true });
});

describe("readableMirrorRoot", () => {
  it("returns the real mirror for the home node", () => {
    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = "HOME";
    const p = readableMirrorRoot({ scope, nodeId: "HOME", homeMirror: "/h", realMirror: "/h" });
    assert.equal(p, "/h");
  });

  it("returns the real mirror for a seed-set (depth-1) node", () => {
    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = "HOME";
    scope.addSeed("NEIGHBOR");
    const p = readableMirrorRoot({
      scope,
      nodeId: "NEIGHBOR",
      homeMirror: "/h",
      realMirror: "/real/neighbor",
    });
    assert.equal(p, "/real/neighbor");
  });

  it("returns the projection dir for a non-seed in-scope (ad-hoc) node when one is given", () => {
    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = "HOME";
    scope.add("ADHOC"); // in scope but not seeded
    const p = readableMirrorRoot({
      scope,
      nodeId: "ADHOC",
      homeMirror: "/h",
      realMirror: "/real/adhoc",
      projectionDir: "/proj/sess/ADHOC",
    });
    assert.equal(p, "/proj/sess/ADHOC");
  });

  it("returns null for an ad-hoc in-scope node with no projection yet", () => {
    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = "HOME";
    scope.add("ADHOC");
    const p = readableMirrorRoot({
      scope,
      nodeId: "ADHOC",
      homeMirror: "/h",
      realMirror: "/real/adhoc",
    });
    assert.equal(p, null);
  });

  it("returns null for an out-of-scope node", () => {
    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = "HOME";
    const p = readableMirrorRoot({
      scope,
      nodeId: "OUTSIDE",
      homeMirror: "/h",
      realMirror: "/real/outside",
    });
    assert.equal(p, null);
  });
});

describe("createDiskProjector", () => {
  it("returns null for the home node", async () => {
    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = "HOME";
    scope.sessionId = "SESS";
    scope.projectionSessionId = "SESS";
    const projector = createDiskProjector({
      userId: "u",
      scope,
      resolveMirror: fakeResolver({ HOME: home }),
    });
    assert.equal(await projector.projectNode("HOME"), null);
  });

  it("returns null for a seed node", async () => {
    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = "HOME";
    scope.sessionId = "SESS";
    scope.projectionSessionId = "SESS";
    scope.addSeed("NEIGHBOR");
    const projector = createDiskProjector({
      userId: "u",
      scope,
      resolveMirror: fakeResolver({ NEIGHBOR: neighbor }),
    });
    assert.equal(await projector.projectNode("NEIGHBOR"), null);
  });

  it("returns null for a node outside scope", async () => {
    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = "HOME";
    scope.sessionId = "SESS";
    scope.projectionSessionId = "SESS";
    const projector = createDiskProjector({
      userId: "u",
      scope,
      resolveMirror: fakeResolver({ NEIGHBOR: neighbor }),
    });
    assert.equal(await projector.projectNode("NEIGHBOR"), null);
  });

  it("returns null when the scope was never bound to a projection directory (no createMcpServer)", async () => {
    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = "HOME";
    scope.add("ADHOC");
    const projector = createDiskProjector({
      userId: "u",
      scope,
      resolveMirror: fakeResolver({ ADHOC: neighbor }),
    });
    assert.equal(await projector.projectNode("ADHOC"), null);
  });

  // #211: a CLI whose config format cannot relay the spawn-minted session id
  // back to the MCP connection (Codex, Vibe -- unlike Claude's
  // X-Portuni-Spawn-Id) still gets its ad-hoc expansions projected, into the
  // fixed shared bucket every Seatbelt profile grants unconditionally for
  // exactly this case (domain/sandbox-profile.ts), instead of regressing to
  // portuni_read_file-only.
  it("projects into the shared bucket when no spawn/resume id is known (Codex/Vibe)", async () => {
    await writeFile(join(neighbor, "wip", "method.md"), "hello\n");
    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = "HOME";
    scope.sessionId = "SESS"; // persisted DB session id -- unrelated to the projection key
    scope.projectionSessionId = UNNARROWED_PROJECTION_ID;
    scope.add("ADHOC");
    const projector = createDiskProjector({
      userId: "u",
      scope,
      resolveMirror: fakeResolver({ ADHOC: neighbor }),
    });

    const result = await projector.projectNode("ADHOC");
    assert.ok(result);
    assert.equal(result.dir, join(dir, ".portuni-sessions", "HOME", UNNARROWED_PROJECTION_ID, "ADHOC"));
    const linked = await readFile(join(result.dir, "wip", "method.md"), "utf8");
    assert.equal(linked, "hello\n");
  });

  it("returns null when the ad-hoc node has no local mirror on this device", async () => {
    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = "HOME";
    scope.sessionId = "SESS";
    scope.projectionSessionId = "SESS";
    scope.add("ADHOC");
    const projector = createDiskProjector({
      userId: "u",
      scope,
      resolveMirror: fakeResolver({}), // ADHOC has no mirror
    });
    assert.equal(await projector.projectNode("ADHOC"), null);
  });

  it("hardlinks the ad-hoc node's mirror files into the session projection dir", async () => {
    await writeFile(join(neighbor, "wip", "method.md"), "hello\n");
    await mkdir(join(neighbor, "outputs"), { recursive: true });
    await writeFile(join(neighbor, "outputs", "report.md"), "world\n");
    // dotfile must be skipped, same ignore policy as the sync engine
    await mkdir(join(neighbor, "wip", ".obsidian"), { recursive: true });
    await writeFile(join(neighbor, "wip", ".obsidian", "workspace.json"), "{}");

    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = "HOME";
    scope.sessionId = "SESS";
    scope.projectionSessionId = "SESS";
    scope.add("ADHOC");
    const projector = createDiskProjector({
      userId: "u",
      scope,
      resolveMirror: fakeResolver({ HOME: home, ADHOC: neighbor }),
    });

    const result = await projector.projectNode("ADHOC");
    assert.ok(result);
    assert.equal(result.files, 2);
    assert.equal(result.dir, join(dir, ".portuni-sessions", "HOME", "SESS", "ADHOC"));

    const linked = await readFile(join(result.dir, "wip", "method.md"), "utf8");
    assert.equal(linked, "hello\n");
    const linkedOut = await readFile(join(result.dir, "outputs", "report.md"), "utf8");
    assert.equal(linkedOut, "world\n");

    // Genuine hardlink: same inode as the source.
    const srcStat = await stat(join(neighbor, "wip", "method.md"));
    const dstStat = await stat(join(result.dir, "wip", "method.md"));
    assert.equal(srcStat.ino, dstStat.ino);

    await assert.rejects(() => stat(join(result.dir, "wip", ".obsidian", "workspace.json")));
  });

  it("is idempotent: re-projecting an already-linked node is a no-op, not an error", async () => {
    await writeFile(join(neighbor, "wip", "method.md"), "hello\n");
    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = "HOME";
    scope.sessionId = "SESS";
    scope.projectionSessionId = "SESS";
    scope.add("ADHOC");
    const projector = createDiskProjector({
      userId: "u",
      scope,
      resolveMirror: fakeResolver({ ADHOC: neighbor }),
    });

    const first = await projector.projectNode("ADHOC");
    const second = await projector.projectNode("ADHOC");
    assert.equal(first?.files, 1);
    assert.equal(second?.files, 1);
  });

  it("dedups concurrent calls for the same node", async () => {
    await writeFile(join(neighbor, "wip", "method.md"), "hello\n");
    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = "HOME";
    scope.sessionId = "SESS";
    scope.projectionSessionId = "SESS";
    scope.add("ADHOC");
    let calls = 0;
    const projector = createDiskProjector({
      userId: "u",
      scope,
      resolveMirror: async (_u, id) => {
        calls++;
        return id === "ADHOC" ? neighbor : null;
      },
    });

    const [a, b] = await Promise.all([projector.projectNode("ADHOC"), projector.projectNode("ADHOC")]);
    assert.deepEqual(a, b);
    assert.equal(calls, 1);
  });
});

describe("disposeSessionProjection", () => {
  let db: DbClient;

  beforeEach(async () => {
    db = createDbClient({ url: ":memory:" });
    await ensureSchemaOn(db);
    await db.execute({
      sql: "INSERT OR IGNORE INTO users (id, email, name) VALUES ('u', 'u@x.com', 'U')",
      args: [],
    });
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, 'project', 'Home', 'home', 'u')",
      args: [HOME_NODE_ID],
    });
  });

  it("removes the narrow per-spawn projection directory on close", async () => {
    await writeFile(join(neighbor, "wip", "method.md"), "hello\n");
    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = "HOME";
    scope.sessionId = "SESS";
    scope.projectionSessionId = "SESS";
    scope.add("ADHOC");
    const projector = createDiskProjector({
      userId: "u",
      scope,
      resolveMirror: fakeResolver({ ADHOC: neighbor }),
    });
    const result = await projector.projectNode("ADHOC");
    assert.ok(result);

    disposeSessionProjection(scope, "u", db);
    // Fire-and-forget cleanup -- give the microtask queue a turn.
    await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(() => stat(result.dir));
  });

  // #211: the shared bucket may still be in use by another concurrent
  // non-relaying (Codex/Vibe) session on the same node, so a single
  // session's close must never remove it purely because ITS OWN
  // projectionSessionId happens to be the shared sentinel.
  it("does NOT remove the shared bucket while another session on the node is still running (#211, #214)", async () => {
    await writeFile(join(neighbor, "wip", "method.md"), "hello\n");
    await createSession(db, "u", { node_id: HOME_NODE_ID, session_type: "interactive_task" });
    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = HOME_NODE_ID;
    scope.sessionId = "SESS";
    scope.projectionSessionId = UNNARROWED_PROJECTION_ID;
    scope.add("ADHOC");
    const projector = createDiskProjector({
      userId: "u",
      scope,
      resolveMirror: fakeResolver({ ADHOC: neighbor }),
    });
    const result = await projector.projectNode("ADHOC");
    assert.ok(result);

    disposeSessionProjection(scope, "u", db);
    await new Promise((r) => setTimeout(r, 20));
    const linked = await readFile(join(result.dir, "wip", "method.md"), "utf8");
    assert.equal(linked, "hello\n");
  });

  // #214: unlike a narrow per-session directory, the shared bucket has no
  // owner of its own -- it must be swept once NOTHING is running on its
  // home node anymore, including when the closing session is itself the
  // last one (and therefore still has a 'running' row in the durable table
  // at the moment onclose fires -- it must be excluded from the "any other
  // running session" check, not mistaken for one).
  it("removes the shared bucket once this was the last running session on the node", async () => {
    await writeFile(join(neighbor, "wip", "method.md"), "hello\n");
    const sessionId = "01SESS00000000000000000000";
    await createSession(db, "u", { node_id: HOME_NODE_ID, session_type: "interactive_task" }, sessionId);
    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = HOME_NODE_ID;
    scope.sessionId = sessionId;
    scope.projectionSessionId = UNNARROWED_PROJECTION_ID;
    scope.add("ADHOC");
    const projector = createDiskProjector({
      userId: "u",
      scope,
      resolveMirror: fakeResolver({ ADHOC: neighbor }),
    });
    const result = await projector.projectNode("ADHOC");
    assert.ok(result);

    disposeSessionProjection(scope, "u", db);
    await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(() => stat(join(dir, ".portuni-sessions", HOME_NODE_ID, UNNARROWED_PROJECTION_ID)));
  });
});
