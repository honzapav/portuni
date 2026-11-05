// The sync agent's long-poll of central's change feed (client traffic
// contract, rule 3): one request that waits for the next change replaces
// the window's per-node polls; a failure backs off, a 429 waits out the
// Retry-After, a reset is handed on so the window refetches what it shows.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createChangePoller } from "../apps/server/boot/change-poller.js";
import { CentralHttpError } from "../apps/server/domain/sync/central/client.js";
import type { ChangesResponse } from "../apps/server/shared/api-types.js";

type Step = ChangesResponse | Error;

function harness(steps: Step[]) {
  const fetched: Array<string | null> = [];
  const delivered: Array<{ changes: ChangesResponse["changes"]; reset: boolean }> = [];
  const slept: number[] = [];
  let i = 0;
  const poller = createChangePoller({
    fetchChanges: async (since) => {
      fetched.push(since);
      const step = steps[Math.min(i, steps.length - 1)];
      i += 1;
      if (i >= steps.length) poller.stop();
      if (step instanceof Error) throw step;
      return step;
    },
    onChanges: (changes, reset) => delivered.push({ changes, reset }),
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  return { poller, fetched, delivered, slept };
}

describe("createChangePoller", () => {
  it("passes the cursor along and delivers the changes", async () => {
    const h = harness([
      { cursor: "c1", reset: true, changes: [] },
      { cursor: "c2", reset: false, changes: [{ node_id: "n1", kind: "node", seq: 1 }] },
      { cursor: "c2", reset: false, changes: [] },
    ]);
    await h.poller.run();
    assert.deepEqual(h.fetched, [null, "c1", "c2"]);
    assert.deepEqual(h.delivered, [
      { changes: [], reset: true },
      { changes: [{ node_id: "n1", kind: "node", seq: 1 }], reset: false },
    ]);
    assert.deepEqual(h.slept, []);
  });

  it("backs off after a failure and keeps the cursor", async () => {
    const h = harness([
      { cursor: "c1", reset: true, changes: [] },
      new Error("down"),
      new Error("down"),
      { cursor: "c1", reset: false, changes: [] },
    ]);
    await h.poller.run();
    assert.deepEqual(h.fetched, [null, "c1", "c1", "c1"]);
    assert.deepEqual(h.slept, [5_000, 10_000]);
  });

  it("a 429 waits out the Retry-After", async () => {
    const h = harness([
      new CentralHttpError("rate limited", 429, "RATE_LIMITED", undefined, { retryAfterSeconds: 28 }),
      { cursor: "c1", reset: true, changes: [] },
    ]);
    await h.poller.run();
    assert.deepEqual(h.slept, [28_000]);
  });
});
