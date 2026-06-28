# Environment variables

Authoritative inventory of every `process.env.*` the server reads
(2026-06-09). `.env.schema` (varlock) only declares the six core vars; the
rest are optional tunables with code defaults. Grep check:
`grep -rhoE "process\.env\.[A-Z_]+" src/ | sort -u`.

## Core (declared in .env.schema)

| Var | Purpose |
|---|---|
| `TURSO_URL` | libsql database URL; empty = local `file:./portuni.db` (or `$PORTUNI_DATA_DIR/portuni.db` in sidecar/stdio mode) |
| `TURSO_AUTH_TOKEN` | Turso token (sensitive) |
| `PORTUNI_WORKSPACE_ROOT` | Root for local mirrors; also anchors the per-device `.portuni/sync.db` |
| `PORTUNI_USER_EMAIL`, `PORTUNI_USER_NAME` | Solo-user identity seeded at boot |
| `PORTUNI_AUTH_TOKEN` | Bearer for HTTP/MCP auth (sensitive); required for non-loopback bind or remote Turso |

## HTTP server

| Var | Default | Purpose |
|---|---|---|
| `PORTUNI_PORT` / `PORT` | 4011 | Bind port (`PORTUNI_PORT` wins) |
| `HOST` | 127.0.0.1 | Bind host; non-loopback refuses to boot without auth token |
| `PORTUNI_ALLOWED_ORIGINS` | tauri origins + localhost | Extra allowed `Origin` headers (comma-separated) |
| `PORTUNI_ALLOWED_HOSTS` | loopback | Extra allowed `Host` headers |
| `PORTUNI_MAX_BODY_BYTES` | 5 MB | Request body cap |
| `PORTUNI_LOG_REQUESTS` | off | `1` = one-line access log per request |

## MCP

| Var | Default | Purpose |
|---|---|---|
| `PORTUNI_SESSION_TTL_MS` | see `src/mcp/transport.ts` | MCP session idle TTL |
| `PORTUNI_SESSION_GC_INTERVAL_MS` | ditto | Session GC sweep interval |
| `PORTUNI_MAX_SESSIONS` | ditto | Concurrent MCP session cap |
| `PORTUNI_SCOPE_MODE` | default gating | List-tool scope gating mode (see `portuni://scope-rules`) |
| `PORTUNI_URL` | derived | Server URL override used in materialized scope configs |
| `PORTUNI_GUARD_SCRIPT` | `scripts/portuni-guard.sh` | Guard hook path written into mirror settings |

## Sync / desktop

| Var | Default | Purpose |
|---|---|---|
| `PORTUNI_ROOT` | unset | Write-scope tier root for agent file writes (`src/domain/write-scope.ts`) — **distinct from** `PORTUNI_WORKSPACE_ROOT` |
| `PORTUNI_DATA_DIR` | app-data dir | DB location for sidecar/stdio mode |
| `PORTUNI_TOKEN_STORE` | per-OS | Token store backend: `keychain` \| `varlock` \| `file` |
| `PORTUNI_VARLOCK_WRITE_PROGRAM` / `_ARGS`, `PORTUNI_VARLOCK_DELETE_PROGRAM` / `_ARGS` | varlock CLI | Override commands the varlock token store shells out to |
| `PORTUNI_STATUS_SCAN_CONCURRENCY` | 8 | statusScan per-file fan-out |
| `PORTUNI_REMOTE_<NAME>__SERVICE_ACCOUNT_JSON` | unset | Per-remote Google Drive Service Account key (sensitive), read by the `varlock` token store (`token-store-varlock.ts`). `<NAME>` is the remote name upper-cased with `-` → `_`. **Required on the VPS for Phase B** (central-mode file content over the server: the Drive-direct read/write in `file-content-remote.ts` resolves the adapter via this credential). Sibling fields: `__ACCESS_TOKEN`, `__REFRESH_TOKEN`, `__EXPIRES_AT`. |

## Auth mode

`PORTUNI_AUTH_MODE` selects how requests are authenticated and authorized.
`env` (default) = single bearer token (solo/legacy). `google` = Google OAuth
+ Workspace Groups, with server-side enforcement in `src/auth/`.

### Auth mode: env (default, solo/legacy)

| Var | Default | Sensitive | Purpose |
|---|---|---|---|
| `PORTUNI_AUTH_MODE` | `env` | No | Authentication mode (`env` or `google`) |
| `PORTUNI_AUTH_TOKEN` | — | Yes | Bearer for HTTP/MCP auth (see Core). Empty disables auth (safe only on loopback, trusted single-user box) |
| `PORTUNI_USER_EMAIL` | `solo@localhost` | No | Solo user email recorded on events/nodes in env mode |
| `PORTUNI_USER_NAME` | `Solo User` | No | Solo user display name in env mode |

### Auth mode: google (Google OAuth + Workspace Groups)

Set `PORTUNI_AUTH_MODE=google` to activate. All variables in this section are
required when google mode is active (except the optional group mappings).

| Var | Default | Sensitive | Purpose |
|---|---|---|---|
| `PORTUNI_JWT_SECRET` | — | Yes | Secret for signing Portuni session JWTs (HS256). Min 32 chars |
| `PORTUNI_GOOGLE_CLIENT_IDS` | — | No | Comma-separated accepted Google OAuth client IDs (Google Cloud Console) |
| `PORTUNI_ALLOWED_DOMAIN` | — | No | Workspace domain all users must belong to (e.g. `workflow.ooo`) |
| `PORTUNI_GOOGLE_SA_KEY_JSON` | — | Yes | Service-account key JSON with domain-wide delegation scoped to `admin.directory.group.readonly`. Full JSON as a single line |
| `PORTUNI_GOOGLE_IMPERSONATE` | — | No | Admin user the service account impersonates to read group memberships (e.g. `admin@workflow.ooo`) |
| `PORTUNI_GROUPS_ADMIN` | — | No | Comma-separated Google Group email(s) granting the `admin` Portuni scope |
| `PORTUNI_GROUPS_MANAGE` | — | No | Comma-separated Google Group email(s) granting the `manage` Portuni scope |
| `PORTUNI_GROUPS_WRITE` | — | No | Comma-separated Google Group email(s) granting the `write` Portuni scope |

### Scope mapping

| Group env var | Portuni scope | Capabilities |
|---|---|---|
| `PORTUNI_GROUPS_ADMIN` | admin | Everything: read, write, manage, POPP sync, summary refresh, user management |
| `PORTUNI_GROUPS_MANAGE` | manage | Read + write + create/connect/disconnect/update nodes |
| `PORTUNI_GROUPS_WRITE` | write | Read + log events, resolve, supersede, store files |
| (any authenticated user) | read | Get context, search, list nodes, get node |

Highest matching group wins. Admin-scoped users bypass all node-level group checks.

## Notes

- `.env.schema` is committed and visible to agents; actual values are not.
- Run `varlock scan` before committing to catch accidental secret leakage.
- For the design rationale behind google mode see `docs/superpowers/specs/2026-06-09-google-groups-auth-design.md`.
- Auth implementation lives in `src/auth/` (adapter.ts, env-adapter.ts, google-adapter.ts, session-token.ts, device-tokens.ts, roles.ts, request-identity.ts, min-scopes.ts, node-access.ts).
