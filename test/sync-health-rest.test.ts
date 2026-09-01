// GET /sync/health (#202): workspace-wide mirror-watcher error diagnostics,
// plus the watcher_errors field GET /nodes/:id/sync-status gains when the
// node has one. Exercises the real HTTP route, not the buffer functions
// directly.

process.env.PORT = "14933";
process.env.HOST = "127.0.0.1";
process.env.PORTUNI_AUTH_TOKEN = "";

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { makeSharedDb, type SharedDb } from "./helpers/shared-db.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { resetGateCachesForTesting } from "../apps/server/http/middleware.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { resetAdapterCacheForTests } from "../apps/server/domain/sync/adapter-cache.js";
import { startHttpServer, type HttpServerHandle } from "../apps/server/http/server.js";
import {
  recordWatcherError,
  clearWatcherErrorBufferForTests,
} from "../apps/server/domain/sync/watcher-error-buffer.js";

let handle: HttpServerHandle;
let workspace: string;
let shared: SharedDb;
let base: string;
let originalWorkspaceRoot: string | undefined;

beforeEach(async () => {
  resetGateCachesForTesting();
  clearWatcherErrorBufferForTests();
  workspace = await mkdtemp(join(tmpdir(), "portuni-sync-health-rest-"));
  originalWorkspaceRoot = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
  resetAdapterCacheForTests();
  shared = await makeSharedDb();
  setDbForTesting(shared.db);

  handle = startHttpServer({ port: 0, host: "127.0.0.1", registerSigint: false });
  if (!handle.server.listening) {
    await new Promise<void>((r) => handle.server.once("listening", r));
  }
  const addr = handle.server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
  process.env.PORT = String(addr.port);
  resetGateCachesForTesting();
});

afterEach(async () => {
  await handle.shutdown();
  setDbForTesting(null);
  resetLocalDbForTests();
  resetAdapterCacheForTests();
  clearWatcherErrorBufferForTests();
  if (originalWorkspaceRoot === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalWorkspaceRoot;
  await rm(workspace, { recursive: true, force: true });
});

describe("GET /sync/health", () => {
  it("returns an empty list when nothing has been recorded", async () => {
    const res = await fetch(`${base}/sync/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { errors: unknown[] };
    assert.deepEqual(body.errors, []);
  });

  it("surfaces a recorded watcher error", async () => {
    recordWatcherError(shared.nodeId, "wip/broken.md", new Error("no remote routing configured"));
    const res = await fetch(`${base}/sync/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      errors: Array<{ node_id: string; path: string; message: string; at: string }>;
    };
    assert.equal(body.errors.length, 1);
    assert.equal(body.errors[0].node_id, shared.nodeId);
    assert.equal(body.errors[0].path, "wip/broken.md");
    assert.equal(body.errors[0].message, "no remote routing configured");
  });
});

describe("GET /nodes/:id/sync-status watcher_errors field", () => {
  it("omits the field entirely when the node has no watcher errors", async () => {
    const res = await fetch(`${base}/nodes/${shared.nodeId}/sync-status`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(!("watcher_errors" in body));
  });

  it("includes watcher_errors for a node that has one", async () => {
    recordWatcherError(shared.nodeId, "wip/broken.md", new Error("boom"));
    const res = await fetch(`${base}/nodes/${shared.nodeId}/sync-status`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      watcher_errors?: Array<{ node_id: string; path: string; message: string }>;
    };
    assert.equal(body.watcher_errors?.length, 1);
    assert.equal(body.watcher_errors?.[0].path, "wip/broken.md");
  });

  it("does not leak another node's watcher error", async () => {
    recordWatcherError("N-OTHER-NODE", "wip/other.md", new Error("boom"));
    const res = await fetch(`${base}/nodes/${shared.nodeId}/sync-status`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(!("watcher_errors" in body));
  });
});
