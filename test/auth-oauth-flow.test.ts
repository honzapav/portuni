import { test } from "node:test";
import assert from "node:assert/strict";
import { signFlowState, verifyFlowState, type AuthorizeRequest } from "../apps/server/auth/oauth/flow.js";

const SECRET = "test-secret-at-least-32-characters-long!!";

const REQUEST: AuthorizeRequest = {
  clientId: "https://claude.ai/.well-known/client-metadata.json",
  redirectUri: "https://claude.ai/api/mcp/auth_callback",
  codeChallenge: "abc123",
  state: "client-state-xyz",
  resource: "https://api.portuni.com/mcp",
  scope: "portuni offline_access",
};

test("round-trips the authorize request without identity", async () => {
  const token = await signFlowState({ request: REQUEST }, SECRET);
  const state = await verifyFlowState(token, SECRET);
  assert.ok(state);
  assert.deepEqual(state?.request, REQUEST);
  assert.equal(state?.identity, undefined);
});

test("round-trips the identity once attached", async () => {
  const identity = {
    userId: "U1",
    email: "a@workflow.ooo",
    name: "A",
    avatarUrl: "https://example.com/a.png",
  };
  const token = await signFlowState({ request: REQUEST, identity }, SECRET);
  const state = await verifyFlowState(token, SECRET);
  assert.deepEqual(state?.identity, identity);
});

test("null avatarUrl round-trips", async () => {
  const identity = { userId: "U1", email: "a@workflow.ooo", name: "A", avatarUrl: null };
  const token = await signFlowState({ request: REQUEST, identity }, SECRET);
  const state = await verifyFlowState(token, SECRET);
  assert.deepEqual(state?.identity, identity);
});

test("wrong secret fails verification", async () => {
  const token = await signFlowState({ request: REQUEST }, SECRET);
  const state = await verifyFlowState(token, "a-completely-different-secret-value");
  assert.equal(state, null);
});

test("garbage token fails verification", async () => {
  const state = await verifyFlowState("not-a-jwt", SECRET);
  assert.equal(state, null);
});

test("expired token fails verification", async () => {
  const { SignJWT } = await import("jose");
  const key = new TextEncoder().encode(SECRET);
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ request: REQUEST })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("portuni-oauth-flow")
    .setIssuedAt(now - 20 * 60)
    .setExpirationTime(now - 10 * 60)
    .sign(key);
  const state = await verifyFlowState(token, SECRET);
  assert.equal(state, null);
});

test("token signed with a different issuer is rejected", async () => {
  const { SignJWT } = await import("jose");
  const key = new TextEncoder().encode(SECRET);
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ request: REQUEST })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("some-other-issuer")
    .setIssuedAt(now)
    .setExpirationTime(now + 600)
    .sign(key);
  const state = await verifyFlowState(token, SECRET);
  assert.equal(state, null);
});
