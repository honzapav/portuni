// #521: one rule for starting a server. Env mode (personal workspace, sync
// agent, standalone) never runs without PORTUNI_AUTH_TOKEN, on any host and
// with or without TURSO_URL; google mode (the central server) needs
// PORTUNI_JWT_SECRET and ignores PORTUNI_AUTH_TOKEN with one warning.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { assertAuthConfig, authSummary } from "../apps/server/infra/auth-config.js";
import { startHttpServer } from "../apps/server/http/server.js";

const KEYS = ["PORTUNI_AUTH_MODE", "PORTUNI_AUTH_TOKEN", "PORTUNI_JWT_SECRET", "TURSO_URL", "HOST", "PORTUNI_WORKSPACE_ID"] as const;
const JWT_SECRET = "x".repeat(32);

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("assertAuthConfig: env mode", () => {
  it("refuses to start without PORTUNI_AUTH_TOKEN, even on loopback with no Turso", () => {
    process.env.HOST = "127.0.0.1";
    assert.throws(() => assertAuthConfig(), /PORTUNI_AUTH_TOKEN/);
  });

  it("refuses a whitespace-only token", () => {
    process.env.PORTUNI_AUTH_TOKEN = "   ";
    assert.throws(() => assertAuthConfig(), /PORTUNI_AUTH_TOKEN/);
  });

  it("refuses without a token with a file: TURSO_URL (desktop) too", () => {
    process.env.TURSO_URL = "file:/tmp/portuni.db";
    assert.throws(() => assertAuthConfig(), /PORTUNI_AUTH_TOKEN/);
  });

  it("starts with a token, on any host and with a remote Turso", () => {
    process.env.PORTUNI_AUTH_TOKEN = "tok";
    process.env.HOST = "0.0.0.0";
    process.env.TURSO_URL = "libsql://team.turso.io";
    const warnings: string[] = [];
    assert.deepEqual(assertAuthConfig((l) => warnings.push(l)), []);
    assert.deepEqual(warnings, []);
  });

  it("startHttpServer refuses before listening", () => {
    assert.throws(
      () => startHttpServer({ port: 0, host: "127.0.0.1", registerSigint: false, mountMcp: false }),
      /PORTUNI_AUTH_TOKEN/,
    );
  });

  it("the summary says a token is required and never shows it", () => {
    process.env.PORTUNI_AUTH_TOKEN = "secret-do-not-print";
    process.env.PORTUNI_WORKSPACE_ID = "ws-x";
    const s = authSummary();
    assert.equal(s.has_auth_token, true);
    assert.doesNotMatch(s.banner, /secret-do-not-print/);
    assert.match(s.banner, /sha256 [0-9a-f]{8}\b/);
    assert.match(s.banner, /PORTUNI_MCP_TOKEN_WS_X/);
    assert.doesNotMatch(s.banner, /DISABLED/);
  });
});

describe("assertAuthConfig: google mode (central)", () => {
  beforeEach(() => {
    process.env.PORTUNI_AUTH_MODE = "google";
  });

  it("refuses to start without PORTUNI_JWT_SECRET", () => {
    assert.throws(() => assertAuthConfig(), /PORTUNI_JWT_SECRET/);
  });

  it("refuses a PORTUNI_JWT_SECRET shorter than 32 chars", () => {
    process.env.PORTUNI_JWT_SECRET = "short";
    assert.throws(() => assertAuthConfig(), /PORTUNI_JWT_SECRET/);
  });

  it("starts without PORTUNI_AUTH_TOKEN", () => {
    process.env.PORTUNI_JWT_SECRET = JWT_SECRET;
    const warnings: string[] = [];
    assert.deepEqual(assertAuthConfig((l) => warnings.push(l)), []);
    assert.deepEqual(warnings, []);
  });

  it("starts with PORTUNI_AUTH_TOKEN set, logging one warning line that it is ignored", () => {
    process.env.PORTUNI_JWT_SECRET = JWT_SECRET;
    process.env.PORTUNI_AUTH_TOKEN = "stray";
    const warnings: string[] = [];
    assertAuthConfig((l) => warnings.push(l));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /PORTUNI_AUTH_TOKEN.*ignored/);
    assert.doesNotMatch(warnings[0], /stray/);
  });
});
