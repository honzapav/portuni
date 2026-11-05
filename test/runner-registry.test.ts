// #645: the detection cache in domain/runner/registry.ts holds a usable
// answer for a minute, never a negative one -- a failed detection at boot
// must not keep the device "without a runner" for the next 60 s.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { FakeRunnerAdapter } from "../apps/server/domain/runner/adapters/fake.js";
import { clearRegistryForTests, detectAll, registerAdapter } from "../apps/server/domain/runner/registry.js";

afterEach(() => clearRegistryForTests());

function countingAdapter(): { adapter: FakeRunnerAdapter; calls: () => number; setLoggedIn: (v: boolean) => void } {
  let loggedIn = false;
  let n = 0;
  const adapter = new FakeRunnerAdapter({ script: [] });
  adapter.detect = async () => {
    n += 1;
    return { installed: true, version: "fake-1.0.0", logged_in: loggedIn, instances_supported: true };
  };
  return { adapter, calls: () => n, setLoggedIn: (v) => {
      loggedIn = v;
    } };
}

describe("runner registry: detectAll cache (#645)", () => {
  it("asks again after a negative detection instead of serving it from the cache", async () => {
    const { adapter, calls, setLoggedIn } = countingAdapter();
    registerAdapter(adapter);
    const t0 = 1_000_000;

    const first = await detectAll(t0);
    assert.equal(first[0].availability.logged_in, false);
    assert.equal(calls(), 1);

    setLoggedIn(true);
    const second = await detectAll(t0 + 1);
    assert.equal(second[0].availability.logged_in, true);
    assert.equal(calls(), 2);
  });

  it("holds a positive detection for the cache window, then asks again", async () => {
    const { adapter, calls, setLoggedIn } = countingAdapter();
    setLoggedIn(true);
    registerAdapter(adapter);
    const t0 = 1_000_000;

    await detectAll(t0);
    await detectAll(t0 + 59_000);
    assert.equal(calls(), 1);

    await detectAll(t0 + 60_000);
    assert.equal(calls(), 2);
  });

  it("drops a cached positive once the runner reads as signed out", async () => {
    const { adapter, calls, setLoggedIn } = countingAdapter();
    setLoggedIn(true);
    registerAdapter(adapter);
    const t0 = 1_000_000;

    await detectAll(t0);
    setLoggedIn(false);
    const expired = await detectAll(t0 + 60_000);
    assert.equal(expired[0].availability.logged_in, false);
    // Not cached: the next call probes again.
    await detectAll(t0 + 60_001);
    assert.equal(calls(), 3);
  });
});
