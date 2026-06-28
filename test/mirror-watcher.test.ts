// The mirror watcher: thin filesystem-event shell around reconcilePath.
// ownerNodeForPath maps a changed path to its (innermost) mirror node;
// the watcher debounces event bursts and dispatches one reconcile per path;
// start() backfills pre-existing untracked files so nothing created while the
// watcher was down stays unregistered. The real fs.watch adapter is injected
// out in tests -- we drive synthetic events instead of depending on OS timing.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import type { Client } from "@libsql/client";
import { makeSharedDb } from "./helpers/shared-db.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import {
  ownerNodeForPath,
  createMirrorWatcher,
} from "../apps/server/domain/sync/mirror-watcher.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { resetAdapterCacheForTests } from "../apps/server/domain/sync/adapter-cache.js";

describe("ownerNodeForPath", () => {
  it("returns the innermost (longest-prefix) mirror containing the path", () => {
    const mirrors = [
      { node_id: "ORG", local_path: "/root/org" },
      { node_id: "PROJ", local_path: "/root/org/proj" },
    ];
    assert.equal(ownerNodeForPath(mirrors, "/root/org/proj/wip/a.md"), "PROJ");
    assert.equal(ownerNodeForPath(mirrors, "/root/org/wip/b.md"), "ORG");
    assert.equal(ownerNodeForPath(mirrors, "/elsewhere/x.md"), null);
  });

  it("does not match a sibling that is only a string prefix", () => {
    const mirrors = [{ node_id: "A", local_path: "/root/foo" }];
    assert.equal(ownerNodeForPath(mirrors, "/root/foobar/x.md"), null);
  });
});

describe("createMirrorWatcher dispatch", () => {
  it("debounces rapid events for one path into a single reconcile", async () => {
    const calls: { nodeId: string; absPath: string }[] = [];
    let emit: ((p: string) => void) | null = null;
    const watcher = createMirrorWatcher({
      db: {} as unknown as Client,
      userId: "U1",
      listMirrors: async () => [
        { user_id: "U1", node_id: "N1", local_path: "/m", registered_at: "" },
      ],
      reconcile: async (a) => {
        calls.push({ nodeId: a.nodeId, absPath: a.absPath });
        return { action: "noop" };
      },
      backfill: false,
      watchFactory: (_root, onPath) => {
        emit = onPath;
        return { close() {
        /* no-op */
      } };
      },
      debounceMs: 20,
    });
    await watcher.start();
    assert.ok(emit);
    emit!("/m/wip/a.md");
    emit!("/m/wip/a.md");
    emit!("/m/wip/a.md");
    await delay(60);
    watcher.stop();

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { nodeId: "N1", absPath: "/m/wip/a.md" });
  });

  it("ignores events outside any mirror", async () => {
    const calls: string[] = [];
    let emit: ((p: string) => void) | null = null;
    const watcher = createMirrorWatcher({
      db: {} as unknown as Client,
      userId: "U1",
      listMirrors: async () => [
        { user_id: "U1", node_id: "N1", local_path: "/m", registered_at: "" },
      ],
      reconcile: async (a) => {
        calls.push(a.absPath);
        return { action: "noop" };
      },
      backfill: false,
      watchFactory: (_root, onPath) => {
        emit = onPath;
        return { close() {
        /* no-op */
      } };
      },
      debounceMs: 10,
    });
    await watcher.start();
    emit!("/somewhere/else/x.md");
    await delay(40);
    watcher.stop();
    assert.equal(calls.length, 0);
  });
});

describe("createMirrorWatcher backfill", () => {
  let workspace: string;
  let prev: string | undefined;
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "portuni-watch-"));
    prev = process.env.PORTUNI_WORKSPACE_ROOT;
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();
    resetAdapterCacheForTests();
  });
  afterEach(async () => {
    resetLocalDbForTests();
    resetAdapterCacheForTests();
    if (prev === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
    else process.env.PORTUNI_WORKSPACE_ROOT = prev;
    await rm(workspace, { recursive: true, force: true });
  });

  it("registers pre-existing untracked files on start", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    await writeFile(join(mirrorRoot, "wip", "pre.md"), "existed before watcher");

    const watcher = createMirrorWatcher({
      db,
      userId: "U1",
      watchFactory: () => ({ close() {
        /* no-op */
      } }), // no real fs.watch in tests
    });
    await watcher.start();
    watcher.stop();

    const rows = await db.execute({
      sql: "SELECT filename FROM files WHERE node_id = ?",
      args: [nodeId],
    });
    assert.deepEqual(
      rows.rows.map((r) => r.filename),
      ["pre.md"],
    );
  });
});
