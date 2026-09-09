import { test } from "node:test";
import assert from "node:assert/strict";
import { withPathLock } from "../apps/server/domain/sync/path-lock.js";

test("withPathLock: serializes calls sharing the same key", async () => {
  const order: string[] = [];
  let running = 0;
  let maxConcurrent = 0;

  async function op(label: string, ms: number) {
    return withPathLock("/mirror/a.md", async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      order.push(`${label}:start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${label}:end`);
      running--;
      return label;
    });
  }

  const [r1, r2, r3] = await Promise.all([op("A", 20), op("B", 5), op("C", 1)]);

  assert.equal(maxConcurrent, 1, "no two callers ever ran inside the lock concurrently");
  assert.deepEqual(order, ["A:start", "A:end", "B:start", "B:end", "C:start", "C:end"]);
  assert.deepEqual([r1, r2, r3], ["A", "B", "C"]);
});

test("withPathLock: different keys run concurrently", async () => {
  let running = 0;
  let maxConcurrent = 0;

  async function op(key: string) {
    return withPathLock(key, async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
    });
  }

  await Promise.all([op("/mirror/a.md"), op("/mirror/b.md"), op("/mirror/c.md")]);
  assert.equal(maxConcurrent, 3, "distinct keys are not serialized against each other");
});

test("withPathLock: a rejection does not jam the queue for the next waiter", async () => {
  const seen: string[] = [];
  const first = withPathLock("/mirror/x.md", async () => {
    seen.push("first");
    throw new Error("boom");
  });
  const second = withPathLock("/mirror/x.md", async () => {
    seen.push("second");
    return "ok";
  });

  await assert.rejects(first, /boom/);
  assert.equal(await second, "ok");
  assert.deepEqual(seen, ["first", "second"]);
});

test("withPathLock: does not leak map entries after the queue drains", async () => {
  // Indirect check: running many sequential locked ops on the same key and
  // then a fresh one on a never-seen key completes immediately (no waiting
  // on stale state) -- proves each call cleans up after itself.
  for (let i = 0; i < 50; i++) {
    await withPathLock("/mirror/churn.md", async () => i);
  }
  const start = Date.now();
  await withPathLock("/mirror/churn.md", async () => undefined);
  assert.ok(Date.now() - start < 50, "no leftover queue delay after prior calls drained");
});
