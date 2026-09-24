// The server's front-door auth, owned in one place (#521). Every consumer
// (the HTTP gates, /mcp/info and the boot banner, a runner's own MCP
// client, the per-mirror configs) asks this module; nothing else in
// apps/server reads PORTUNI_AUTH_TOKEN or PORTUNI_AUTH_MODE.
//
// One rule:
//   - env mode (personal workspace, the sync agent, a standalone server):
//     PORTUNI_AUTH_TOKEN must be non-empty, whatever the host or TURSO_URL.
//     There is no "auth disabled" state; every non-public request carries it.
//   - google mode (the central server): PORTUNI_JWT_SECRET (>= 32 chars) is
//     required; PORTUNI_AUTH_TOKEN is not used (one warning line at boot
//     when it is set).
//
// Everything is read live from process.env, never captured at import, so a
// test (or the desktop) that sets the env after importing still counts.

import { createHash, timingSafeEqual } from "node:crypto";

export type AuthMode = "google" | "env";

// The server's auth mode: "google" is the central server, anything else is
// solo bearer-token mode.
export function authMode(): AuthMode {
  return (process.env.PORTUNI_AUTH_MODE ?? "env") === "google" ? "google" : "env";
}

function envToken(): string {
  return (process.env.PORTUNI_AUTH_TOKEN ?? "").trim();
}

function jwtSecret(): string {
  return process.env.PORTUNI_JWT_SECRET ?? "";
}

export const JWT_SECRET_MIN_LENGTH = 32;

// Refuse to boot a server whose auth cannot work. Returns the warnings it
// logged (google mode with a stray PORTUNI_AUTH_TOKEN) so a test can see
// them without capturing the console.
export function assertAuthConfig(log: (line: string) => void = console.warn): string[] {
  if (authMode() === "google") {
    if (jwtSecret().length < JWT_SECRET_MIN_LENGTH) {
      throw new Error(
        `Refusing to start: PORTUNI_JWT_SECRET (>= ${JWT_SECRET_MIN_LENGTH} chars) is required in google auth mode (PORTUNI_AUTH_MODE=google).`,
      );
    }
    if (envToken() !== "") {
      const line =
        "[portuni:auth] PORTUNI_AUTH_TOKEN is set but ignored in google auth mode; bearers are session JWTs.";
      log(line);
      return [line];
    }
    return [];
  }
  if (envToken() === "") {
    throw new Error(
      "Refusing to start: PORTUNI_AUTH_TOKEN is not set. Env auth mode (personal workspace, sync agent, standalone server) always requires a bearer token; set PORTUNI_AUTH_TOKEN to a non-empty secret.",
    );
  }
  return [];
}

// The bearer this process's own front door verifies in env mode, which a
// runner-driven run's MCP client presents back to it (#507). Throws when
// unset: a server that passed assertAuthConfig() never gets there.
export function serverBearerToken(): string {
  const token = envToken();
  if (token === "") {
    throw new Error("PORTUNI_AUTH_TOKEN is not set (env auth mode requires it)");
  }
  return token;
}

export type BearerCheck = "ok" | "missing" | "mismatch";

export function timingSafeStringEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// Check a presented env-mode bearer against PORTUNI_AUTH_TOKEN, timing-safe.
// An unset server token never matches anything (fail closed).
export function verifyBearer(presented: string): BearerCheck {
  if (presented === "") return "missing";
  const token = envToken();
  if (token === "" || !timingSafeStringEqual(presented, token)) return "mismatch";
  return "ok";
}

// Name of the env var per-mirror configs reference for the MCP bearer
// token in a user's shell. The server itself never reads it. In the
// multi-workspace desktop each sidecar gets PORTUNI_WORKSPACE_ID and its
// mirrors reference a workspace-suffixed variable, so a terminal carrying
// tokens for several workspaces resolves the right one. Standalone servers
// (no PORTUNI_WORKSPACE_ID) keep the historical PORTUNI_MCP_TOKEN. Must
// match workspace::token_env_var in apps/desktop (shared fixture:
// apps/server/shared/token-env-var-cases.json).
export function clientTokenEnvVar(): string {
  const id = process.env.PORTUNI_WORKSPACE_ID?.trim();
  if (!id) return "PORTUNI_MCP_TOKEN";
  return "PORTUNI_MCP_TOKEN_" + id.toUpperCase().replace(/-/g, "_");
}

export interface AuthSummary {
  mode: AuthMode;
  // Always true in env mode (a server without one does not start); false
  // in google mode, which does not use it.
  has_auth_token: boolean;
  // One human-readable line for the boot banner; never the token itself.
  banner: string;
}

export function authSummary(): AuthSummary {
  const mode = authMode();
  if (mode === "google") {
    return {
      mode,
      has_auth_token: false,
      banner: "Auth: google mode (session JWT bearers; PORTUNI_AUTH_TOKEN not used)",
    };
  }
  const token = envToken();
  const fingerprint = token === "" ? "unset" : createHash("sha256").update(token).digest("hex").slice(0, 8);
  return {
    mode,
    has_auth_token: token !== "",
    banner: `Auth: bearer token required (PORTUNI_AUTH_TOKEN sha256 ${fingerprint}; clients export ${clientTokenEnvVar()})`,
  };
}
