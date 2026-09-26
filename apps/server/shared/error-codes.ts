// Every error code a client can receive from Portuni: the central server,
// the sync agent and a personal workspace's server all answer an error as
// `{ error, code, params?, request_id? }` (REST, agent router) or
// `{ type: "error", payload: { code, message, params? } }` (live channel).
// `error`/`message` is English and meant for logs; the web renders
// `errors:<code>` with `params` (spec: docs/superpowers/specs/
// 2026-09-25-localization-design.md, Server -> Errors).
//
// This list is the contract: the respond helpers take an `ErrorCode`, a
// typed error's `code` is a member of it, the web maps every member to a
// catalog message through a complete Record, and test/error-codes.test.ts
// checks that both catalogs carry a key for each. A new code is added here
// first. Codes are stable: a client of another version may branch on one.

export const ERROR_CODES = [
  // Generic
  "INTERNAL_ERROR",
  "INVALID_JSON",
  "INVALID_REQUEST",
  "INVALID_LOCALE",
  "BODY_TOO_LARGE",
  "ROUTE_NOT_FOUND",
  "RATE_LIMITED",
  "WEBSOCKET_UPGRADE_REQUIRED",
  "CONSTRAINT_VIOLATION",
  // Gates and auth
  "UNAUTHORIZED",
  "BEARER_MISSING",
  "BEARER_MISMATCH",
  "FORBIDDEN",
  "HOST_NOT_ALLOWED",
  "ORIGIN_NOT_ALLOWED",
  "MALFORMED_REQUEST_TARGET",
  "WEBVIEW_PROXY_REQUIRED",
  // Constraint errors raised by the graph db's triggers (both dialects);
  // infra/sql.ts maps the trigger's message to the code.
  "ORG_ALREADY_ASSIGNED",
  "ORG_LAST_EDGE",
  "RESPONSIBILITY_TARGET_INVALID",
  "DATA_SOURCE_TARGET_INVALID",
  "TOOL_TARGET_INVALID",
  "OWNER_NOT_PERSON",
  "LIFECYCLE_STATE_INVALID",
  "SYNC_KEY_EMPTY",
  // Workspaces and sync
  "LOCAL_MODE_NO_REMOTE",
  // Graph: unknown (or hidden) entities
  "NODE_NOT_FOUND",
  "ORGANIZATION_NOT_FOUND",
  "EDGE_NOT_FOUND",
  "EDGE_ENDPOINT_NOT_FOUND",
  "EVENT_NOT_FOUND",
  "EVENT_ALREADY_ARCHIVED",
  "RESPONSIBILITY_NOT_FOUND",
  "DATA_SOURCE_NOT_FOUND",
  "TOOL_NOT_FOUND",
  "FILE_NOT_FOUND",
  // Graph: validation and moves
  "INVALID_VISIBILITY",
  "INVALID_HEALTH",
  "NODE_VISIBILITY_MANAGED",
  "INVALID_EVENT_DATE",
  "MOVE_SOURCE_IS_ORGANIZATION",
  "MOVE_TARGET_NOT_ORGANIZATION",
  "MOVE_REMOTE_MISMATCH",
  // File content (FileContentError). Older sync agents branch on these exact
  // values from the central server: never rename one. NOT_FOUND is a file
  // path, EXISTS a filename.
  "NO_MIRROR",
  "NO_REMOTE",
  "NOT_FOUND",
  "NOT_EDITABLE",
  "CONFLICT",
  "EXISTS",
  "INVALID_PATH",
  "NO_PREVIEW",
  // File resolve and mirrors (MirrorCreateError)
  "FILE_NO_REMOTE_PATH",
  "FILE_NO_LOCAL_COPY",
  "WORKSPACE_ROOT_UNSET",
  "PATH_TRAVERSAL",
  "PATH_IN_USE",
  // Sharing and access requests
  "ACCESS_ALREADY_VISIBLE",
  "ACCESS_REQUEST_PENDING",
  "ACCESS_REQUEST_NOT_FOUND",
  "ACCESS_REQUEST_RESOLVED",
  "ACCESS_GROUP_NEEDS_ENTRIES",
  "ACCESS_DUPLICATE_ENTRIES",
  "ACCESS_UNKNOWN_USERS",
  "GOOGLE_MODE_ONLY",
  // Auth, tokens, Showtime handoff
  "LOGIN_UNAVAILABLE",
  "LOGIN_FAILED",
  "HEADLESS_TOKEN_REQUIRES_ADMIN",
  "DEVICE_TOKEN_NOT_FOUND",
  "OAUTH_GRANT_NOT_FOUND",
  "USER_EXISTS",
  "DESKTOP_CONFIG_UNAVAILABLE",
  "HANDOFF_NOT_LOOPBACK",
  "HANDOFF_INVALID",
  // REST write gate
  "WRITE_REFUSED",
  "WRITE_EXPANSION_REQUIRED",
  // Runner registry and provider instances
  "UNKNOWN_RUNNER",
  "INSTANCE_NOT_FOUND",
  "INSTANCE_ENV_KEY_SECRET",
  "INSTANCE_ENV_KEY_RESERVED",
  "INSTANCE_DEFAULTS_KEY_UNKNOWN",
  "INSTANCE_DEFAULTS_EFFORT_INVALID",
  // Threads and runs
  "SESSION_NOT_FOUND",
  "SESSION_NOT_DRAFT",
  "NOT_A_DRAFT",
  "INVALID_SESSION_TRANSITION",
  "RUN_NOT_FOUND",
  "NO_RUNNER_AVAILABLE",
  "RUNNER_REQUIRED",
  "UNKNOWN_INSTANCE",
  "NO_PENDING_QUESTION",
  "NO_LIVE_RUN",
  // Předat / Navázat na handoff / resume refusals (SessionHandoffError)
  "HANDOFF_NOT_ALLOWED",
  "HANDOFF_NO_MIRROR",
  "HANDOFF_RUN_ELSEWHERE",
  "HANDOFF_TRANSCRIPT_ELSEWHERE",
  "SESSION_TRANSCRIPT_ELSEWHERE",
  "HANDOFF_NO_CONTENT",
  "HANDOFF_FILE_NOT_HERE",
  "HANDOFF_PATH_INVALID",
  // Sync agent (agent router)
  "SYNC_JOB_NOT_FOUND",
  "FILE_NOT_ON_DEVICE",
  "INVALID_RESOLVE_ACTION",
  "CONFIRMATION_REQUIRED",
  "PATH_PARAM_REQUIRED",
  "PULL_DIRTY_LOCAL",
  "NOT_SERVED_BY_SYNC_AGENT",
  // OAuth sign-in pages
  "OAUTH_MISSING_PARAMETER",
  "OAUTH_PKCE_S256_ONLY",
  "OAUTH_CLIENT_UNVERIFIED",
  "OAUTH_REDIRECT_URI_UNREGISTERED",
  "OAUTH_INVALID_RESOURCE",
  "OAUTH_SESSION_EXPIRED",
  "OAUTH_GOOGLE_LOGIN_FAILED",
  // MCP endpoint (mcp/transport.ts, mcp/agent-transport.ts)
  "MCP_SESSION_FORBIDDEN",
  "MCP_SESSION_NOT_FOUND",
  "MCP_CAPACITY_REACHED",
  "MCP_HOME_NODE_REQUIRED",
  "MCP_RESUME_REFUSED",
  "MCP_SCOPE_UNAVAILABLE",
  "SESSION_BIND_REFUSED",
  "CENTRAL_UNREACHABLE",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

// Values a catalog message interpolates. Data only (names, paths, counts,
// ids); never a translated noun and never a sentence.
export type ErrorParams = Record<string, string | number>;

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}
