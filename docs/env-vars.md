# Environment variable reference

All variables are declared in `.env.schema` (varlock format). Secrets are never committed; they are resolved at runtime via `varlock run -- node dist/server.js`. Sensitive variables are marked below.

## Core infrastructure

| Variable | Required | Default | Sensitive | Description |
|---|---|---|---|---|
| `TURSO_URL` | No | — | No | Turso database connection URL. Omit to use local SQLite. |
| `TURSO_AUTH_TOKEN` | If TURSO_URL set | — | Yes | Turso authentication token. |
| `PORTUNI_WORKSPACE_ROOT` | Yes | `~/Workspaces/portuni` | No | Root directory for local workspace mirrors. |
| `PORT` | No | `4011` | No | HTTP/MCP server port. |
| `PORTUNI_MAX_BODY_BYTES` | No | `5242880` (5 MB) | No | Maximum request body size. |
| `PORTUNI_ALLOWED_ORIGINS` | No | localhost variants | No | Comma-separated list of allowed CORS origins. Defaults cover localhost:4010/4011 and portuni.test. |

## Auth mode: env (default, solo/legacy)

| Variable | Required | Default | Sensitive | Description |
|---|---|---|---|---|
| `PORTUNI_AUTH_MODE` | No | `env` | No | Authentication mode. `env` = single bearer token (solo/legacy). `google` = Google OAuth + Workspace Groups. |
| `PORTUNI_AUTH_TOKEN` | No | — | Yes | Bearer token for HTTP/MCP auth. When set, every request (except `/health`) must present `Authorization: Bearer <token>`. Leave empty to disable auth (safe only on loopback on a trusted single-user box). |
| `PORTUNI_USER_EMAIL` | No | `solo@localhost` | No | Solo user email recorded on events/nodes in env mode. |
| `PORTUNI_USER_NAME` | No | `Solo User` | No | Solo user display name in env mode. |

## Auth mode: google (Google OAuth + Workspace Groups)

Set `PORTUNI_AUTH_MODE=google` to activate. All variables in this section are required when google mode is active.

| Variable | Required (google) | Default | Sensitive | Description |
|---|---|---|---|---|
| `PORTUNI_JWT_SECRET` | Yes | — | Yes | Secret for signing Portuni session JWTs (HS256). Minimum 32 characters. |
| `PORTUNI_GOOGLE_CLIENT_IDS` | Yes | — | No | Comma-separated list of accepted Google OAuth client IDs (from Google Cloud Console). |
| `PORTUNI_ALLOWED_DOMAIN` | Yes | — | No | Workspace domain all users must belong to (e.g. `workflow.ooo`). |
| `PORTUNI_GOOGLE_SA_KEY_JSON` | Yes | — | Yes | Service-account key JSON with domain-wide delegation scoped to `admin.directory.group.readonly`. Paste the full JSON as a single line. |
| `PORTUNI_GOOGLE_IMPERSONATE` | Yes | — | No | Admin user the service account impersonates to read group memberships (e.g. `admin@workflow.ooo`). |
| `PORTUNI_GROUPS_ADMIN` | No | — | No | Comma-separated Google Group email(s) that grant the `admin` Portuni scope. |
| `PORTUNI_GROUPS_MANAGE` | No | — | No | Comma-separated Google Group email(s) that grant the `manage` Portuni scope. |
| `PORTUNI_GROUPS_WRITE` | No | — | No | Comma-separated Google Group email(s) that grant the `write` Portuni scope. |

### Scope mapping

| Group env var | Portuni scope | Capabilities |
|---|---|---|
| `PORTUNI_GROUPS_ADMIN` | admin | Everything: read, write, manage, POPP sync, summary refresh, user management |
| `PORTUNI_GROUPS_MANAGE` | manage | Read + write + create/connect/disconnect/update nodes |
| `PORTUNI_GROUPS_WRITE` | write | Read + log events, resolve, supersede, store files |
| (any authenticated user) | read | Get context, search, list nodes, get node |

Highest matching group wins. Admin-scoped users bypass all node-level group checks.

## Scope mode

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORTUNI_SCOPE_MODE` | No | `strict` | Session scope expansion gating: `strict` (confirm every reach), `balanced` (confirm first reach per node), `permissive` (auto-approve, audit only). |

## Notes

- `.env.schema` is committed and visible to agents; actual values are not.
- Run `varlock scan` before committing to catch accidental secret leakage.
- For the design rationale behind google mode see `docs/superpowers/specs/2026-06-09-google-groups-auth-design.md`.
- Implementation lives in `src/auth/` (adapter.ts, env-adapter.ts, google-adapter.ts, session-token.ts, device-tokens.ts, roles.ts, request-identity.ts, min-scopes.ts, node-access.ts).
