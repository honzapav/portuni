// Auto-seed read scope from a `home_node_id` query parameter on the MCP
// connection URL. This is the harness-agnostic alternative to having every
// agent run an explicit `portuni_session_init(...)` call at session start.
//
// `portuni_mirror` writes the home node id into each mirror's `.mcp.json`
// and `.codex/config.toml`. When an MCP client connects to that URL, the
// transport extracts the id and calls `autoSeedFromHome` so the session's
// scope is ready before the first tool call.

import type { Client } from "@libsql/client";
import { type SessionScope, seedScopeFromHome } from "./scope.js";

type AuditFn = (
  action: string,
  targetId: string,
  detail: Record<string, unknown>,
) => Promise<void>;

// Extract `home_node_id` from a raw URL string. Accepts both absolute URLs
// (`http://host:port/mcp?home_node_id=...`) and request-target style paths
// (`/mcp?home_node_id=...`). Returns null when the param is missing, blank,
// or the URL cannot be parsed.
export function parseHomeNodeIdFromUrl(
  rawUrl: string | undefined | null,
): string | null {
  if (!rawUrl) return null;
  let params: URLSearchParams;
  try {
    // Try absolute URL first; fall back to a base so request-target paths parse.
    const url = rawUrl.startsWith("http")
      ? new URL(rawUrl)
      : new URL(rawUrl, "http://placeholder");
    params = url.searchParams;
  } catch {
    return null;
  }
  const value = params.get("home_node_id");
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed;
}

interface AutoSeedArgs {
  scope: SessionScope;
  homeNodeId: string | null;
  db: Client;
  auditFn: AuditFn;
}

interface AutoSeedResult {
  seeded: boolean;
  nodeIds: string[];
}

// Seed the session scope with the home node + its depth-1 neighbors.
// No-op when:
//   - homeNodeId is null/empty,
//   - the node does not exist (gracefully ignored — likely a stale URL),
//   - the scope already has a home node assigned (idempotent across reconnects).
//
// On success, writes a single `session_init` audit entry tagged
// `triggered_by=init` so the auto-seed is distinguishable from explicit
// agent / user expansions.
export async function autoSeedFromHome(args: AutoSeedArgs): Promise<AutoSeedResult> {
  if (!args.homeNodeId) return { seeded: false, nodeIds: [] };
  if (args.scope.homeNodeId !== null) return { seeded: false, nodeIds: [] };

  const exists = await args.db.execute({
    sql: "SELECT 1 FROM nodes WHERE id = ?",
    args: [args.homeNodeId],
  });
  if (exists.rows.length === 0) return { seeded: false, nodeIds: [] };

  const seeded = await seedScopeFromHome(args.db, args.scope, args.homeNodeId);
  args.scope.recordExpansion({
    at: new Date().toISOString(),
    node_ids: seeded,
    reason: "auto-seed from home_node_id query param",
    triggered_by: "init",
  });
  await args.auditFn("session_init", args.homeNodeId, {
    node_ids: seeded,
    triggered_by: "init",
    reason: "auto-seed from home_node_id query param",
  });
  return { seeded: true, nodeIds: seeded };
}
