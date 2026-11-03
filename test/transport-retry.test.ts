// #632: a read whose transport failed at startup (the window's first /graph
// and /me beat the sidecar to its socket) is sent again until the backend
// answers, so the sidebar loads without a reload. apiFetch wraps every call
// in withTransportRetry (apps/web/src/lib/transport-retry.ts).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TRANSPORT_RETRY_DELAYS_MS,
  isTransportFailure,
  withTransportRetry,
} from "../apps/web/src/lib/transport-retry.js";
import { DesktopError } from "../apps/web/src/lib/tauri-invoke.js";

// A backend that refuses the first `failures` calls per path the way the
// Rust proxy does when the sidecar is not answering yet (a reqwest error
// becomes UNKNOWN_DETAIL), then answers 200.
function startingBackend(failures: Record<string, number>) {
  const calls: Record<string, number> = {};
  return {
    calls,
    request(path: string): Promise<{ status: number; body: string }> {
      calls[path] = (calls[path] ?? 0) + 1;
      if (calls[path] <= (failures[path] ?? 0)) {
        return Promise.reject(
          new DesktopError("UNKNOWN_DETAIL", "error sending request for url (http://127.0.0.1:47012/graph)"),
        );
      }
      return Promise.resolve({ status: 200, body: JSON.stringify({ path }) });
    },
  };
}

function recordingSleep() {
  const waits: number[] = [];
  return { waits, sleep: (ms: number) => { waits.push(ms); return Promise.resolve(); } };
}

describe("transport retry (#632)", () => {
  it("loads /graph and /me whose first attempts hit a backend not answering yet", async () => {
    const backend = startingBackend({ "/graph": 2, "/me": 1 });
    const { waits, sleep } = recordingSleep();
    // The sidebar's two startup reads, issued together as App does.
    const [graph, me] = await Promise.all([
      withTransportRetry("GET", () => backend.request("/graph"), { sleep }),
      withTransportRetry("GET", () => backend.request("/me"), { sleep }),
    ]);
    assert.deepEqual(JSON.parse(graph.body), { path: "/graph" });
    assert.deepEqual(JSON.parse(me.body), { path: "/me" });
    assert.equal(backend.calls["/graph"], 3);
    assert.equal(backend.calls["/me"], 2);
    assert.deepEqual(waits.sort((a, b) => a - b), [250, 250, 500]);
  });

  it("retries a browser fetch TypeError and a backend not ready yet", async () => {
    const errors: unknown[] = [
      new TypeError("Failed to fetch"),
      new DesktopError("DESKTOP_BACKEND_NOT_READY", "not ready"),
    ];
    let n = 0;
    const res = await withTransportRetry(
      "get",
      () => (n < errors.length ? Promise.reject(errors[n++]) : Promise.resolve("ok")),
      { sleep: () => Promise.resolve() },
    );
    assert.equal(res, "ok");
  });

  it("never repeats a write", async () => {
    let n = 0;
    await assert.rejects(
      withTransportRetry("POST", () => { n++; return Promise.reject(new TypeError("Failed to fetch")); }, {
        sleep: () => Promise.resolve(),
      }),
      TypeError,
    );
    assert.equal(n, 1);
  });

  it("returns an HTTP answer unchanged, a 5xx included", async () => {
    let n = 0;
    const res = await withTransportRetry("GET", () => { n++; return Promise.resolve({ status: 503 }); }, {
      sleep: () => Promise.resolve(),
    });
    assert.equal(res.status, 503);
    assert.equal(n, 1);
  });

  it("does not retry a definite desktop state such as the sync agent being down", async () => {
    const err = new DesktopError("SYNC_AGENT_DOWN", "sync agent not running");
    assert.equal(isTransportFailure(err), false);
    let n = 0;
    await assert.rejects(
      withTransportRetry("GET", () => { n++; return Promise.reject(err); }, { sleep: () => Promise.resolve() }),
      (e) => e === err,
    );
    assert.equal(n, 1);
  });

  it("gives up after the budget and rethrows the last failure", async () => {
    const { waits, sleep } = recordingSleep();
    let n = 0;
    await assert.rejects(
      withTransportRetry("GET", () => { n++; return Promise.reject(new TypeError(`fail ${n}`)); }, { sleep }),
      /fail 6/,
    );
    assert.equal(n, TRANSPORT_RETRY_DELAYS_MS.length + 1);
    assert.deepEqual(waits, [...TRANSPORT_RETRY_DELAYS_MS]);
  });
});
