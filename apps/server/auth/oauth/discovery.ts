// RFC 9728 (protected-resource metadata) and RFC 8414 (authorization-server
// metadata) document builders. Pure functions over the canonical issuer URL
// (PORTUNI_PUBLIC_URL) so the route layer (apps/server/api/oauth.ts, issue
// #172) only has to serialize the result.
// Spec: docs/superpowers/specs/2026-08-31-oauth-connectors-design.md
// ("Endpoints").

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  scopes_supported: string[];
}

export function buildProtectedResourceMetadata(issuer: string): ProtectedResourceMetadata {
  return {
    resource: `${issuer}/mcp`,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: ["portuni", "offline_access"],
  };
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  client_id_metadata_document_supported: boolean;
  scopes_supported: string[];
}

export function buildAuthorizationServerMetadata(issuer: string): AuthorizationServerMetadata {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    scopes_supported: ["portuni", "offline_access"],
  };
}
