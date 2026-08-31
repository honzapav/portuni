import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchClientMetadata,
  redirectUriAllowed,
  __setCimdFetchForTests,
  __clearCimdCacheForTests,
} from "../apps/server/auth/oauth/cimd.js";

const CLIENT_URL = "https://claude.ai/.well-known/oauth-client-metadata/portuni.json";

function fakeFetch(
  handler: (url: string) => { status: number; body: string; headers?: Record<string, string> },
): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    const { status, body, headers } = handler(url);
    return new Response(body, { status, headers });
  }) as typeof fetch;
}

test.beforeEach(() => {
  __clearCimdCacheForTests();
});

test("valid self-referencing document resolves", async () => {
  __setCimdFetchForTests(
    fakeFetch(() => ({
      status: 200,
      body: JSON.stringify({
        client_id: CLIENT_URL,
        client_name: "Claude",
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      }),
    })),
  );
  const result = await fetchClientMetadata(CLIENT_URL);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.doc.client_id, CLIENT_URL);
  assert.equal(result.doc.client_name, "Claude");
  assert.deepEqual(result.doc.redirect_uris, ["https://claude.ai/api/mcp/auth_callback"]);
});

test("non-HTTPS client_id is rejected without a fetch", async () => {
  let called = false;
  __setCimdFetchForTests(
    fakeFetch(() => {
      called = true;
      return { status: 200, body: "{}" };
    }),
  );
  const result = await fetchClientMetadata("http://claude.ai/client.json");
  assert.equal(result.ok, false);
  assert.equal(called, false);
});

test("document whose client_id does not self-reference is rejected", async () => {
  __setCimdFetchForTests(
    fakeFetch(() => ({
      status: 200,
      body: JSON.stringify({
        client_id: "https://evil.example/client.json",
        redirect_uris: ["https://evil.example/callback"],
      }),
    })),
  );
  const result = await fetchClientMetadata(CLIENT_URL);
  assert.equal(result.ok, false);
});

test("oversized document is rejected", async () => {
  const big = JSON.stringify({
    client_id: CLIENT_URL,
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    padding: "x".repeat(200_000),
  });
  __setCimdFetchForTests(fakeFetch(() => ({ status: 200, body: big })));
  const result = await fetchClientMetadata(CLIENT_URL);
  assert.equal(result.ok, false);
});

test("malformed JSON is rejected", async () => {
  __setCimdFetchForTests(fakeFetch(() => ({ status: 200, body: "not json" })));
  const result = await fetchClientMetadata(CLIENT_URL);
  assert.equal(result.ok, false);
});

test("non-2xx fetch is rejected", async () => {
  __setCimdFetchForTests(fakeFetch(() => ({ status: 404, body: "not found" })));
  const result = await fetchClientMetadata(CLIENT_URL);
  assert.equal(result.ok, false);
});

test("second fetch within the cache TTL does not hit the network again", async () => {
  let calls = 0;
  __setCimdFetchForTests(
    fakeFetch(() => {
      calls += 1;
      return {
        status: 200,
        body: JSON.stringify({
          client_id: CLIENT_URL,
          redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        }),
      };
    }),
  );
  await fetchClientMetadata(CLIENT_URL);
  await fetchClientMetadata(CLIENT_URL);
  assert.equal(calls, 1);
});

test("redirectUriAllowed: exact HTTPS match", () => {
  assert.equal(
    redirectUriAllowed(
      ["https://claude.ai/api/mcp/auth_callback"],
      "https://claude.ai/api/mcp/auth_callback",
    ),
    true,
  );
});

test("redirectUriAllowed: HTTPS mismatch rejected", () => {
  assert.equal(
    redirectUriAllowed(["https://claude.ai/api/mcp/auth_callback"], "https://claude.ai/other"),
    false,
  );
});

test("redirectUriAllowed: loopback localhost ignores port", () => {
  assert.equal(
    redirectUriAllowed(["http://localhost:1234/callback"], "http://localhost:59087/callback"),
    true,
  );
});

test("redirectUriAllowed: loopback 127.0.0.1 ignores port", () => {
  assert.equal(
    redirectUriAllowed(["http://127.0.0.1:1234/callback"], "http://127.0.0.1:44321/callback"),
    true,
  );
});

test("redirectUriAllowed: loopback path mismatch rejected", () => {
  assert.equal(
    redirectUriAllowed(["http://localhost:1234/callback"], "http://localhost:59087/other"),
    false,
  );
});

test("redirectUriAllowed: non-loopback http rejected even with port variance", () => {
  assert.equal(
    redirectUriAllowed(["http://example.com:1234/callback"], "http://example.com:9999/callback"),
    false,
  );
});

test("redirectUriAllowed: malformed requested URI rejected", () => {
  assert.equal(redirectUriAllowed(["https://claude.ai/callback"], "not-a-uri"), false);
});
