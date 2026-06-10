// Unit tests for src/http/rate-limit.ts plus a server-wiring integration test.
//
// The pure-module tests use an injected `now` function so time is fully under
// test control. No HTTP server is needed for those.
//
// The integration test boots an in-process server with
// PORTUNI_RATE_LIMIT_PER_MIN=3, fires 5 requests at /graph, expects at least
// one 429, and confirms /health is never rate-limited.
//
// Port assignment must happen BEFORE any src/ import because middleware reads
// process.env.PORT at first use.

process.env.PORT = "14930";
process.env.HOST = "127.0.0.1";
process.env.PORTUNI_AUTH_TOKEN = "";
process.env.PORTUNI_RATE_LIMIT_PER_MIN = "3";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { ensureSchemaOn } from "../src/infra/schema.js";
import { setDbForTesting } from "../src/infra/db.js";
import { resetGateCachesForTesting } from "../src/http/middleware.js";
import { resetRateLimiterForTesting } from "../src/http/rate-limit.js";
import { startHttpServer, type HttpServerHandle } from "../src/http/server.js";
import { createRateLimiter, rateLimitKey } from "../src/http/rate-limit.js";

// ---------------------------------------------------------------------------
// Pure unit tests — no HTTP
// ---------------------------------------------------------------------------

describe("createRateLimiter", () => {
  it("allows requests under the limit", () => {
    const t = 0;
    const lim = createRateLimiter({ limitPerMinute: 5, now: () => t });
    for (let i = 0; i < 5; i++) {
      const r = lim.check("key1");
      assert.ok(r.allowed, `request ${i + 1} should be allowed`);
    }
  });

  it("blocks when the limit is reached and returns a positive retryAfterSeconds", () => {
    const t = 0;
    const lim = createRateLimiter({ limitPerMinute: 3, now: () => t });
    for (let i = 0; i < 3; i++) lim.check("key1");
    const blocked = lim.check("key1");
    assert.ok(!blocked.allowed, "4th request must be blocked");
    assert.ok(
      blocked.retryAfterSeconds >= 1,
      `retryAfterSeconds should be >= 1, got ${blocked.retryAfterSeconds}`,
    );
  });

  it("allows again after the window slides past the oldest requests", () => {
    let t = 0;
    const lim = createRateLimiter({ limitPerMinute: 3, now: () => t });

    // Fill the limit at t=0
    for (let i = 0; i < 3; i++) lim.check("key1");
    assert.ok(!lim.check("key1").allowed, "should be blocked immediately");

    // Advance 61 seconds — all buckets from t=0 are now stale
    t = 61_000;
    const r = lim.check("key1");
    assert.ok(r.allowed, "should be allowed after window expires");
  });

  it("disabled mode (limitPerMinute <= 0) always returns allowed", () => {
    const lim = createRateLimiter({ limitPerMinute: 0 });
    for (let i = 0; i < 1000; i++) {
      assert.ok(lim.check("any").allowed);
    }
  });

  it("disabled mode with negative limit also always allows", () => {
    const lim = createRateLimiter({ limitPerMinute: -1 });
    assert.ok(lim.check("any").allowed);
  });

  it("tracks keys independently", () => {
    const t = 0;
    const lim = createRateLimiter({ limitPerMinute: 2, now: () => t });
    lim.check("alice");
    lim.check("alice");
    // alice is now blocked
    assert.ok(!lim.check("alice").allowed);
    // bob is still fresh
    assert.ok(lim.check("bob").allowed);
  });
});

// ---------------------------------------------------------------------------
// rateLimitKey derivation
// ---------------------------------------------------------------------------

describe("rateLimitKey", () => {
  it("hashes the bearer token — key is not the plaintext token", () => {
    const token = "super-secret-token";
    const key = rateLimitKey(`Bearer ${token}`, "127.0.0.1");
    assert.ok(key.startsWith("bearer:"), `key should start with 'bearer:': ${key}`);
    assert.ok(!key.includes(token), "plaintext token must not appear in the key");
  });

  it("same token always produces the same key", () => {
    const k1 = rateLimitKey("Bearer abc123", undefined);
    const k2 = rateLimitKey("Bearer abc123", undefined);
    assert.equal(k1, k2);
  });

  it("different tokens produce different keys", () => {
    const k1 = rateLimitKey("Bearer token-a", undefined);
    const k2 = rateLimitKey("Bearer token-b", undefined);
    assert.notEqual(k1, k2);
  });

  it("falls back to ip:<address> when no bearer token", () => {
    const key = rateLimitKey(undefined, "10.0.0.1");
    assert.equal(key, "ip:10.0.0.1");
  });

  it("falls back to 'anon' when neither bearer nor address present", () => {
    const key = rateLimitKey(undefined, undefined);
    assert.equal(key, "anon");
  });

  it("uses ip fallback when Authorization header present but not Bearer", () => {
    const key = rateLimitKey("Basic dXNlcjpwYXNz", "192.168.1.1");
    assert.equal(key, "ip:192.168.1.1");
  });
});

// ---------------------------------------------------------------------------
// Server wiring integration test
// ---------------------------------------------------------------------------

const BASE = "http://127.0.0.1:14930";
let handle: HttpServerHandle;

before(async () => {
  resetGateCachesForTesting();
  // Reset the cached limiter so it picks up the env var set at the top of
  // this file (PORTUNI_RATE_LIMIT_PER_MIN=3) rather than a stale zero-valued
  // limiter from another test module that imported the module first.
  resetRateLimiterForTesting();

  const db = createClient({ url: ":memory:" });
  await ensureSchemaOn(db);
  setDbForTesting(db);

  handle = startHttpServer({ port: 14930, host: "127.0.0.1", registerSigint: false });
  await new Promise((r) => setImmediate(r));
});

after(async () => {
  await handle.shutdown();
  setDbForTesting(null);
  // Leave the limiter in clean state for any test that runs after.
  resetRateLimiterForTesting();
});

describe("server rate-limit wiring", () => {
  it("enforces the limit: /graph gets a 429 after 3 requests", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${BASE}/graph`);
      statuses.push(res.status);
    }
    assert.ok(
      statuses.includes(429),
      `expected at least one 429 among ${statuses.join(", ")}`,
    );
  });

  it("/health is never rate-limited regardless of prior traffic", async () => {
    // Hit the server many times to ensure the rate limit would trigger for
    // a normal path, then confirm /health still returns 200.
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${BASE}/health`);
      assert.equal(res.status, 200, `/health must never return 429 (request ${i + 1})`);
    }
  });

  it("429 response includes Retry-After header and JSON body", async () => {
    // After the earlier test the key should be exhausted; just fire until we
    // get a 429 (at most 5 more times).
    let tooManyRes: Response | null = null;
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${BASE}/graph`);
      if (r.status === 429) {
        tooManyRes = r;
        break;
      }
    }
    assert.ok(tooManyRes !== null, "expected to receive a 429");
    const retryAfter = tooManyRes.headers.get("Retry-After");
    assert.ok(retryAfter !== null, "Retry-After header must be present");
    assert.ok(Number(retryAfter) >= 1, `Retry-After should be >= 1, got ${retryAfter}`);
    const body = (await tooManyRes.json()) as { error: string };
    assert.equal(body.error, "rate limited");
  });
});
