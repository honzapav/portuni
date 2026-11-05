// The window-level resource cache (client traffic contract, rule 4): data
// shared by the whole window is fetched once, callers during a flight share
// it, a failure is not kept, and an invalidation wins over an answer that
// was already on its way.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createKeyedResource, createResource } from "../apps/web/src/lib/resource.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createResource", () => {
  it("two gets during one flight share one load", async () => {
    let loads = 0;
    const d = deferred<string>();
    const res = createResource(() => {
      loads += 1;
      return d.promise;
    });
    const a = res.get();
    const b = res.get();
    d.resolve("v1");
    assert.equal(await a, "v1");
    assert.equal(await b, "v1");
    assert.equal(loads, 1);
    assert.equal(res.peek(), "v1");
    assert.equal(await res.get(), "v1");
    assert.equal(loads, 1);
  });

  it("a rejection is not kept: the next get loads again", async () => {
    let loads = 0;
    const res = createResource(() => {
      loads += 1;
      return loads === 1 ? Promise.reject(new Error("down")) : Promise.resolve("ok");
    });
    await assert.rejects(res.get());
    assert.equal(res.peek(), null);
    assert.equal(await res.get(), "ok");
    assert.equal(loads, 2);
  });

  it("invalidate clears the value and the next get loads again", async () => {
    let loads = 0;
    const res = createResource(() => Promise.resolve(`v${++loads}`));
    assert.equal(await res.get(), "v1");
    res.invalidate();
    assert.equal(res.peek(), null);
    assert.equal(await res.get(), "v2");
  });

  it("an invalidation during a flight wins: the flight's answer is not stored", async () => {
    const d = deferred<string>();
    let loads = 0;
    const res = createResource(() => {
      loads += 1;
      return loads === 1 ? d.promise : Promise.resolve("fresh");
    });
    const pending = res.get();
    res.invalidate();
    d.resolve("stale");
    assert.equal(await pending, "stale", "the caller still gets the answer it waited for");
    assert.equal(res.peek(), null);
    assert.equal(await res.get(), "fresh");
  });

  it("set stores the value and notifies subscribers; so do a stored answer and invalidate", async () => {
    const res = createResource(() => Promise.resolve("loaded"));
    let notified = 0;
    const off = res.subscribe(() => {
      notified += 1;
    });
    res.set("given");
    assert.equal(res.peek(), "given");
    assert.equal(notified, 1);
    res.invalidate();
    assert.equal(notified, 2);
    await res.get();
    assert.equal(notified, 3);
    off();
    res.set("silent");
    assert.equal(notified, 3);
  });
});

describe("createResource error state", () => {
  it("remembers the last failure until a load succeeds or the value is invalidated", async () => {
    let fail = true;
    const res = createResource(() => (fail ? Promise.reject(new Error("down")) : Promise.resolve("ok")));
    let notified = 0;
    res.subscribe(() => {
      notified += 1;
    });
    await assert.rejects(res.get());
    assert.ok(res.error() instanceof Error);
    assert.equal(notified, 1, "a failure notifies, so a view can show it");
    fail = false;
    await res.get();
    assert.equal(res.error(), null);
    res.invalidate();
    assert.equal(res.error(), null);
  });
});

describe("createKeyedResource", () => {
  it("keys load separately and invalidate() clears them all", async () => {
    const loads: string[] = [];
    const res = createKeyedResource<string, string>((key) => {
      loads.push(key);
      return Promise.resolve(`value:${key}`);
    });
    assert.equal(await res.get("a"), "value:a");
    assert.equal(await res.get("b"), "value:b");
    assert.equal(await res.get("a"), "value:a");
    assert.deepEqual(loads, ["a", "b"]);
    res.invalidate("a");
    assert.equal(res.peek("a"), null);
    assert.equal(res.peek("b"), "value:b");
    res.invalidate();
    assert.equal(res.peek("b"), null);
  });

  it("set stores one key and notifies", () => {
    const res = createKeyedResource<string, number>(() => Promise.resolve(0));
    let notified = 0;
    res.subscribe(() => {
      notified += 1;
    });
    res.set("k", 7);
    assert.equal(res.peek("k"), 7);
    assert.equal(notified, 1);
  });
});
