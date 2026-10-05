// #573 Codex review: centralFetch (Account: /me, /auth/oauth-grants,
// /device-tokens) goes through the same trail and request id as apiFetch.
// A failing call hands central_request the id it records in the trail, so
// Copy diagnostics, the `ui` log and the central server's log share it.

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { centralFetch } from "../apps/web/src/lib/central.js";
import { setTrailFlusher, uiTrail } from "../apps/web/src/lib/ui-trail.js";

type Call = { cmd: string; args: Record<string, unknown> | undefined };

function tauriWindow() {
  (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  setTrailFlusher(() => undefined);
});

function lastApiEntry() {
  const api = uiTrail.entries().filter((e) => e.kind === "api");
  return api[api.length - 1];
}

describe("centralFetch trail and request id", () => {
  it("a 500 sends the id to central_request, records it and flushes", async () => {
    tauriWindow();
    const calls: Call[] = [];
    const flushed: string[][] = [];
    setTrailFlusher((lines) => flushed.push(lines));
    const call = (async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      return { status: 500, body: JSON.stringify({ code: "INTERNAL", request_id: "x" }) };
    }) as never;

    await assert.rejects(centralFetch("post", "/device-tokens", { label: "test" }, call));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, "central_request");
    const id = calls[0].args?.requestId;
    assert.equal(typeof id, "string");
    assert.match(id as string, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.deepEqual(calls[0].args?.body, { label: "test" });

    const entry = lastApiEntry();
    assert.ok(entry && entry.kind === "api");
    assert.equal(entry.method, "POST");
    assert.equal(entry.path, "/device-tokens");
    assert.equal(entry.status, 500);
    assert.equal(entry.request_id, id);
    assert.equal(entry.code, "INTERNAL");

    assert.equal(flushed.length, 1);
    assert.match(flushed[0][flushed[0].length - 1], new RegExp(`POST /device-tokens -> 500 .* id=${id} code=INTERNAL`));
  });

  it("a rejected invoke is a network-error entry with the id", async () => {
    tauriWindow();
    let sent: unknown;
    const call = (async (_cmd: string, args?: Record<string, unknown>) => {
      sent = args?.requestId;
      throw new Error("not logged in");
    }) as never;

    await assert.rejects(centralFetch("DELETE", "/device-tokens/T1", undefined, call), /not logged in/);
    const entry = lastApiEntry();
    assert.ok(entry && entry.kind === "api");
    assert.equal(entry.status, null);
    assert.equal(entry.request_id, sent);
  });

  it("a success records the status and returns the parsed body", async () => {
    tauriWindow();
    const call = (async () => ({ status: 200, body: '{"email":"a@b.c"}' })) as never;
    const me = await centralFetch<{ email: string }>("GET", "/me?x=1", undefined, call);
    assert.equal(me.email, "a@b.c");
    const entry = lastApiEntry();
    assert.ok(entry && entry.kind === "api");
    assert.equal(entry.status, 200);
    assert.equal(entry.path, "/me");
    assert.equal(entry.code, null);
  });
});
