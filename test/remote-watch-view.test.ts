// The Settings › Sync watcher line and the pull-node signal
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
import { createI18n } from "../apps/server/shared/i18n/create.js";
import { RESOURCES } from "../apps/server/shared/i18n/resources.js";

const { i18n } = createI18n({
  lng: "en",
  resources: { en: RESOURCES.en, cs: RESOURCES.cs },
  escapeValue: false,
  initAsync: false,
});
const tEn = i18n.getFixedT("en", "files");
const tCs = i18n.getFixedT("cs", "files");

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
    const line = remoteWatchLine(status(), NOW, "en", tEn);
    assert.equal(line.tone, "ok");
    assert.equal(line.text, "drive watched, last change 2 minutes ago");
    assert.equal(line.retry, null);
  });

  it("says so when the watcher has seen no change yet", () => {
    const line = remoteWatchLine(status({ cursor_updated_at: null }), NOW, "en", tEn);
    assert.equal(line.tone, "ok");
    assert.match(line.text, /^drive watched, no change yet, checked /);
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
      tEn,
    );
    assert.equal(line.tone, "error");
    assert.equal(line.text, "drive: watching reports an error – 429 rate limit");
    assert.equal(line.retry, "next attempt in 2 minutes");
  });

  it("reports a backend with no change feed as sweep-only", () => {
    const line = remoteWatchLine(
      status({ watching: false, last_full_sweep_at: "2026-09-19T04:05:00.000Z" }),
      NOW,
      "en",
      tEn,
    );
    assert.equal(line.tone, "idle");
    assert.equal(
      line.text,
      "drive: no change watching, periodic check only (last 6 hours ago)",
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
      tEn,
    );
    assert.equal(line.tone, "error");
    assert.match(line.text, /^drive watched, last change 2 minutes ago/);
    assert.match(line.text, /the periodic check reports an error – catch-up sweep failed for N: Drive 403/);
    assert.equal(line.retry, "next attempt in 2 minutes");
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
      tEn,
    );
    assert.equal(line.tone, "error");
    assert.equal(line.text, "drive: no change watching, the periodic check reports an error – catch-up sweep failed for N: EACCES");
    assert.equal(line.retry, "next attempt in 30 minutes");
  });
});

describe("remoteWatchLine in Czech", () => {
  it("renders the same states from the Czech catalog, the error as a value", () => {
    assert.equal(
      remoteWatchLine(status(), NOW, "cs", tCs).text,
      "drive sledován, poslední změna před 2 minutami",
    );
    const failing = remoteWatchLine(
      status({ last_error: "429 rate limit", backoff_until: "2026-09-19T10:07:00.000Z" }),
      NOW,
      "cs",
      tCs,
    );
    assert.equal(failing.text, "drive: sledování hlásí chybu – 429 rate limit");
    assert.equal(failing.retry, "další pokus za 2 minuty");
  });
});

describe("pullNodeCount", () => {
  it("counts nodes, not files, and ignores nodes with no pull records", () => {
    assert.equal(pullNodeCount([{ pull: 4 }, { pull: 0 }, { pull: 1 }]), 2);
    assert.equal(pullNodeCount([]), 0);
  });
});
