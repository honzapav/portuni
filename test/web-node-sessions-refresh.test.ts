// One coalesced list fetch per node (client traffic contract, rule 1),
// shared by the Práce sidebar's refresh in App.tsx and the Relace tab: a
// burst of callers while one fetch is in flight costs at most one more
// round trip, and the last one always wins.

import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  refreshNodeSessions,
  resetNodeSessionsRefreshForTesting,
} from "../apps/web/src/lib/node-sessions-refresh.js";

function deferredFetcher() {
  const resolvers: Array<() => void> = [];
  let calls = 0;
  const fetcher = (_nodeId: string): Promise<void> => {
    calls += 1;
    return new Promise<void>((resolve) => resolvers.push(resolve));
  };
  return { fetcher, calls: () => calls, resolveNext: () => resolvers.shift()?.() };
}

describe("refreshNodeSessions", () => {
  beforeEach(() => resetNodeSessionsRefreshForTesting());

  it("three calls during one flight cost two fetches in all", async () => {
    const { fetcher, calls, resolveNext } = deferredFetcher();
    const a = refreshNodeSessions("n1", fetcher);
    const b = refreshNodeSessions("n1", fetcher);
    const c = refreshNodeSessions("n1", fetcher);
    assert.equal(calls(), 1);
    resolveNext();
    await Promise.all([a, b, c]);
    assert.equal(calls(), 2, "one trailing fetch for the burst");
    resolveNext();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls(), 2);
  });

  it("a call after the flight settled fetches again", async () => {
    const { fetcher, calls, resolveNext } = deferredFetcher();
    const first = refreshNodeSessions("n1", fetcher);
    resolveNext();
    await first;
    await new Promise((r) => setTimeout(r, 0));
    const second = refreshNodeSessions("n1", fetcher);
    resolveNext();
    await second;
    assert.equal(calls(), 2);
  });

  it("different nodes do not share a flight", () => {
    const { fetcher, calls } = deferredFetcher();
    void refreshNodeSessions("n1", fetcher);
    void refreshNodeSessions("n2", fetcher);
    assert.equal(calls(), 2);
  });

  it("a failed fetch rejects the caller and leaves nothing in flight", async () => {
    const failing = (_nodeId: string) => Promise.reject(new Error("down"));
    await assert.rejects(refreshNodeSessions("n1", failing));
    const { fetcher, calls, resolveNext } = deferredFetcher();
    const next = refreshNodeSessions("n1", fetcher);
    resolveNext();
    await next;
    assert.equal(calls(), 1);
  });
});
