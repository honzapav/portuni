// The mirror watcher: thin filesystem-event shell around reconcilePath.
// ownerNodeForPath maps a changed path to its (innermost) mirror node;
// the watcher debounces event bursts and dispatches one reconcile per path;
// start() backfills pre-existing untracked files so nothing created while the
// watcher was down stays unregistered. The real fs.watch adapter is injected
// out in tests -- we drive synthetic events instead of depending on OS timing.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile, rename } from "node:fs/promises";
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
import {
  registerProjectedNode,
  nodeProjectionDir,
  clearProjectionRegistryForTests,
} from "../apps/server/domain/session-projection.js";
import {
  getWatcherErrors,
  clearWatcherErrorBufferForTests,
} from "../apps/server/domain/sync/watcher-error-buffer.js";

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

  it("a slow reconcile in one mirror does not block a concurrent reconcile in another (#273)", async () => {
    const calls: { nodeId: string; absPath: string }[] = [];
    let releaseSlow: (() => void) | null = null;
    const emitters: Record<string, (p: string) => void> = {};
    const watcher = createMirrorWatcher({
      db: {} as unknown as Client,
      userId: "U1",
      listMirrors: async () => [
        { user_id: "U1", node_id: "N1", local_path: "/m1", registered_at: "" },
        { user_id: "U1", node_id: "N2", local_path: "/m2", registered_at: "" },
      ],
      reconcile: async (a) => {
        if (a.nodeId === "N1") {
          await new Promise<void>((resolve) => {
            releaseSlow = resolve;
          });
        }
        calls.push({ nodeId: a.nodeId, absPath: a.absPath });
        return { action: "noop" };
      },
      backfill: false,
      watchFactory: (root, onPath) => {
        emitters[root] = onPath;
        return { close() {
          /* no-op */
        } };
      },
      debounceMs: 5,
    });
    await watcher.start();
    emitters["/m1"]("/m1/wip/slow.md");
    await delay(30); // N1's reconcile is now running and blocked on releaseSlow.
    emitters["/m2"]("/m2/wip/fast.md");
    await delay(60);
    assert.deepEqual(
      calls,
      [{ nodeId: "N2", absPath: "/m2/wip/fast.md" }],
      "N2's reconcile must complete while N1's is still stuck -- independent chains",
    );
    releaseSlow!();
    await delay(30);
    watcher.stop();
    assert.deepEqual(calls, [
      { nodeId: "N2", absPath: "/m2/wip/fast.md" },
      { nodeId: "N1", absPath: "/m1/wip/slow.md" },
    ]);
  });

  it("re-links an active session projection when a watched file changes (#191)", async () => {
    const root = await mkdtemp(join(tmpdir(), "portuni-watch-proj-"));
    const mirror = join(root, "mirror");
    await mkdir(join(mirror, "wip"), { recursive: true });
    clearProjectionRegistryForTests();
    const target = nodeProjectionDir(join(root, ".portuni-sessions", "HOME"), "SESS", "N1");
    registerProjectedNode("N1", { sessionId: "SESS", mirrorPath: mirror, targetDir: target });

    let emit: ((p: string) => void) | null = null;
    const watcher = createMirrorWatcher({
      db: {} as unknown as Client,
      userId: "U1",
      listMirrors: async () => [
        { user_id: "U1", node_id: "N1", local_path: mirror, registered_at: "" },
      ],
      reconcile: async () => ({ action: "noop" }),
      backfill: false,
      watchFactory: (_root, onPath) => {
        emit = onPath;
        return { close() { /* no-op */ } };
      },
      debounceMs: 10,
    });
    await watcher.start();
    assert.ok(emit);

    const src = join(mirror, "wip", "a.md");
    await writeFile(src, "hello\n");
    emit!(src);
    await delay(60);
    watcher.stop();

    assert.equal(await readFile(join(target, "wip", "a.md"), "utf8"), "hello\n");
    clearProjectionRegistryForTests();
    await rm(root, { recursive: true, force: true });
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

// #202: reconcile failures used to only reach onError/console. They must
// also land in the shared watcher-error buffer (keyed by node+path) so the
// REST layer can surface them, and clear again once the same path
// reconciles successfully.
describe("createMirrorWatcher: watcher-error buffer wiring", () => {
  beforeEach(() => {
    clearWatcherErrorBufferForTests();
  });

  it("records a reconcile failure with the node id and path", async () => {
    let emit: ((p: string) => void) | null = null;
    const watcher = createMirrorWatcher({
      db: {} as unknown as Client,
      userId: "U1",
      listMirrors: async () => [
        { user_id: "U1", node_id: "N1", local_path: "/m", registered_at: "" },
      ],
      reconcile: async () => {
        throw new Error("no remote routing configured");
      },
      backfill: false,
      watchFactory: (_root, onPath) => {
        emit = onPath;
        return { close() { /* no-op */ } };
      },
      onError: () => undefined,
      debounceMs: 10,
    });
    await watcher.start();
    emit!("/m/wip/a.md");
    await delay(40);
    watcher.stop();

    const errors = getWatcherErrors("N1");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].path, "/m/wip/a.md");
    assert.equal(errors[0].message, "no remote routing configured");
  });

  it("clears the entry once the same path reconciles successfully", async () => {
    let emit: ((p: string) => void) | null = null;
    let shouldFail = true;
    const watcher = createMirrorWatcher({
      db: {} as unknown as Client,
      userId: "U1",
      listMirrors: async () => [
        { user_id: "U1", node_id: "N1", local_path: "/m", registered_at: "" },
      ],
      reconcile: async () => {
        if (shouldFail) throw new Error("boom");
        return { action: "noop" };
      },
      backfill: false,
      watchFactory: (_root, onPath) => {
        emit = onPath;
        return { close() { /* no-op */ } };
      },
      onError: () => undefined,
      debounceMs: 10,
    });
    await watcher.start();
    emit!("/m/wip/a.md");
    await delay(40);
    assert.equal(getWatcherErrors("N1").length, 1);

    shouldFail = false;
    emit!("/m/wip/a.md");
    await delay(40);
    watcher.stop();

    assert.deepEqual(getWatcherErrors("N1"), []);
  });

  it("a repeated failure for the same path stays one entry (dedupe)", async () => {
    let emit: ((p: string) => void) | null = null;
    const watcher = createMirrorWatcher({
      db: {} as unknown as Client,
      userId: "U1",
      listMirrors: async () => [
        { user_id: "U1", node_id: "N1", local_path: "/m", registered_at: "" },
      ],
      reconcile: async () => {
        throw new Error("still broken");
      },
      backfill: false,
      watchFactory: (_root, onPath) => {
        emit = onPath;
        return { close() { /* no-op */ } };
      },
      onError: () => undefined,
      debounceMs: 10,
    });
    await watcher.start();
    emit!("/m/wip/a.md");
    await delay(30);
    emit!("/m/wip/a.md");
    await delay(30);
    watcher.stop();

    assert.equal(getWatcherErrors("N1").length, 1);
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

  it("sweep re-backfills every currently-watched mirror, not just newly added ones (#273)", async () => {
    const h = harness();
    h.mirrors.push({ user_id: "U1", node_id: "N1", local_path: "/m1", registered_at: "" });
    h.mirrors.push({ user_id: "U1", node_id: "N2", local_path: "/m2", registered_at: "" });
    const backfilled: string[] = [];
    const watcher = createMirrorWatcher({
      ...h.deps,
      backfillMirror: async (m: { node_id: string }) => {
        backfilled.push(m.node_id);
      },
    });
    await watcher.start();
    backfilled.length = 0; // ignore whatever start() did (harness disables backfill on start)

    await watcher.sweep();
    watcher.stop();
    assert.deepEqual(
      backfilled.sort(),
      ["N1", "N2"],
      "sweep re-backfills mirrors that were already being watched, not just new ones",
    );
  });

  it("sweep does not overlap with itself when called again before the first pass finishes", async () => {
    const h = harness();
    h.mirrors.push({ user_id: "U1", node_id: "N1", local_path: "/m1", registered_at: "" });
    let concurrentCalls = 0;
    let maxConcurrent = 0;
    const watcher = createMirrorWatcher({
      ...h.deps,
      backfillMirror: async () => {
        concurrentCalls++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
        await delay(20);
        concurrentCalls--;
      },
    });
    await watcher.start();
    const first = watcher.sweep();
    const second = watcher.sweep(); // must no-op while the first is in flight
    await Promise.all([first, second]);
    watcher.stop();
    assert.equal(maxConcurrent, 1);
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

  // #253: a live watcher pairs an on-disk mv by inode; backfill (start() /
  // refresh()) is the catch-up path for a mv that happened while the
  // watcher was NOT running (server down, or a missed directory-level
  // event) -- it must not treat the file at its new path as brand new.
  it("backfill pairs a directory mv that happened while the watcher was down (no duplicate)", async () => {
    const { storeFile } = await import("../apps/server/domain/sync/engine.js");
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const oldDir = join(mirrorRoot, "wip", "prezentace");
    await mkdir(oldDir, { recursive: true });
    const oldAbs = join(oldDir, "slide.md");
    await writeFile(oldAbs, "obsah");
    // storeFile is fixture setup here (pre-existing tracked file before the
    // mv), not the subject under test -- a local workspace can't push, so
    // simulate the one non-local deployment that still can (#310/#312).
    process.env.PORTUNI_AGENT_MODE = "1";
    let stored: Awaited<ReturnType<typeof storeFile>>;
    try {
      stored = await storeFile(db, { userId: "U1", nodeId, localPath: oldAbs });
    } finally {
      delete process.env.PORTUNI_AGENT_MODE;
    }

    // The mv happens with no watcher running at all.
    await mkdir(join(mirrorRoot, "outputs"), { recursive: true });
    const newDir = join(mirrorRoot, "outputs", "prezentace");
    await rename(oldDir, newDir);

    const watcher = createMirrorWatcher({
      db,
      userId: "U1",
      watchFactory: () => ({ close() {
        /* no real fs.watch in tests -- only the start()-time backfill sweep is under test */
      } }),
    });
    await watcher.start();
    watcher.stop();

    const rows = await db.execute({
      sql: "SELECT id, filename, remote_path FROM files WHERE node_id = ?",
      args: [nodeId],
    });
    assert.equal(rows.rows.length, 1, `expected one paired row, got ${JSON.stringify(rows.rows)}`);
    assert.equal(rows.rows[0].id, stored.file_id);
    assert.equal(rows.rows[0].filename, "slide.md");
    assert.match(rows.rows[0].remote_path as string, /outputs\/prezentace\/slide\.md$/);
  });
});
