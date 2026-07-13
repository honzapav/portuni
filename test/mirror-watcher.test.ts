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

describe("createMirrorWatcher refresh", () => {
  // A mutable mirror list + a watchFactory that records every watched root
  // and hands back per-root emitters, so tests can register a mirror
  // "mid-flight" and drive events under it.
  function harness() {
    const mirrors: { user_id: string; node_id: string; local_path: string; registered_at: string }[] = [];
    const watchedRoots: string[] = [];
    const closedRoots: string[] = [];
    const emitters = new Map<string, (p: string) => void>();
    const calls: { nodeId: string; absPath: string }[] = [];
    const deps = {
      db: {} as unknown as Client,
      userId: "U1",
      listMirrors: async () => [...mirrors],
      reconcile: async (a: { userId: string; nodeId: string; absPath: string }) => {
        calls.push({ nodeId: a.nodeId, absPath: a.absPath });
        return { action: "noop" as const };
      },
      backfill: false,
      watchFactory: (root: string, onPath: (p: string) => void) => {
        watchedRoots.push(root);
        emitters.set(root, onPath);
        return {
          close() {
            closedRoots.push(root);
          },
        };
      },
      debounceMs: 10,
    };
    return { mirrors, watchedRoots, closedRoots, emitters, calls, deps };
  }

  it("watches a mirror registered after start and resolves events to it", async () => {
    const h = harness();
    h.mirrors.push({ user_id: "U1", node_id: "ORG", local_path: "/m", registered_at: "" });
    const watcher = createMirrorWatcher(h.deps);
    await watcher.start();

    // Before refresh: events under the (unknown) project mirror are
    // attributed to the org, mirroring the stale-list bug.
    h.emitters.get("/m")!("/m/proj/wip/a.md");
    await delay(40);
    assert.deepEqual(h.calls, [{ nodeId: "ORG", absPath: "/m/proj/wip/a.md" }]);

    h.mirrors.push({ user_id: "U1", node_id: "PROJ", local_path: "/m/proj", registered_at: "" });
    await watcher.refresh();
    assert.ok(h.watchedRoots.includes("/m/proj"), "new mirror root is watched");

    h.calls.length = 0;
    h.emitters.get("/m/proj")!("/m/proj/wip/a.md");
    await delay(40);
    watcher.stop();
    assert.deepEqual(h.calls, [{ nodeId: "PROJ", absPath: "/m/proj/wip/a.md" }]);
  });

  it("closes the watch for a mirror that was unregistered", async () => {
    const h = harness();
    h.mirrors.push(
      { user_id: "U1", node_id: "N1", local_path: "/m1", registered_at: "" },
      { user_id: "U1", node_id: "N2", local_path: "/m2", registered_at: "" },
    );
    const watcher = createMirrorWatcher(h.deps);
    await watcher.start();

    h.mirrors.splice(1, 1); // unregister N2
    await watcher.refresh();
    assert.deepEqual(h.closedRoots, ["/m2"]);

    // Late events from the closed root no longer resolve to N2.
    h.emitters.get("/m2")!("/m2/wip/x.md");
    await delay(40);
    watcher.stop();
    assert.deepEqual(h.calls, []);
  });

  it("backfills only newly added mirrors via injected backfillMirror", async () => {
    const h = harness();
    h.mirrors.push({ user_id: "U1", node_id: "N1", local_path: "/m1", registered_at: "" });
    const backfilled: string[] = [];
    const watcher = createMirrorWatcher({
      ...h.deps,
      backfillMirror: async (m: { node_id: string }) => {
        backfilled.push(m.node_id);
      },
    });
    await watcher.start();
    backfilled.length = 0; // ignore whatever start() did

    h.mirrors.push({ user_id: "U1", node_id: "N2", local_path: "/m2", registered_at: "" });
    await watcher.refresh();
    watcher.stop();
    assert.deepEqual(backfilled, ["N2"]);
  });

  it("refreshes on registry notification via the subscribe seam and unsubscribes on stop", async () => {
    const h = harness();
    h.mirrors.push({ user_id: "U1", node_id: "N1", local_path: "/m1", registered_at: "" });
    let listener: (() => void) | null = null;
    let unsubscribed = false;
    const watcher = createMirrorWatcher({
      ...h.deps,
      subscribe: (fn: () => void) => {
        listener = fn;
        return () => {
          unsubscribed = true;
        };
      },
    });
    await watcher.start();
    assert.ok(listener, "watcher subscribed to registry changes on start");

    h.mirrors.push({ user_id: "U1", node_id: "N2", local_path: "/m2", registered_at: "" });
    listener!();
    await delay(40); // notification-triggered refresh is fire-and-forget
    assert.ok(h.watchedRoots.includes("/m2"), "notification triggered a refresh");

    watcher.stop();
    assert.ok(unsubscribed, "stop() unsubscribes from the registry");
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

  it("registers files in a mirror created after start (default registry subscription)", async () => {
    const { db, nodeId } = await makeSharedDb();
    const watcher = createMirrorWatcher({
      db,
      userId: "U1",
      watchFactory: () => ({ close() {
        /* no-op */
      } }),
    });
    await watcher.start();

    // Mirror + file appear only after the watcher is already running --
    // the exact sequence that used to leave files unregistered until the
    // next sidecar restart.
    const mirrorRoot = join(workspace, "late-mirror");
    await mkdir(join(mirrorRoot, "outputs"), { recursive: true });
    await writeFile(join(mirrorRoot, "outputs", "late.md"), "created after start");
    await registerMirror("U1", nodeId, mirrorRoot);

    // registerMirror notifies the watcher, which refreshes asynchronously.
    let filenames: unknown[] = [];
    for (let i = 0; i < 50; i += 1) {
      const rows = await db.execute({
        sql: "SELECT filename FROM files WHERE node_id = ?",
        args: [nodeId],
      });
      filenames = rows.rows.map((r) => r.filename);
      if (filenames.length > 0) break;
      await delay(20);
    }
    watcher.stop();
    assert.deepEqual(filenames, ["late.md"]);
  });
});
