import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkAuthRequiredForConfig } from "../src/infra/server-config.js";

describe("checkAuthRequiredForConfig", () => {
  it("ok when auth enabled, regardless of host or Turso", () => {
    assert.deepEqual(
      checkAuthRequiredForConfig({ authEnabled: true, host: "0.0.0.0", tursoUrl: "libsql://x" }),
      { ok: true },
    );
  });

  it("ok when auth disabled but loopback host + no Turso", () => {
    assert.deepEqual(
      checkAuthRequiredForConfig({ authEnabled: false, host: "127.0.0.1", tursoUrl: "" }),
      { ok: true },
    );
    assert.deepEqual(
      checkAuthRequiredForConfig({ authEnabled: false, host: "localhost", tursoUrl: "" }),
      { ok: true },
    );
    assert.deepEqual(
      checkAuthRequiredForConfig({ authEnabled: false, host: "::1", tursoUrl: "" }),
      { ok: true },
    );
  });

  it("rejects auth disabled + non-loopback host", () => {
    const r = checkAuthRequiredForConfig({
      authEnabled: false,
      host: "0.0.0.0",
      tursoUrl: "",
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.message, /HOST=0\.0\.0\.0 is not a loopback/);
    }
  });

  it("rejects auth disabled + LAN host even if it looks loopback-ish", () => {
    const r = checkAuthRequiredForConfig({
      authEnabled: false,
      host: "192.168.1.10",
      tursoUrl: "",
    });
    assert.equal(r.ok, false);
  });

  it("rejects auth disabled + Turso URL set (team DB)", () => {
    const r = checkAuthRequiredForConfig({
      authEnabled: false,
      host: "127.0.0.1",
      tursoUrl: "libsql://team.turso.io",
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.message, /TURSO_URL is set/);
    }
  });

  it("collects multiple reasons when both bind and DB are non-local", () => {
    const r = checkAuthRequiredForConfig({
      authEnabled: false,
      host: "0.0.0.0",
      tursoUrl: "libsql://team.turso.io",
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reasons.length, 2);
    }
  });

  it("treats whitespace-only TURSO_URL as unset", () => {
    assert.deepEqual(
      checkAuthRequiredForConfig({ authEnabled: false, host: "127.0.0.1", tursoUrl: "   " }),
      { ok: true },
    );
  });
});
