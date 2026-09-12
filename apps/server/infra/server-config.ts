// Pure config helpers usable from tests without booting the server.
// Anything that imports src/server.ts triggers main() at module load.

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0:0:0:0:0:0:0:1"]);

export interface AuthBootCheckInput {
  authEnabled: boolean;
  host: string;
  tursoUrl: string;
}

export type AuthBootCheckResult =
  | { ok: true }
  | { ok: false; reasons: string[]; message: string };

// libSQL `file:` URLs (including `file::memory:`) point at a local SQLite
// database, not a shared team DB. Desktop/embedded mode sets TURSO_URL to
// a file path so config can still flow through the normal env, but it
// shouldn't trip the team-DB auth gate.
function isLocalLibsqlUrl(url: string): boolean {
  return url.trim().toLowerCase().startsWith("file:");
}

// Refuse to boot in any team/production-shaped configuration without auth.
// Loopback + local SQLite is the only mode where running without a token
// is acceptable, because the only attacker is another process on this
// machine. Anything else (LAN bind, remote Turso) means the server is
// reachable by some other identity and silently disabling auth is unsafe.
export function checkAuthRequiredForConfig(
  cfg: AuthBootCheckInput,
): AuthBootCheckResult {
  if (cfg.authEnabled) return { ok: true };
  const reasons: string[] = [];
  if (!LOOPBACK_HOSTS.has(cfg.host.toLowerCase())) {
    reasons.push(`HOST=${cfg.host} is not a loopback address`);
  }
  if (cfg.tursoUrl.trim() !== "" && !isLocalLibsqlUrl(cfg.tursoUrl)) {
    reasons.push("TURSO_URL is set (shared team database)");
  }
  if (reasons.length === 0) return { ok: true };
  return {
    ok: false,
    reasons,
    message: `Refusing to start: PORTUNI_AUTH_TOKEN is unset but the server is in a team/prod configuration (${reasons.join("; ")}). Set PORTUNI_AUTH_TOKEN to enable bearer auth, or set HOST=127.0.0.1 and unset TURSO_URL (or use a file: URL) for single-machine loopback dev.`,
  };
}

// A local workspace is neither the central server (PORTUNI_AUTH_MODE=google)
// nor a central-mode sync agent (PORTUNI_AGENT_MODE=1) -- direct Turso, one
// machine, no remote. Read live rather than cached: unlike identity context
// (per-request, worth memoizing) this is checked rarely enough that a stale
// cache is not worth the test-seam cost.
export function isLocalWorkspace(): boolean {
  const authMode = (process.env.PORTUNI_AUTH_MODE ?? "env") === "google" ? "google" : "env";
  const agentMode = process.env.PORTUNI_AGENT_MODE === "1";
  return authMode !== "google" && !agentMode;
}
