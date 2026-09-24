// Pure config helpers usable from tests without booting the server.
// Anything that imports src/server.ts triggers main() at module load.

import { authMode } from "./auth-config.js";

// Auth mode and the bearer token live in ./auth-config.ts (#521).
export { authMode } from "./auth-config.js";

// A local workspace is neither the central server (PORTUNI_AUTH_MODE=google)
// nor a central-mode sync agent (PORTUNI_AGENT_MODE=1) -- direct Turso, one
// machine, no remote. Read live rather than cached: unlike identity context
// (per-request, worth memoizing) this is checked rarely enough that a stale
// cache is not worth the test-seam cost.
export function isLocalWorkspace(): boolean {
  const agentMode = process.env.PORTUNI_AGENT_MODE === "1";
  return authMode() !== "google" && !agentMode;
}

// The central server (api.portuni.com): google auth and not a sync agent.
// It holds the session RECORD only and never opens a device content db
// (infra/device-content-db.ts); the content it still has is the legacy
// graph-db rows an older sidecar wrote (#456 compatibility, dropped by the
// central migration).
export function isCentralServer(): boolean {
  return authMode() === "google" && process.env.PORTUNI_AGENT_MODE !== "1";
}
