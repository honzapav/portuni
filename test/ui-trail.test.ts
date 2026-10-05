// #573: the on-device UI trail (apps/web/src/lib/ui-trail.ts). A ring of the
// last 300 entries, the API path without its query string, no body field
// in any entry, a flush of what came since the last one on every failure.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TRAIL_CAPACITY,
  createUiTrail,
  formatDiagnostics,
  newRequestId,
  stripQuery,
} from "../apps/web/src/lib/ui-trail.js";

const fixedNow = () => new Date("2026-10-05T10:00:00.000Z");

function api(path: string, status: number | null, extra: Record<string, unknown> = {}) {
  return {
    kind: "api" as const,
    method: "get",
    path,
    status,
    duration_ms: 12.4,
    request_id: "01JREQ",
    ...extra,
  };
}

describe("ui trail", () => {
  it("keeps only the last 300 entries", () => {
    assert.equal(TRAIL_CAPACITY, 300);
    const trail = createUiTrail({ now: fixedNow });
    for (let i = 0; i < 310; i++) trail.record({ kind: "view", url: `/?n=${i}` });
    const entries = trail.entries();
    assert.equal(entries.length, 300);
    assert.deepEqual(entries[0], { kind: "view", at: "2026-10-05T10:00:00.000Z", url: "/?n=10" });
    assert.equal((entries[299] as { url: string }).url, "/?n=309");
  });

  it("strips the query string and fragment from an API path", () => {
    assert.equal(stripQuery("/nodes/N1/files?q=secret+name#x"), "/nodes/N1/files");
    assert.equal(stripQuery("/graph#top"), "/graph");
    assert.equal(stripQuery("/graph"), "/graph");
    const trail = createUiTrail({ now: fixedNow });
    trail.record(api("/search?q=quarterly%20report", 200));
    const [entry] = trail.entries();
    assert.equal(entry.kind === "api" && entry.path, "/search");
    assert.ok(!trail.lines()[0].includes("quarterly"));
  });

  it("an entry never carries a request or response body", () => {
    const trail = createUiTrail({ now: fixedNow });
    // A caller passing more than the typed fields: nothing extra survives.
    trail.record(
      api("/nodes", 500, {
        code: "INTERNAL_ERROR",
        body: '{"name":"Secret project"}',
        response: '{"error":"x"}',
      }) as Parameters<typeof trail.record>[0],
    );
    trail.record({ kind: "error", label: "react-render", error: new TypeError("x is undefined") });
    const allowed = {
      api: ["kind", "at", "method", "path", "status", "duration_ms", "request_id", "code"],
      error: ["kind", "at", "label", "name", "message", "frame"],
    };
    for (const e of trail.entries()) {
      assert.deepEqual(Object.keys(e).sort(), [...allowed[e.kind as "api" | "error"]].sort());
    }
    const text = trail.lines().join("\n");
    assert.ok(!text.includes("Secret project"));
    assert.ok(text.includes("api GET /nodes -> 500 12ms id=01JREQ code=INTERNAL_ERROR"), text);
  });

  it("an error entry has the label, name, message and first stack frame", () => {
    const trail = createUiTrail({ now: fixedNow });
    const err = new TypeError("boom");
    err.stack = "TypeError: boom\n    at render (App.tsx:10:5)\n    at other (x.ts:1:1)";
    trail.record({ kind: "error", label: "unhandledrejection", error: err });
    trail.record({ kind: "error", label: "window.onerror", error: "plain string" });
    const [first, second] = trail.entries();
    assert.deepEqual(first, {
      kind: "error",
      at: "2026-10-05T10:00:00.000Z",
      label: "unhandledrejection",
      name: "TypeError",
      message: "boom",
      frame: "at render (App.tsx:10:5)",
    });
    assert.equal(second.kind === "error" && second.message, "plain string");
  });

  it("flushes the entries since the last flush on an error, a 5xx or a network failure", () => {
    const flushes: string[][] = [];
    const trail = createUiTrail({ now: fixedNow, flush: (lines) => flushes.push(lines) });
    trail.record({ kind: "view", url: "/?view=graph" });
    trail.record(api("/graph", 200));
    trail.record(api("/nodes/N1", 404, { code: "NOT_FOUND" }));
    assert.equal(flushes.length, 0, "a 2xx or 4xx does not flush");
    trail.record(api("/nodes", 502));
    assert.equal(flushes.length, 1);
    assert.equal(flushes[0].length, 4);
    trail.record(api("/nodes", null));
    assert.equal(flushes.length, 2);
    assert.deepEqual(flushes[1], ["2026-10-05T10:00:00.000Z api GET /nodes -> network-error 12ms id=01JREQ"]);
    trail.record({ kind: "error", label: "x", error: new Error("y") });
    assert.equal(flushes.length, 3);
    assert.equal(flushes[2].length, 1);
    assert.equal(trail.entries().length, 6, "flushing keeps the ring intact");
  });

  it("a throwing flusher never breaks recording", () => {
    const trail = createUiTrail({
      now: fixedNow,
      flush: () => {
        throw new Error("no log");
      },
    });
    trail.record(api("/nodes", 500));
    assert.equal(trail.entries().length, 1);
  });

  it("request ids are ULIDs", () => {
    const id = newRequestId(Date.UTC(2026, 9, 5));
    assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.notEqual(newRequestId(), newRequestId());
    assert.ok(newRequestId(1) < newRequestId(2 ** 40), "time-ordered prefix");
  });

  it("diagnostics text has the version, the workspace and the trail", () => {
    const text = formatDiagnostics({
      appVersion: "0.26.0",
      workspaceKind: "team",
      workspaceId: "acme",
      generatedAt: fixedNow(),
      lines: ["a", "b"],
    });
    assert.match(text, /app_version: 0\.26\.0/);
    assert.match(text, /workspace_kind: team/);
    assert.match(text, /workspace_id: acme/);
    assert.ok(text.endsWith("a\nb\n"));
  });
});
