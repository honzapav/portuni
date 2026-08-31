# OAuth connectors: chat clients → central MCP

Claude chat clients (claude.ai web, Claude Desktop chat, mobile) and native
MCP clients (Claude Code) connect to the central Portuni MCP server
(`https://api.portuni.com/mcp`) as a custom connector: the user enters one
URL, logs in with Google, approves a consent screen. No config file, no
token copying. The central server becomes an OAuth 2.1 authorization server
that federates to Google as the upstream IdP and mints its own tokens.

Complements, does not replace: device tokens (`ptk_`) and the `mcp-remote`
bridge keep working unchanged.

## Decisions

- **CIMD, no DCR.** The AS metadata advertises
  `client_id_metadata_document_supported: true` and
  `token_endpoint_auth_methods_supported: ["none"]`; Claude then uses Client
  ID Metadata Documents and never calls a registration endpoint. No
  `registration_endpoint` is built and no client table exists — a client is
  identified by its CIMD URL, metadata fetched and cached in memory.
- **Opaque tokens over the device-token pattern**, not JWTs: access
  (`poa_`, 1 h) and refresh (`por_`, rotated) tokens are random, stored as
  sha256 hashes. Roles are resolved per request via the identity adapter
  (`resolveAccess`, 15-min cache) — never baked into the token, so
  revocation is immediate and group changes propagate.
- **Refresh lifetime 180 days, absolute.** Counted from the initial grant,
  not sliding: after 180 days the user re-consents. Matches device-token
  TTL.
- **Consent every authorize.** Per-client consent is never persisted; the
  screen shows on every authorization-code flow (once per ~180 days per
  client). This kills the stale-consent confused-deputy class outright.
- **Claude Code included.** Loopback redirect URIs (`http://localhost/…`,
  `http://127.0.0.1/…`) are accepted with the port component ignored
  (RFC 8252); everything else must be exact-match HTTPS.
- **Google tokens never leave the server.** The upstream Google code flow
  runs server-side with a confidential web client; the ID token establishes
  identity and is discarded. No Google refresh token is requested or
  stored. Token passthrough is spec-forbidden.
- **Adapter-agnostic façade.** The OAuth layer (discovery, CIMD, codes,
  grants, consent) does not know about Google. The interactive-login step
  is an optional `IdentityAdapter` capability; only `GoogleAdapter`
  implements it today. In `env` auth mode the OAuth routes are disabled
  (404) — the solo server is loopback-only.

## Endpoints

All new routes are public (mounted before the auth gate) except `/mcp`
itself.

| Route | Purpose |
|---|---|
| `GET /.well-known/oauth-protected-resource` and `…/oauth-protected-resource/mcp` | RFC 9728. `resource` = canonical MCP URL, `authorization_servers: [issuer]`, `bearer_methods_supported: ["header"]`, `scopes_supported: ["portuni", "offline_access"]`. |
| `GET /.well-known/oauth-authorization-server` | RFC 8414. `issuer`, `authorization_endpoint`, `token_endpoint`, `response_types_supported: ["code"]`, `grant_types_supported: ["authorization_code", "refresh_token"]`, `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported: ["none"]`, `client_id_metadata_document_supported: true`, `scopes_supported: ["portuni", "offline_access"]` (`offline_access` makes Claude request a refresh token). |
| `GET /oauth/authorize` | Validates `client_id` (CIMD fetch), `redirect_uri`, `code_challenge` (+`=S256`), `resource`, `scope`; redirects to the upstream IdP. Parameter errors render an error page and never redirect (unvalidated `redirect_uri` = open redirect). |
| `GET /oauth/google/callback` | Exchanges the Google code (confidential client), verifies identity, renders the consent page. Route name is Google-specific; the handler delegates to the adapter capability. |
| `POST /oauth/consent` | Allow → mint authorization code, redirect to `redirect_uri` with `code` + the client's original `state`. Deny → redirect with `error=access_denied`. |
| `POST /oauth/token` | `application/x-www-form-urlencoded` only. Grants: `authorization_code` (PKCE verified) and `refresh_token` (rotation). RFC 6749 error codes; expired/revoked/replayed refresh → `invalid_grant`. |

`/mcp` 401 responses gain
`WWW-Authenticate: Bearer resource_metadata="<issuer>/.well-known/oauth-protected-resource"`.
Claude requires the pointer on a 401; it does not honor it on a 200.

## Data model (migration 025)

`oauth_grants` — one row per live connection:
`id, user_id, client_id (CIMD URL), client_name,
access_token_hash, access_expires_at, refresh_token_hash,
prev_refresh_token_hash, refresh_expires_at, resource, scope, created_at,
rotated_at, revoked_at, last_used_at`. Refresh rotation overwrites the
hashes in place and moves the old refresh hash to
`prev_refresh_token_hash`. A replay of the immediately superseded refresh
token (matches `prev_refresh_token_hash`) is theft evidence: the grant is
revoked and `invalid_grant` returned. Older generations match nothing and
fall through to a plain `invalid_grant` without revocation.

`oauth_codes` — single-use authorization codes:
`id, code_hash, user_id, client_id, redirect_uri, code_challenge,
resource, scope, expires_at (60 s), used_at, grant_id`. Redemption stamps
`used_at` and `grant_id`; a second redemption of the same code revokes
that grant (OAuth 2.1).

No client table; no consent table.

## Authorization flow

1. Claude opens `GET /oauth/authorize?client_id=<CIMD URL>&redirect_uri=…&code_challenge=…&code_challenge_method=S256&state=…&resource=…&scope=…`.
   The server fetches the CIMD document (HTTPS only, timeout, size cap,
   `client_id` must self-reference; cached ~5 min), checks `redirect_uri`
   against the document's `redirect_uris` (exact match for HTTPS;
   port-ignored match for loopback), validates `resource` against the
   canonical MCP URL.
2. Redirect to Google (`prompt=select_account`, scopes
   `openid email profile`). The server's own `state` is a signed short-TTL
   JWT (existing `jose` + `PORTUNI_JWT_SECRET`, 10 min) carrying the entire
   original request — no server-side session, and it doubles as CSRF
   protection.
3. Callback: server-side code exchange (client secret never leaves the
   server), `email_verified` + allowed-domain gate via the adapter's
   existing identity assertion, user upserted the same way `/auth/login`
   does. Google tokens are discarded.
4. Consent page (server-rendered HTML, Czech, no webview, no JS
   dependencies): who is signing in (email, avatar), which client asks
   (name + full CIMD URL), the redirect host — with an explicit warning
   when the redirect is loopback (a local application; MCP spec
   requirement). Allow / Deny buttons; the form carries a signed
   continuation token.
5. Consent POST verifies the signed token, mints the code, redirects with
   `code` + client `state`. The client's `state` is only ever echoed after
   consent.

## Token verification at runtime

`resolveRequestIdentity` gains a third branch: `poa_` → hash lookup in
`oauth_grants`, check `access_expires_at`, `revoked_at`, audience
(`resource` equals the canonical MCP URL), update `last_used_at`, then
`resolveAccess(email)` exactly like the device-token branch. `via:
"oauth_grant"`.

Canonical issuer and MCP URL come from a new env var `PORTUNI_PUBLIC_URL`
(e.g. `https://api.portuni.com`); MCP resource is `<PORTUNI_PUBLIC_URL>/mcp`.

## Adapter interface

`IdentityAdapter` gains an optional capability:

```ts
interactiveLogin?: {
  redirectUrl(state: string): string;            // where to send the browser
  handleCallback(params: URLSearchParams): Promise<{ identity: Identity; avatarUrl: string | null }>;
}
```

`GoogleAdapter` implements it with the confidential web client
(`PORTUNI_OAUTH_GOOGLE_CLIENT_ID` / `PORTUNI_OAUTH_GOOGLE_CLIENT_SECRET`).
`EnvAdapter` does not; without the capability the OAuth routes 404.

## Revocation UI

Settings → Účet gains "Připojené aplikace" next to device tokens: client
name, connected date, last used, an Odpojit button. REST:
`GET /auth/oauth-grants`, `DELETE /auth/oauth-grants/:id` (owner only).
Revocation invalidates access and refresh immediately.

## New env vars

| Var | Purpose |
|---|---|
| `PORTUNI_PUBLIC_URL` | Issuer + canonical resource base. Required for OAuth routes; without it they 404. |
| `PORTUNI_OAUTH_GOOGLE_CLIENT_ID` | Web-application OAuth client (GCP, internal). |
| `PORTUNI_OAUTH_GOOGLE_CLIENT_SECRET` | Its secret; server-side only. |

Document in `docs/env-vars.md`; wire into `scripts/deploy-vps.sh`'s env
handling.

## Files

- New `apps/server/auth/oauth/`: `grants.ts`, `codes.ts`, `cimd.ts`,
  `flow.ts` (signed state JWT), `consent-page.ts`.
- `apps/server/api/oauth.ts` — the routes above; mounted in
  `http/server.ts` before the gates.
- `apps/server/auth/adapter.ts`, `google-adapter.ts` — `interactiveLogin`.
- `apps/server/auth/request-identity.ts` — `poa_` branch;
  `http/middleware.ts` — `resource_metadata` on 401.
- Migration 025.
- Web: Settings account section + `apps/server/api/auth.ts` grant routes.
- Docs site (same branch): new `sites/docs/src/content/docs/clients/`
  page for the connector path; `claude-desktop.md` repositions `mcp-remote`
  as the fallback.

## Testing

Unit (existing `test/` patterns, fake adapter via
`setIdentityContextForTesting`, fake CIMD fetch): discovery document
shapes; CIMD validation (self-reference, non-HTTPS rejected, size cap);
redirect matching incl. port-ignored loopback; PKCE S256 verification;
code single-use + grant revocation on replay; refresh rotation + grant
revocation on superseded-refresh replay; absolute refresh expiry; audience check; `poa_`
identity branch; form-urlencoded token endpoint; OAuth routes 404 in env
mode and without `PORTUNI_PUBLIC_URL`. Integration smoke: full
authorize→consent→token→MCP-request flow with the fake adapter. Gate:
`scripts/agent-gate.sh`.

## Verification (human, after merge)

1. Create the GCP web-application OAuth client (internal app), redirect
   `https://api.portuni.com/oauth/google/callback`.
2. Set the three new env vars on the VPS; `scripts/deploy-vps.sh`.
3. From outside: `curl https://api.portuni.com/.well-known/oauth-authorization-server`
   returns the metadata; `/mcp` 401 carries `resource_metadata`.
4. Add the connector in claude.ai (Settings → Connectors →
   `https://api.portuni.com/mcp`), complete Google login + consent, run a
   tool from chat.
5. Claude Code: `claude mcp add --transport http portuni-central
   https://api.portuni.com/mcp` and complete the loopback OAuth flow.
6. Revoke the grant in Settings → Účet and confirm the connector stops
   working.

## References

- Claude connector auth: claude.com/docs/connectors/building/authentication
  (CIMD selection rules, callback URLs, refresh behavior, 401 shape —
  verified 2026-08-31).
- MCP Authorization spec 2025-11-25; RFC 9728, 8414, 8252, 7636, 6749.
- Asana task 1216276297792207 (original design notes).
- `docs/superpowers/specs/2026-06-09-google-groups-auth-design.md` (roles),
  `docs/architecture/data-modes.md`.
