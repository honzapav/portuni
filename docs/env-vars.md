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
