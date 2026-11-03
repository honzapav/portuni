// #633: what the sync agent's boot costs central. The boot backfill asks
// for every mirror's sync-info in one batch (syncInfoByNode) and hands it to
// listUntrackedLocalCentral, which then sends no request of its own; a quick
// restart skips the mirror config refresh (mirror-config-refresh-stamp).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CentralClient } from "../apps/server/domain/sync/central/client.js";
import type { NodeSyncInfo } from "../apps/server/domain/sync/sync-remote-api.js";
import {
  listUntrackedLocalCentral,
  syncInfoByNode,
  SYNC_INFO_BATCH_MAX,
} from "../apps/server/domain/sync/central/engine-central.js";
import {
  mirrorConfigsFresh,
  recordMirrorConfigsRefreshed,
  REFRESH_FRESH_MS,
} from "../apps/server/boot/mirror-config-refresh-stamp.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";

function infoFor(id: string): NodeSyncInfo {
  return {
    node: { id, type: "project", name: id, sync_key: id.toLowerCase(), org_sync_key: "org" },
    remote: null,
    files: [],
  } as unknown as NodeSyncInfo;
}

function countingClient(known: Set<string>) {
  const calls = { batch: [] as number[], single: 0 };
  const client = {
    async syncInfoBatch(ids: string[]) {
      calls.batch.push(ids.length);
      return ids.filter((id) => known.has(id)).map(infoFor);
    },
    async syncInfo(): Promise<NodeSyncInfo> {
      calls.single++;
      throw new Error("syncInfo must not be called when preloaded");
    },
  } as unknown as CentralClient;
  return { client, calls };
}

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "portuni-boot-load-"));
  process.env.PORTUNI_WORKSPACE_ROOT = dir;
  resetLocalDbForTests();
});

after(async () => {
  resetLocalDbForTests();
  delete process.env.PORTUNI_WORKSPACE_ROOT;
  await rm(dir, { recursive: true, force: true });
});

describe("boot backfill sync-info (#633)", () => {
  it("fetches every mirror's sync-info in one request and omits nodes central does not return", async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `N${i}`);
    const { client, calls } = countingClient(new Set(ids.slice(0, 38)));
    const map = await syncInfoByNode(client, [...ids, "N0"]);
    assert.deepEqual(calls.batch, [40], "one batch, duplicates collapsed");
    assert.equal(map.size, 38);
    assert.equal(map.has("N39"), false);
  });

  it("splits at the batch route's limit", async () => {
    const ids = Array.from({ length: SYNC_INFO_BATCH_MAX + 1 }, (_, i) => `N${i}`);
    const { client, calls } = countingClient(new Set(ids));
    const map = await syncInfoByNode(client, ids);
    assert.deepEqual(calls.batch, [SYNC_INFO_BATCH_MAX, 1]);
    assert.equal(map.size, ids.length);
  });

  it("listUntrackedLocalCentral with preloaded sync-info sends no request", async () => {
    const { client, calls } = countingClient(new Set());
    const r = await listUntrackedLocalCentral(
      client,
      { userId: "01SOLO0000000000000000000", nodeId: "N1" },
      infoFor("N1"),
    );
    assert.deepEqual(r, []);
    assert.equal(calls.single, 0);
  });
});

describe("mirror config refresh stamp (#633)", () => {
  const key = {
    mcpUrl: "http://127.0.0.1:47012/mcp",
    mirrors: [
      { node_id: "A", local_path: "/w/a" },
      { node_id: "B", local_path: "/w/b" },
    ],
  };

  it("no stamp means refresh", () => {
    assert.equal(mirrorConfigsFresh(join(dir, "nowhere"), key, 1_000), false);
  });

  it("a quick restart with the same URL and mirrors skips; otherwise it refreshes", () => {
    const t0 = 10_000_000;
    recordMirrorConfigsRefreshed(dir, key, t0);
    assert.equal(mirrorConfigsFresh(dir, key, t0 + 20_000), true);
    assert.equal(
      mirrorConfigsFresh(dir, { ...key, mirrors: [...key.mirrors].reverse() }, t0 + 20_000),
      true,
      "order does not matter",
    );
    assert.equal(mirrorConfigsFresh(dir, key, t0 + REFRESH_FRESH_MS), false, "too old");
    assert.equal(mirrorConfigsFresh(dir, { ...key, mcpUrl: "http://127.0.0.1:1/mcp" }, t0 + 1), false);
    assert.equal(
      mirrorConfigsFresh(dir, { ...key, mirrors: [...key.mirrors, { node_id: "C", local_path: "/w/c" }] }, t0 + 1),
      false,
      "a new mirror refreshes",
    );
  });
});
