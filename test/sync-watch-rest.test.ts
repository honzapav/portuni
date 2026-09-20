// GET /sync/watch (#339): the remote watcher's (#338) per-remote state,
// exercised through the real HTTP route with the loop itself stubbed out --
// the route's job is to report what the loop knows, or an empty list when
// this server is a local workspace (spec rule 5: the watcher runs on
// central only).

process.env.PORT = "14937";
process.env.HOST = "127.0.0.1";
process.env.PORTUNI_AUTH_TOKEN = "";

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { makeSharedDb, type SharedDb } from "./helpers/shared-db.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { resetGateCachesForTesting } from "../apps/server/http/middleware.js";
import { startHttpServer, type HttpServerHandle } from "../apps/server/http/server.js";
import {
  isoFromDbTimestamp,
  setRemoteWatchStatusSource,
} from "../apps/server/domain/sync/remote-watch-status.js";
import type { RemoteWatchStatus, SyncWatchResponse } from "../apps/server/shared/api-types.js";

let handle: HttpServerHandle;
let shared: SharedDb;
let base: string;
let originalAgentMode: string | undefined;

const watching: RemoteWatchStatus = {
  remote_name: "drive",
  watching: true,
  cursor_updated_at: "2026-09-19T10:00:00.000Z",
  last_tick_at: "2026-09-19T10:01:00.000Z",
  last_error: null,
  backoff_until: null,
  last_full_sweep_at: "2026-09-19T06:00:00.000Z",
};

const failing: RemoteWatchStatus = {
  remote_name: "drive",
  watching: false,
  cursor_updated_at: "2026-09-19T10:00:00.000Z",
  last_tick_at: "2026-09-19T10:05:00.000Z",
  last_error: "Drive changes.list: 429 rate limit",
  backoff_until: "2026-09-19T10:07:00.000Z",
  last_full_sweep_at: null,
};

beforeEach(async () => {
  resetGateCachesForTesting();
  originalAgentMode = process.env.PORTUNI_AGENT_MODE;
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
  setRemoteWatchStatusSource(null);
  if (originalAgentMode === undefined) delete process.env.PORTUNI_AGENT_MODE;
  else process.env.PORTUNI_AGENT_MODE = originalAgentMode;
});

describe("GET /sync/watch", () => {
  it("answers an empty list on a local workspace even with a live watcher", async () => {
    // env auth + no agent mode == isLocalWorkspace(): no remote at all
    // (#310), so there is nothing to report and the UI renders no line.
    delete process.env.PORTUNI_AGENT_MODE;
    setRemoteWatchStatusSource(() => [watching]);
    const res = await fetch(`${base}/sync/watch`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as SyncWatchResponse;
    assert.deepEqual(body, { remotes: [] });
  });

  it("answers an empty list when no watcher is running", async () => {
    process.env.PORTUNI_AGENT_MODE = "1";
    const res = await fetch(`${base}/sync/watch`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as SyncWatchResponse;
    assert.deepEqual(body.remotes, []);
  });

  it("reports a watching remote", async () => {
    process.env.PORTUNI_AGENT_MODE = "1";
    setRemoteWatchStatusSource(() => [watching]);
    const res = await fetch(`${base}/sync/watch`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as SyncWatchResponse;
    assert.equal(body.remotes.length, 1);
    assert.deepEqual(body.remotes[0], watching);
  });

  it("reports the error and backoff of a failing remote", async () => {
    process.env.PORTUNI_AGENT_MODE = "1";
    setRemoteWatchStatusSource(() => [failing]);
    const res = await fetch(`${base}/sync/watch`);
    const body = (await res.json()) as SyncWatchResponse;
    assert.equal(body.remotes[0].watching, false);
    assert.match(body.remotes[0].last_error ?? "", /429/);
    assert.equal(body.remotes[0].backoff_until, "2026-09-19T10:07:00.000Z");
  });
});

describe("isoFromDbTimestamp", () => {
  it("reads the zone-less DB shape as UTC", () => {
    // remote_cursors.updated_at is datetime('now') / a normalized
    // TIMESTAMPTZ -- both zone-less UTC. Without this a client would parse
    // it in its own zone and show the cursor hours old or in the future.
    assert.equal(isoFromDbTimestamp("2026-09-19 10:00:00"), "2026-09-19T10:00:00.000Z");
  });

  it("passes an ISO value and null through", () => {
    assert.equal(isoFromDbTimestamp("2026-09-19T10:00:00.000Z"), "2026-09-19T10:00:00.000Z");
    assert.equal(isoFromDbTimestamp(null), null);
  });

  it("returns an unparseable value untouched", () => {
    assert.equal(isoFromDbTimestamp("not a date"), "not a date");
  });
});
