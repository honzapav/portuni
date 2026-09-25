// The Nastavení › Synchronizace watcher line and the pull-node signal
// (#339), as pure functions over GET /sync/watch's and GET /sync/pending's
// shapes. Same server-side-runner pattern as test/session-views-helpers.test.ts:
// apps/web has no test runner of its own.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  pullNodeCount,
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
  sweep_error: null,
  sweep_backoff_until: null,
  ...over,
});

describe("remoteWatchLine", () => {
  it("reports a watching remote with the age of its cursor", () => {
    const line = remoteWatchLine(status(), NOW, "en");
    assert.equal(line.tone, "ok");
    assert.equal(line.text, "drive sledován, poslední změna 2 minutes ago");
    assert.equal(line.retry, null);
  });

  it("says so when the watcher has seen no change yet", () => {
    const line = remoteWatchLine(status({ cursor_updated_at: null }), NOW, "en");
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
      "en",
    );
    assert.equal(line.tone, "error");
    assert.match(line.text, /429 rate limit/);
    assert.equal(line.retry, "další pokus in 2 minutes");
  });

  it("reports a backend with no change feed as sweep-only", () => {
    const line = remoteWatchLine(
      status({ watching: false, last_full_sweep_at: "2026-09-19T04:05:00.000Z" }),
      NOW,
      "en",
    );
    assert.equal(line.tone, "idle");
    assert.equal(
      line.text,
      "drive: bez sledování změn, jen pravidelná kontrola (naposledy 6 hours ago)",
    );
  });
  it("keeps the feed line and reports the sweep's own error when only the sweep fails (#422)", () => {
    const line = remoteWatchLine(
      status({
        sweep_error: "catch-up sweep failed for N: Drive 403",
        sweep_backoff_until: "2026-09-19T10:07:00.000Z",
      }),
      NOW,
      "en",
    );
    assert.equal(line.tone, "error");
    assert.match(line.text, /^drive sledován, poslední změna 2 minutes ago/);
    assert.match(line.text, /pravidelná kontrola hlásí chybu – catch-up sweep failed for N: Drive 403/);
    assert.equal(line.retry, "další pokus in 2 minutes");
  });

  it("a sweep-only backend reports its sweep error in place of the sweep age", () => {
    const line = remoteWatchLine(
      status({
        watching: false,
        last_full_sweep_at: "2026-09-19T04:05:00.000Z",
        sweep_error: "catch-up sweep failed for N: EACCES",
        sweep_backoff_until: "2026-09-19T10:35:00.000Z",
      }),
      NOW,
      "en",
    );
    assert.equal(line.tone, "error");
    assert.equal(line.text, "drive: bez sledování změn, pravidelná kontrola hlásí chybu – catch-up sweep failed for N: EACCES");
    assert.equal(line.retry, "další pokus in 30 minutes");
  });
});

describe("pullNodeCount", () => {
  it("counts nodes, not files, and ignores nodes with no pull records", () => {
    assert.equal(pullNodeCount([{ pull: 4 }, { pull: 0 }, { pull: 1 }]), 2);
    assert.equal(pullNodeCount([]), 0);
  });
});
