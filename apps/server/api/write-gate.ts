// REST-layer wrapper around the domain write gate (../domain/write-gate.ts),
// mirroring mcp/write-gate.ts's pattern for MCP tools. Covers the
// "graph plane" REST mutations (nodes, edges, events, responsibilities,
// data sources, tools, mirror creation) that have a direct MCP-tool
// equivalent already gated by guardNodeWrite -- see
// docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md
// ("Enforcement points").
//
// Deliberately NOT applied to the file-content/sync-plane REST endpoints
// that CentralClient (domain/sync/central/client.ts, "Auth: a per-user
// device token") itself calls to drive the central-mode sync agent's
// deterministic reconciliation -- PUT file content, register-file(s),
// move/delete file records (handleMoveFile/handleDeleteFile's mirror-less
// branch is exactly CentralClient.moveFileRecord/deleteFileRecord), sync-info,
// sync-run, remote-sweep. That reconciliation has no per-request home-node/
// session context to check against -- gating it here would refuse the
// agent's own already-approved sync traffic outright (its write-scope check
// already happened once, at the MCP tool call that triggered the sync, or
// the mirror watcher acting on the device's own disk state -- see
// CLAUDE.md's "File state is deterministic" gotcha). File lifecycle
// endpoints CentralClient never calls (create, rename) stay gated below.
import type { ServerResponse } from "node:http";
import type { RequestIdentity } from "../auth/request-identity.js";
import { guardWrite, writeGuardError, type WriteContext, type WriteSessionType } from "../domain/write-gate.js";
import { respondJson } from "../http/middleware.js";

// REST requests carry no SessionScope (that lives only in the MCP layer,
// per-connection), so there is no home node / write-set to check an
// agent identity against -- an "elicit" outcome has no dialog to round-trip
// through either. Both cases refuse outright here. The desktop UI (webview
// via the Tauri proxy) and the central-mode account UI ("central_request",
// session_jwt) are the human-driven surface this model exempts, matching
// domain/write-gate.ts's "env" case for both.
function restSessionType(identity: Pick<RequestIdentity, "via" | "headless">): WriteSessionType {
  if (identity.via === "env" || identity.via === "session_jwt") return "env";
  if (identity.via === "oauth_grant") return "interactive_chat";
  if (identity.headless) return "headless";
  return "interactive_task";
}

// Gate a REST mutation targeting nodeId. Returns true when the caller may
// proceed. On refusal, writes the 403 response itself (same JSON shape as
// the MCP write gate's structured refusal) and returns false.
export function guardRestNodeWrite(
  res: ServerResponse,
  identity: RequestIdentity,
  nodeId: string,
): boolean {
  const ctx: WriteContext = {
    sessionType: restSessionType(identity),
    homeNodeId: null,
    writableNodes: new Set(),
  };
  const outcome = guardWrite(ctx, nodeId);
  if (outcome.kind === "allow") return true;
  respondJson(res, 403, writeGuardError(nodeId, outcome.kind, outcome.message));
  return false;
}
