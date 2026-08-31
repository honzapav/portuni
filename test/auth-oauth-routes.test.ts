// Integration smoke test for the OAuth connector routes (issue #172):
// discovery, authorize, upstream callback (fake adapter), consent, token
// (authorization_code + refresh_token grants), and the disabled-config
// 404s. Same in-process server harness as rest-auth.test.ts, with a fake
// IdentityAdapter (interactiveLogin) via setIdentityContextForTesting and
// a fake CIMD fetch so no real Google/claude.ai call is ever made.

process.env.PORT = "14940";
process.env.HOST = "127.0.0.1";
process.env.PORTUNI_AUTH_TOKEN = "";
process.env.PORTUNI_PUBLIC_URL = "https://api.portuni.test";

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { createClient, type Client } from "@libsql/client";
import { ensureSchemaOn } from "../apps/server/infra/schema.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import {
  resetGateCachesForTesting,
  setIdentityContextForTesting,
  resetIdentityContextForTesting,
} from "../apps/server/http/middleware.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { startHttpServer, type HttpServerHandle } from "../apps/server/http/server.js";
import type { IdentityAdapter, Identity } from "../apps/server/auth/adapter.js";
import { __setCimdFetchForTests, __clearCimdCacheForTests } from "../apps/server/auth/oauth/cimd.js";

const base = "http://127.0.0.1:14940";
const JWT_SECRET = "test-oauth-routes-secret-at-least-32-chars!!";
const CLIENT_ID = "https://claude.ai/.well-known/oauth-client-metadata/portuni.json";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

let handle: HttpServerHandle;
let workspace: string;
let db: Client;

function fakeCimdFetch(): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    if (url === CLIENT_ID) {
      return new Response(
        JSON.stringify({
          client_id: CLIENT_ID,
          client_name: "Claude",
          redirect_uris: [REDIRECT_URI],
        }),
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function fakeAdapter(): IdentityAdapter {
  return {
    async verify(): Promise<Identity> {
      throw new Error("verify() not used by the connector flow");
    },
    async resolveAccess() {
      return { globalScope: "write", groups: [], groupIds: [] };
    },
    interactiveLogin: {
      redirectUrl(state: string) {
        return `https://accounts.google.com/o/oauth2/auth?state=${encodeURIComponent(state)}`;
      },
      async handleCallback(params: URLSearchParams) {
        const code = params.get("code");
        if (code === "deny") throw new Error("Google OAuth error: access_denied");
        if (!code) throw new Error("Missing Google authorization code");
        return {
          identity: { email: "a@workflow.ooo", name: "A Person", sub: "google-sub-1" },
          avatarUrl: "https://example.com/a.png",
        };
      },
    },
  };
}

function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function extractHidden(html: string, name: string): string {
  const m = html.match(new RegExp(`name="${name}" value="([^"]*)"`));
  assert.ok(m, `expected hidden field ${name} in consent page`);
  return m![1];
}

async function runAuthorizeThroughConsent(): Promise<{ code: string; state: string }> {
  const { challenge } = lastPkce;
  const authorizeUrl = new URL(`${base}/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("state", "client-state-1");
  authorizeUrl.searchParams.set("resource", "https://api.portuni.test/mcp");
  authorizeUrl.searchParams.set("scope", "portuni offline_access");

  const authorizeRes = await fetch(authorizeUrl, { redirect: "manual" });
  assert.equal(authorizeRes.status, 302);
  const googleUrl = new URL(authorizeRes.headers.get("location")!);
  const flowState = googleUrl.searchParams.get("state")!;
  assert.ok(flowState);

  const callbackUrl = new URL(`${base}/oauth/google/callback`);
  callbackUrl.searchParams.set("state", flowState);
  callbackUrl.searchParams.set("code", "google-code-ok");
  const callbackRes = await fetch(callbackUrl);
  assert.equal(callbackRes.status, 200);
  const html = await callbackRes.text();
  assert.match(html, /A Person/);
  assert.match(html, /Claude/);
  const continuationToken = extractHidden(html, "token");

  const consentRes = await fetch(`${base}/oauth/consent`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: continuationToken, decision: "allow" }),
    redirect: "manual",
  });
  assert.equal(consentRes.status, 302);
  const redirect = new URL(consentRes.headers.get("location")!);
  assert.equal(`${redirect.origin}${redirect.pathname}`, REDIRECT_URI);
  const code = redirect.searchParams.get("code")!;
  const state = redirect.searchParams.get("state")!;
  assert.equal(state, "client-state-1");
  assert.ok(code);
  return { code, state };
}

let lastPkce: { verifier: string; challenge: string };

before(async () => {
  resetGateCachesForTesting();
  workspace = await mkdtemp(join(tmpdir(), "portuni-oauth-routes-"));
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
  db = createClient({ url: ":memory:" });
  await ensureSchemaOn(db);
  setDbForTesting(db);
  setIdentityContextForTesting({
    db,
    mode: "google",
    jwtSecret: JWT_SECRET,
    adapter: fakeAdapter(),
    soloUserId: "01SOLO0000000000000000000",
  });

  handle = startHttpServer({ port: 14940, host: "127.0.0.1", registerSigint: false });
  await new Promise((r) => setImmediate(r));
});

after(async () => {
  await handle.shutdown();
  setDbForTesting(null);
  resetIdentityContextForTesting();
  resetLocalDbForTests();
  await rm(workspace, { recursive: true, force: true });
});

beforeEach(() => {
  __clearCimdCacheForTests();
  __setCimdFetchForTests(fakeCimdFetch());
  lastPkce = pkcePair();
});

describe("discovery documents", () => {
  it("GET /.well-known/oauth-authorization-server", async () => {
    const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.issuer, "https://api.portuni.test");
    assert.equal(body.authorization_endpoint, "https://api.portuni.test/oauth/authorize");
    assert.equal(body.token_endpoint, "https://api.portuni.test/oauth/token");
    assert.deepEqual(body.grant_types_supported, ["authorization_code", "refresh_token"]);
    assert.equal(body.client_id_metadata_document_supported, true);
  });

  it("GET /.well-known/oauth-protected-resource", async () => {
    const res = await fetch(`${base}/.well-known/oauth-protected-resource`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.resource, "https://api.portuni.test/mcp");
    assert.deepEqual(body.authorization_servers, ["https://api.portuni.test"]);
  });
});

describe("authorize parameter errors", () => {
  it("renders an error page instead of redirecting on a missing parameter", async () => {
    const res = await fetch(`${base}/oauth/authorize?client_id=${encodeURIComponent(CLIENT_ID)}`, {
      redirect: "manual",
    });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("content-type")?.includes("text/html"), true);
    const html = await res.text();
    assert.match(html, /chyb/i);
  });

  it("rejects a redirect_uri not registered for the client", async () => {
    const url = new URL(`${base}/oauth/authorize`);
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", "https://evil.example/callback");
    url.searchParams.set("code_challenge", lastPkce.challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", "s1");
    url.searchParams.set("resource", "https://api.portuni.test/mcp");
    const res = await fetch(url, { redirect: "manual" });
    assert.equal(res.status, 400);
  });

  it("rejects an unrecognized resource", async () => {
    const url = new URL(`${base}/oauth/authorize`);
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("code_challenge", lastPkce.challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", "s1");
    url.searchParams.set("resource", "https://not-us.example/mcp");
    const res = await fetch(url, { redirect: "manual" });
    assert.equal(res.status, 400);
  });
});

describe("full authorize -> consent -> token flow", () => {
  it("issues an access + refresh token pair", async () => {
    const { code } = await runAuthorizeThroughConsent();

    const tokenRes = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: lastPkce.verifier,
      }),
    });
    assert.equal(tokenRes.status, 200);
    const tokens = (await tokenRes.json()) as Record<string, unknown>;
    assert.ok((tokens.access_token as string).startsWith("poa_"));
    assert.ok((tokens.refresh_token as string).startsWith("por_"));
    assert.equal(tokens.token_type, "Bearer");
    assert.equal(tokens.expires_in, 3600);

    // Refresh rotation: old refresh token works once...
    const refreshRes = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token as string,
      }),
    });
    assert.equal(refreshRes.status, 200);
    const rotated = (await refreshRes.json()) as Record<string, unknown>;
    assert.ok((rotated.access_token as string).startsWith("poa_"));
    assert.notEqual(rotated.refresh_token, tokens.refresh_token);

    // ...and a replay of the superseded refresh token is invalid_grant.
    const replayRes = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token as string,
      }),
    });
    assert.equal(replayRes.status, 400);
    const replayBody = (await replayRes.json()) as Record<string, unknown>;
    assert.equal(replayBody.error, "invalid_grant");

    // The rotated (currently valid) refresh token is also dead now: theft
    // detection revoked the whole grant.
    const afterTheftRes = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: rotated.refresh_token as string,
      }),
    });
    assert.equal(afterTheftRes.status, 400);
  });

  it("rejects a second redemption of the same authorization code", async () => {
    const { code } = await runAuthorizeThroughConsent();
    const body = () =>
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: lastPkce.verifier,
      });

    const first = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body(),
    });
    assert.equal(first.status, 200);

    const second = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body(),
    });
    assert.equal(second.status, 400);
    const secondBody = (await second.json()) as Record<string, unknown>;
    assert.equal(secondBody.error, "invalid_grant");
  });

  it("rejects a mismatched PKCE code_verifier", async () => {
    const { code } = await runAuthorizeThroughConsent();
    const res = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: "wrong-verifier",
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.error, "invalid_grant");
  });

  it("denying consent redirects with error=access_denied and no code", async () => {
    const authorizeUrl = new URL(`${base}/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", CLIENT_ID);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authorizeUrl.searchParams.set("code_challenge", lastPkce.challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", "client-state-deny");
    authorizeUrl.searchParams.set("resource", "https://api.portuni.test/mcp");
    const authorizeRes = await fetch(authorizeUrl, { redirect: "manual" });
    const googleUrl = new URL(authorizeRes.headers.get("location")!);
    const flowState = googleUrl.searchParams.get("state")!;

    const callbackUrl = new URL(`${base}/oauth/google/callback`);
    callbackUrl.searchParams.set("state", flowState);
    callbackUrl.searchParams.set("code", "google-code-ok");
    const html = await (await fetch(callbackUrl)).text();
    const continuationToken = extractHidden(html, "token");

    const consentRes = await fetch(`${base}/oauth/consent`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: continuationToken, decision: "deny" }),
      redirect: "manual",
    });
    assert.equal(consentRes.status, 302);
    const redirect = new URL(consentRes.headers.get("location")!);
    assert.equal(redirect.searchParams.get("error"), "access_denied");
    assert.equal(redirect.searchParams.get("code"), null);
    assert.equal(redirect.searchParams.get("state"), "client-state-deny");
  });
});

describe("disabled configuration -> 404", () => {
  it("404s in env auth mode", async () => {
    setIdentityContextForTesting({
      db,
      mode: "env",
      jwtSecret: "",
      adapter: { async verify() { return { email: "solo@localhost", name: "Solo", sub: "env:solo" }; }, async resolveAccess() { return { globalScope: "admin", groups: [], groupIds: [] }; } },
      soloUserId: "01SOLO0000000000000000000",
    });
    try {
      const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
      assert.equal(res.status, 404);
      const authorizeRes = await fetch(`${base}/oauth/authorize?client_id=x`);
      assert.equal(authorizeRes.status, 404);
    } finally {
      setIdentityContextForTesting({
        db,
        mode: "google",
        jwtSecret: JWT_SECRET,
        adapter: fakeAdapter(),
        soloUserId: "01SOLO0000000000000000000",
      });
    }
  });

  it("404s in google mode without PORTUNI_PUBLIC_URL", async () => {
    delete process.env.PORTUNI_PUBLIC_URL;
    try {
      const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
      assert.equal(res.status, 404);
    } finally {
      process.env.PORTUNI_PUBLIC_URL = "https://api.portuni.test";
    }
  });

  it("404s when the adapter has no interactiveLogin capability", async () => {
    setIdentityContextForTesting({
      db,
      mode: "google",
      jwtSecret: JWT_SECRET,
      adapter: { async verify() { return { email: "a@workflow.ooo", name: "A", sub: "g1" }; }, async resolveAccess() { return { globalScope: "write", groups: [], groupIds: [] }; } },
      soloUserId: "01SOLO0000000000000000000",
    });
    try {
      const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
      assert.equal(res.status, 404);
    } finally {
      setIdentityContextForTesting({
        db,
        mode: "google",
        jwtSecret: JWT_SECRET,
        adapter: fakeAdapter(),
        soloUserId: "01SOLO0000000000000000000",
      });
    }
  });
});

describe("unsupported token grant_type", () => {
  it("returns unsupported_grant_type", async () => {
    const res = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "password" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.error, "unsupported_grant_type");
  });
});
