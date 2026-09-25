// Server and client errors as text the user reads (spec: Server -> Errors).
// Every error answer carries `{ error, code, params?, request_id? }`; the
// web never shows `error` (English, for logs) but renders `errors:<code>`
// with `params`. An unknown code shows errors:UNKNOWN with the request id,
// an error without any code (a network failure, a bug) the generic message
// with its raw text as data.
//
// Pure: `t` is a parameter, so the server's node:test runner tests this
// with the English catalog (test/api-error.test.ts). Components use
// displayError() from src/errors.ts, which binds the app's i18n instance.

import type { TFunction } from "i18next";
import {
  ERROR_CODES,
  isErrorCode,
  type ErrorCode,
  type ErrorParams,
} from "../../../server/shared/error-codes";

// Codes only the web (or the desktop shell in front of it) produces.
export const WEB_ERROR_CODES = [
  "UNKNOWN",
  "UNKNOWN_DETAIL",
  "SYNC_AGENT_DOWN",
  "REQUEST_TIMEOUT",
  "DISCONNECTED",
] as const;
export type WebErrorCode = (typeof WEB_ERROR_CODES)[number];

export type DisplayErrorCode = ErrorCode | WebErrorCode;

export function isDisplayErrorCode(value: unknown): value is DisplayErrorCode {
  return isErrorCode(value) || (WEB_ERROR_CODES as readonly string[]).includes(value as string);
}

// An error answer from the server (REST, agent router) or the live channel.
// `code` is kept as received: a newer server may send a code this build does
// not know yet, which renders as errors:UNKNOWN.
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
    readonly params: ErrorParams = {},
    readonly requestId: string | null = null,
    // The whole parsed body, for the few fields a caller branches on
    // (currentVersion, repair_hint...).
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// A client-side error with a web code (the live channel timing out, the
// sync agent not running...).
export class ClientError extends Error {
  constructor(
    readonly code: WebErrorCode,
    message: string,
    readonly params: ErrorParams = {},
  ) {
    super(message);
    this.name = "ClientError";
  }
}

function readParams(value: unknown): ErrorParams {
  const out: ErrorParams = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string" || typeof v === "number") out[k] = v;
  }
  return out;
}

// The error a non-ok answer stands for. `label` names the request in the
// log message when the body is not an error body.
export function parseApiError(status: number, bodyText: string, label: string): ApiError {
  let body: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    /* not JSON */
  }
  const code = typeof body.code === "string" ? body.code : null;
  const message =
    typeof body.error === "string" ? `${label}: ${status} ${body.error}` : `${label}: ${status} ${bodyText}`.trim();
  const requestId = typeof body.request_id === "string" ? body.request_id : null;
  return new ApiError(status, code, message, readParams(body.params), requestId, body);
}

// The code an error carries, if any: an ApiError's or ClientError's, or a
// `code` field on another error type (HandoffRefusedError...).
export function errorCode(err: unknown): string | null {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

type Render = (t: TFunction<"errors">, params: ErrorParams) => string;

// A param as display text; a missing one shows as "-" rather than "undefined".
function s(value: string | number | undefined): string {
  return value === undefined ? "-" : String(value);
}

// One message per code, a complete Record so a code added to the server's
// list (shared/error-codes.ts) fails the typecheck until it has a message.
// Every entry is a literal selector, so i18next-cli sees each key in use.
const MESSAGES: Record<DisplayErrorCode, Render> = {
  ACCESS_ALREADY_VISIBLE: (t) => t(($) => $.ACCESS_ALREADY_VISIBLE, { ns: "errors" }),
  ACCESS_DUPLICATE_ENTRIES: (t) => t(($) => $.ACCESS_DUPLICATE_ENTRIES, { ns: "errors" }),
  ACCESS_GROUP_NEEDS_ENTRIES: (t) => t(($) => $.ACCESS_GROUP_NEEDS_ENTRIES, { ns: "errors" }),
  ACCESS_REQUEST_NOT_FOUND: (t) => t(($) => $.ACCESS_REQUEST_NOT_FOUND, { ns: "errors" }),
  ACCESS_REQUEST_PENDING: (t) => t(($) => $.ACCESS_REQUEST_PENDING, { ns: "errors" }),
  ACCESS_REQUEST_RESOLVED: (t) => t(($) => $.ACCESS_REQUEST_RESOLVED, { ns: "errors" }),
  ACCESS_UNKNOWN_USERS: (t, p) => t(($) => $.ACCESS_UNKNOWN_USERS, { ns: "errors", count: Number(p.count ?? 0) }),
  BEARER_MISMATCH: (t) => t(($) => $.BEARER_MISMATCH, { ns: "errors" }),
  BEARER_MISSING: (t) => t(($) => $.BEARER_MISSING, { ns: "errors" }),
  BODY_TOO_LARGE: (t) => t(($) => $.BODY_TOO_LARGE, { ns: "errors" }),
  CONFIRMATION_REQUIRED: (t) => t(($) => $.CONFIRMATION_REQUIRED, { ns: "errors" }),
  CONFLICT: (t) => t(($) => $.CONFLICT, { ns: "errors" }),
  CONSTRAINT_VIOLATION: (t) => t(($) => $.CONSTRAINT_VIOLATION, { ns: "errors" }),
  DATA_SOURCE_NOT_FOUND: (t) => t(($) => $.DATA_SOURCE_NOT_FOUND, { ns: "errors" }),
  DATA_SOURCE_TARGET_INVALID: (t) => t(($) => $.DATA_SOURCE_TARGET_INVALID, { ns: "errors" }),
  DESKTOP_CONFIG_UNAVAILABLE: (t) => t(($) => $.DESKTOP_CONFIG_UNAVAILABLE, { ns: "errors" }),
  DEVICE_TOKEN_NOT_FOUND: (t) => t(($) => $.DEVICE_TOKEN_NOT_FOUND, { ns: "errors" }),
  DISCONNECTED: (t) => t(($) => $.DISCONNECTED, { ns: "errors" }),
  EDGE_ENDPOINT_NOT_FOUND: (t) => t(($) => $.EDGE_ENDPOINT_NOT_FOUND, { ns: "errors" }),
  EDGE_NOT_FOUND: (t) => t(($) => $.EDGE_NOT_FOUND, { ns: "errors" }),
  EVENT_ALREADY_ARCHIVED: (t) => t(($) => $.EVENT_ALREADY_ARCHIVED, { ns: "errors" }),
  EVENT_NOT_FOUND: (t) => t(($) => $.EVENT_NOT_FOUND, { ns: "errors" }),
  EXISTS: (t, p) => t(($) => $.EXISTS, { ns: "errors", filename: s(p.filename) }),
  FILE_NOT_FOUND: (t) => t(($) => $.FILE_NOT_FOUND, { ns: "errors" }),
  FILE_NOT_ON_DEVICE: (t) => t(($) => $.FILE_NOT_ON_DEVICE, { ns: "errors" }),
  FILE_NO_LOCAL_COPY: (t) => t(($) => $.FILE_NO_LOCAL_COPY, { ns: "errors" }),
  FILE_NO_REMOTE_PATH: (t) => t(($) => $.FILE_NO_REMOTE_PATH, { ns: "errors" }),
  FORBIDDEN: (t) => t(($) => $.FORBIDDEN, { ns: "errors" }),
  GOOGLE_MODE_ONLY: (t) => t(($) => $.GOOGLE_MODE_ONLY, { ns: "errors" }),
  HANDOFF_FILE_NOT_HERE: (t) => t(($) => $.HANDOFF_FILE_NOT_HERE, { ns: "errors" }),
  HANDOFF_INVALID: (t) => t(($) => $.HANDOFF_INVALID, { ns: "errors" }),
  HANDOFF_NOT_ALLOWED: (t) => t(($) => $.HANDOFF_NOT_ALLOWED, { ns: "errors" }),
  HANDOFF_NOT_LOOPBACK: (t) => t(($) => $.HANDOFF_NOT_LOOPBACK, { ns: "errors" }),
  HANDOFF_NO_CONTENT: (t) => t(($) => $.HANDOFF_NO_CONTENT, { ns: "errors" }),
  HANDOFF_NO_MIRROR: (t) => t(($) => $.HANDOFF_NO_MIRROR, { ns: "errors" }),
  HANDOFF_PATH_INVALID: (t) => t(($) => $.HANDOFF_PATH_INVALID, { ns: "errors" }),
  HANDOFF_RUN_ELSEWHERE: (t, p) => t(($) => $.HANDOFF_RUN_ELSEWHERE, { ns: "errors", host: s(p.host) }),
  HANDOFF_TRANSCRIPT_ELSEWHERE: (t, p) => t(($) => $.HANDOFF_TRANSCRIPT_ELSEWHERE, { ns: "errors", host: s(p.host) }),
  HEADLESS_TOKEN_REQUIRES_ADMIN: (t) => t(($) => $.HEADLESS_TOKEN_REQUIRES_ADMIN, { ns: "errors" }),
  HOST_NOT_ALLOWED: (t) => t(($) => $.HOST_NOT_ALLOWED, { ns: "errors" }),
  INSTANCE_DEFAULTS_EFFORT_INVALID: (t, p) => t(($) => $.INSTANCE_DEFAULTS_EFFORT_INVALID, { ns: "errors", effort: s(p.effort) }),
  INSTANCE_DEFAULTS_KEY_UNKNOWN: (t, p) => t(($) => $.INSTANCE_DEFAULTS_KEY_UNKNOWN, { ns: "errors", key: s(p.key) }),
  INSTANCE_ENV_KEY_RESERVED: (t, p) => t(($) => $.INSTANCE_ENV_KEY_RESERVED, { ns: "errors", key: s(p.key) }),
  INSTANCE_ENV_KEY_SECRET: (t, p) => t(($) => $.INSTANCE_ENV_KEY_SECRET, { ns: "errors", key: s(p.key) }),
  INSTANCE_NOT_FOUND: (t) => t(($) => $.INSTANCE_NOT_FOUND, { ns: "errors" }),
  INTERNAL_ERROR: (t, p) => t(($) => $.INTERNAL_ERROR, { ns: "errors", requestId: s(p.requestId) }),
  INVALID_EVENT_DATE: (t) => t(($) => $.INVALID_EVENT_DATE, { ns: "errors" }),
  INVALID_HEALTH: (t, p) => t(($) => $.INVALID_HEALTH, { ns: "errors", health: s(p.health) }),
  INVALID_JSON: (t) => t(($) => $.INVALID_JSON, { ns: "errors" }),
  INVALID_PATH: (t) => t(($) => $.INVALID_PATH, { ns: "errors" }),
  INVALID_REQUEST: (t) => t(($) => $.INVALID_REQUEST, { ns: "errors" }),
  INVALID_RESOLVE_ACTION: (t) => t(($) => $.INVALID_RESOLVE_ACTION, { ns: "errors" }),
  INVALID_SESSION_TRANSITION: (t) => t(($) => $.INVALID_SESSION_TRANSITION, { ns: "errors" }),
  INVALID_VISIBILITY: (t, p) => t(($) => $.INVALID_VISIBILITY, { ns: "errors", visibility: s(p.visibility) }),
  LIFECYCLE_STATE_INVALID: (t) => t(($) => $.LIFECYCLE_STATE_INVALID, { ns: "errors" }),
  LOCAL_MODE_NO_REMOTE: (t) => t(($) => $.LOCAL_MODE_NO_REMOTE, { ns: "errors" }),
  LOGIN_FAILED: (t) => t(($) => $.LOGIN_FAILED, { ns: "errors" }),
  LOGIN_UNAVAILABLE: (t) => t(($) => $.LOGIN_UNAVAILABLE, { ns: "errors" }),
  MALFORMED_REQUEST_TARGET: (t) => t(($) => $.MALFORMED_REQUEST_TARGET, { ns: "errors" }),
  MOVE_REMOTE_MISMATCH: (t, p) => t(($) => $.MOVE_REMOTE_MISMATCH, { ns: "errors", remoteName: s(p.remoteName), targetRemote: s(p.targetRemote) }),
  MOVE_SOURCE_IS_ORGANIZATION: (t) => t(($) => $.MOVE_SOURCE_IS_ORGANIZATION, { ns: "errors" }),
  MOVE_TARGET_NOT_ORGANIZATION: (t) => t(($) => $.MOVE_TARGET_NOT_ORGANIZATION, { ns: "errors" }),
  NODE_NOT_FOUND: (t) => t(($) => $.NODE_NOT_FOUND, { ns: "errors" }),
  NODE_VISIBILITY_MANAGED: (t) => t(($) => $.NODE_VISIBILITY_MANAGED, { ns: "errors" }),
  NOT_A_DRAFT: (t) => t(($) => $.NOT_A_DRAFT, { ns: "errors" }),
  NOT_EDITABLE: (t) => t(($) => $.NOT_EDITABLE, { ns: "errors" }),
  NOT_FOUND: (t) => t(($) => $.NOT_FOUND, { ns: "errors" }),
  NOT_SERVED_BY_SYNC_AGENT: (t) => t(($) => $.NOT_SERVED_BY_SYNC_AGENT, { ns: "errors" }),
  NO_LIVE_RUN: (t) => t(($) => $.NO_LIVE_RUN, { ns: "errors" }),
  NO_MIRROR: (t) => t(($) => $.NO_MIRROR, { ns: "errors" }),
  NO_PENDING_QUESTION: (t) => t(($) => $.NO_PENDING_QUESTION, { ns: "errors" }),
  NO_PREVIEW: (t) => t(($) => $.NO_PREVIEW, { ns: "errors" }),
  NO_REMOTE: (t) => t(($) => $.NO_REMOTE, { ns: "errors" }),
  NO_RUNNER_AVAILABLE: (t) => t(($) => $.NO_RUNNER_AVAILABLE, { ns: "errors" }),
  OAUTH_CLIENT_UNVERIFIED: (t, p) => t(($) => $.OAUTH_CLIENT_UNVERIFIED, { ns: "errors", reason: s(p.reason) }),
  OAUTH_GOOGLE_LOGIN_FAILED: (t) => t(($) => $.OAUTH_GOOGLE_LOGIN_FAILED, { ns: "errors" }),
  OAUTH_GRANT_NOT_FOUND: (t) => t(($) => $.OAUTH_GRANT_NOT_FOUND, { ns: "errors" }),
  OAUTH_INVALID_RESOURCE: (t) => t(($) => $.OAUTH_INVALID_RESOURCE, { ns: "errors" }),
  OAUTH_MISSING_PARAMETER: (t) => t(($) => $.OAUTH_MISSING_PARAMETER, { ns: "errors" }),
  OAUTH_PKCE_S256_ONLY: (t) => t(($) => $.OAUTH_PKCE_S256_ONLY, { ns: "errors" }),
  OAUTH_REDIRECT_URI_UNREGISTERED: (t) => t(($) => $.OAUTH_REDIRECT_URI_UNREGISTERED, { ns: "errors" }),
  OAUTH_SESSION_EXPIRED: (t) => t(($) => $.OAUTH_SESSION_EXPIRED, { ns: "errors" }),
  ORGANIZATION_NOT_FOUND: (t) => t(($) => $.ORGANIZATION_NOT_FOUND, { ns: "errors" }),
  ORG_ALREADY_ASSIGNED: (t) => t(($) => $.ORG_ALREADY_ASSIGNED, { ns: "errors" }),
  ORG_LAST_EDGE: (t) => t(($) => $.ORG_LAST_EDGE, { ns: "errors" }),
  ORIGIN_NOT_ALLOWED: (t) => t(($) => $.ORIGIN_NOT_ALLOWED, { ns: "errors" }),
  OWNER_NOT_PERSON: (t) => t(($) => $.OWNER_NOT_PERSON, { ns: "errors" }),
  PATH_IN_USE: (t) => t(($) => $.PATH_IN_USE, { ns: "errors" }),
  PATH_PARAM_REQUIRED: (t) => t(($) => $.PATH_PARAM_REQUIRED, { ns: "errors" }),
  PATH_TRAVERSAL: (t) => t(($) => $.PATH_TRAVERSAL, { ns: "errors" }),
  PULL_DIRTY_LOCAL: (t) => t(($) => $.PULL_DIRTY_LOCAL, { ns: "errors" }),
  RATE_LIMITED: (t, p) => t(($) => $.RATE_LIMITED, { ns: "errors", retryAfterSeconds: s(p.retryAfterSeconds) }),
  REQUEST_TIMEOUT: (t) => t(($) => $.REQUEST_TIMEOUT, { ns: "errors" }),
  RESPONSIBILITY_NOT_FOUND: (t) => t(($) => $.RESPONSIBILITY_NOT_FOUND, { ns: "errors" }),
  RESPONSIBILITY_TARGET_INVALID: (t) => t(($) => $.RESPONSIBILITY_TARGET_INVALID, { ns: "errors" }),
  ROUTE_NOT_FOUND: (t) => t(($) => $.ROUTE_NOT_FOUND, { ns: "errors" }),
  RUNNER_REQUIRED: (t) => t(($) => $.RUNNER_REQUIRED, { ns: "errors" }),
  RUN_NOT_FOUND: (t) => t(($) => $.RUN_NOT_FOUND, { ns: "errors" }),
  SESSION_NOT_DRAFT: (t) => t(($) => $.SESSION_NOT_DRAFT, { ns: "errors" }),
  SESSION_NOT_FOUND: (t) => t(($) => $.SESSION_NOT_FOUND, { ns: "errors" }),
  SESSION_TRANSCRIPT_ELSEWHERE: (t, p) => t(($) => $.SESSION_TRANSCRIPT_ELSEWHERE, { ns: "errors", host: s(p.host) }),
  SYNC_AGENT_DOWN: (t) => t(($) => $.SYNC_AGENT_DOWN, { ns: "errors" }),
  SYNC_JOB_NOT_FOUND: (t) => t(($) => $.SYNC_JOB_NOT_FOUND, { ns: "errors" }),
  SYNC_KEY_EMPTY: (t) => t(($) => $.SYNC_KEY_EMPTY, { ns: "errors" }),
  TOOL_NOT_FOUND: (t) => t(($) => $.TOOL_NOT_FOUND, { ns: "errors" }),
  TOOL_TARGET_INVALID: (t) => t(($) => $.TOOL_TARGET_INVALID, { ns: "errors" }),
  UNAUTHORIZED: (t) => t(($) => $.UNAUTHORIZED, { ns: "errors" }),
  UNKNOWN: (t, p) => t(($) => $.UNKNOWN, { ns: "errors", requestId: s(p.requestId) }),
  UNKNOWN_DETAIL: (t, p) => t(($) => $.UNKNOWN_DETAIL, { ns: "errors", detail: s(p.detail) }),
  UNKNOWN_INSTANCE: (t) => t(($) => $.UNKNOWN_INSTANCE, { ns: "errors" }),
  UNKNOWN_RUNNER: (t, p) => t(($) => $.UNKNOWN_RUNNER, { ns: "errors", runner: s(p.runner) }),
  USER_EXISTS: (t, p) => t(($) => $.USER_EXISTS, { ns: "errors", email: s(p.email) }),
  WEBSOCKET_UPGRADE_REQUIRED: (t) => t(($) => $.WEBSOCKET_UPGRADE_REQUIRED, { ns: "errors" }),
  WEBVIEW_PROXY_REQUIRED: (t) => t(($) => $.WEBVIEW_PROXY_REQUIRED, { ns: "errors" }),
  WORKSPACE_ROOT_UNSET: (t) => t(($) => $.WORKSPACE_ROOT_UNSET, { ns: "errors" }),
  WRITE_EXPANSION_REQUIRED: (t) => t(($) => $.WRITE_EXPANSION_REQUIRED, { ns: "errors" }),
  WRITE_REFUSED: (t) => t(($) => $.WRITE_REFUSED, { ns: "errors" }),
  MCP_SESSION_FORBIDDEN: (t) => t(($) => $.MCP_SESSION_FORBIDDEN, { ns: "errors" }),
  MCP_SESSION_NOT_FOUND: (t) => t(($) => $.MCP_SESSION_NOT_FOUND, { ns: "errors" }),
  MCP_CAPACITY_REACHED: (t) => t(($) => $.MCP_CAPACITY_REACHED, { ns: "errors" }),
  MCP_HOME_NODE_REQUIRED: (t) => t(($) => $.MCP_HOME_NODE_REQUIRED, { ns: "errors" }),
  MCP_RESUME_REFUSED: (t) => t(($) => $.MCP_RESUME_REFUSED, { ns: "errors" }),
  MCP_SCOPE_UNAVAILABLE: (t) => t(($) => $.MCP_SCOPE_UNAVAILABLE, { ns: "errors" }),
  SESSION_BIND_REFUSED: (t) => t(($) => $.SESSION_BIND_REFUSED, { ns: "errors" }),
  CENTRAL_UNREACHABLE: (t) => t(($) => $.CENTRAL_UNREACHABLE, { ns: "errors" }),
};

// What the user reads for `err`, in the language of `t`: the message for its
// code; errors:UNKNOWN with the request id for a server answer whose code
// this build does not know; errors:UNKNOWN_DETAIL with the raw text for an
// error without any code (a network failure, a Tauri command's string).
export function errorText(err: unknown, t: TFunction<"errors">): string {
  const code = errorCode(err);
  if (err instanceof ApiError) {
    const params: ErrorParams = { requestId: err.requestId ?? "-", ...err.params };
    return isDisplayErrorCode(code) ? MESSAGES[code](t, params) : MESSAGES.UNKNOWN(t, params);
  }
  if (isDisplayErrorCode(code)) {
    const params =
      err instanceof ClientError
        ? err.params
        : readParams((err as { params?: unknown }).params);
    return MESSAGES[code](t, params);
  }
  const detail = err instanceof Error ? err.message : String(err);
  return MESSAGES.UNKNOWN_DETAIL(t, { detail });
}

// For tests and the catalog check.
export const ALL_DISPLAY_ERROR_CODES: readonly DisplayErrorCode[] = [...ERROR_CODES, ...WEB_ERROR_CODES];
