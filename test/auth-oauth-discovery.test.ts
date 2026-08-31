import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildProtectedResourceMetadata,
  buildAuthorizationServerMetadata,
} from "../apps/server/auth/oauth/discovery.js";

const ISSUER = "https://api.portuni.com";

test("protected-resource metadata shape (RFC 9728)", () => {
  const doc = buildProtectedResourceMetadata(ISSUER);
  assert.deepEqual(doc, {
    resource: "https://api.portuni.com/mcp",
    authorization_servers: ["https://api.portuni.com"],
    bearer_methods_supported: ["header"],
    scopes_supported: ["portuni", "offline_access"],
  });
});

test("authorization-server metadata shape (RFC 8414)", () => {
  const doc = buildAuthorizationServerMetadata(ISSUER);
  assert.deepEqual(doc, {
    issuer: "https://api.portuni.com",
    authorization_endpoint: "https://api.portuni.com/oauth/authorize",
    token_endpoint: "https://api.portuni.com/oauth/token",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    scopes_supported: ["portuni", "offline_access"],
  });
});
