// The Nastavení › Synchronizace watcher line and the pull-node signal
// (#339), as pure functions over GET /sync/watch's and GET /sync/pending's
// shapes. Same server-side-runner pattern as test/session-views-helpers.test.ts:
// apps/web has no test runner of its own.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  pullNodeCount,
  relativeCzech,
  remoteWatchLine,
} from "../apps/web/src/lib/remote-watch-view.js";
import type { RemoteWatchStatus } from "../apps/server/shared/api-types.js";

const NOW = Date.parse("2026-09-19T10:05:00.000Z");
const status = (over: Partial<RemoteWatchStatus> = {}): RemoteWatchStatus => ({
  remote_name: "drive",
  watching: true,
  cursor_updated_at: "2026-09-19T10:03:00.000Z",
  last_tick_at: "2026-09-19T10:05:00.000Z",
  last_error: null,
  backoff_until: null,
  last_full_sweep_at: null,
  ...over,
});

describe("remoteWatchLine", () => {
  it("reports a watching remote with the age of its cursor", () => {
    const line = remoteWatchLine(status(), NOW);
    assert.equal(line.tone, "ok");
    assert.equal(line.text, "drive sledován, poslední změna před 2 min");
    assert.equal(line.retry, null);
  });

  it("says so when the watcher has seen no change yet", () => {
    const line = remoteWatchLine(status({ cursor_updated_at: null }), NOW);
    assert.equal(line.tone, "ok");
    assert.match(line.text, /zatím žádná změna/);
  });

  it("reports the error and the pending retry of a failing remote", () => {
    const line = remoteWatchLine(
      status({
        watching: false,
        last_error: "429 rate limit",
        backoff_until: "2026-09-19T10:07:00.000Z",
      }),
      NOW,
    );
    assert.equal(line.tone, "error");
    assert.match(line.text, /429 rate limit/);
    assert.equal(line.retry, "další pokus za 2 min");
  });

  it("reports a backend with no change feed as sweep-only", () => {
    const line = remoteWatchLine(
      status({ watching: false, last_full_sweep_at: "2026-09-19T04:05:00.000Z" }),
      NOW,
    );
    assert.equal(line.tone, "idle");
    assert.equal(
      line.text,
      "drive: bez sledování změn, jen pravidelná kontrola (naposledy před 6 h)",
    );
  });
});

describe("relativeCzech", () => {
  it("collapses anything under a minute", () => {
    assert.equal(relativeCzech(NOW - 20_000, NOW), "právě teď");
  });

  it("counts days by Czech number agreement", () => {
    assert.equal(relativeCzech(NOW - 24 * 3600_000, NOW), "před 1 den");
    assert.equal(relativeCzech(NOW - 3 * 24 * 3600_000, NOW), "před 3 dny");
    assert.equal(relativeCzech(NOW - 9 * 24 * 3600_000, NOW), "před 9 dnů");
  });
});

describe("pullNodeCount", () => {
  it("counts nodes, not files, and ignores nodes with no pull records", () => {
    assert.equal(pullNodeCount([{ pull: 4 }, { pull: 0 }, { pull: 1 }]), 2);
    assert.equal(pullNodeCount([]), 0);
  });
});
