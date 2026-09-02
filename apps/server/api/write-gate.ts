// REST-layer wrapper around the domain write gate (../domain/write-gate.ts),
// mirroring mcp/write-gate.ts's pattern for MCP tools. Covers the
// "graph plane" REST mutations (nodes, edges, events, responsibilities,
// data sources, tools, mirror creation, access grants, positions) that have
// a direct MCP-tool equivalent already gated by guardNodeWrite -- see
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
// #211 (verification follow-up to #203) asked to also gate the routes above
// on the strength of "a device-token agent can still use them" -- but
// test/api-write-gate.test.ts already asserts PUT /nodes/:id/file passes for
// a bare device_token identity precisely because that IS CentralClient's own
// channel; gating it would 403 every central-mode teammate's sync run, not
// just a rogue caller, since the REST layer has no way to tell the two
// apart without a properly threaded session context (a materially bigger
// change than a single write-gate call -- CentralClient would need to
// forward its triggering session's id on every request, and the mirror
// watcher's session-less reconcile loop has no session id to forward at
// all). Left as-is; see the comment on issue #210 for the full reasoning.
//
// #212: those same file-plane routes are gated for ONE identity shape --
// a headless device token (RequestIdentity.headless, admin-minted for
// unattended/RALPH-style sessions, never self-declared) -- via the
// dedicated guardHeadlessFileWrite below, not guardRestNodeWrite directly.
// A headless credential is not CentralClient's teammate-sync identity (that
// stays a plain, non-headless device token), so narrowing it to its bound
// session's home node here closes the hole without touching the exemption
// above.
//
// Trust boundary for the "env" exemption below: env auth mode resolves
// EVERY request to the same unscoped solo identity regardless of who sent
// it (auth/env-adapter.ts), so on its own "env" would make this gate a
// no-op for anything that can reach the loopback port with the shared
// token -- including a spawned agent terminal, not just the desktop
// webview's Tauri-proxied calls (#210 point 2). The X-Portuni-Spawn-Id
// header (mcp/transport.ts, minted into the per-mirror .mcp.json by
// domain/write-scope.ts for MCP connections) is reused here as an opt-in
// REST marker: when a request carries it, we resolve the session it names
// (must be owned by this identity and still running) and enforce that
// session's actual write scope (home node + accepted expansions from
// session_scope) instead of the blanket "env" exemption. A request that
// omits the header -- the webview/Tauri-proxy path, and any caller that
// simply doesn't send it -- keeps today's "env" exemption; this is a
// narrowing, not a new hole, matching the issue's own framing ("the plain
// webview/Tauri-proxy path stays exempt").
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestIdentity } from "../auth/request-identity.js";
import { guardWrite, writeGuardError, type WriteContext } from "../domain/write-gate.js";
import { respondJson } from "../http/middleware.js";
import { getDb } from "../infra/db.js";
import { getSession, getSessionScope } from "../domain/sessions.js";

function spawnSessionIdFromRequest(req: Pick<IncomingMessage, "headers">): string | null {
  const header = req.headers["x-portuni-spawn-id"];
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  return value || null;
}

// Resolve the WriteContext a REST mutation should be checked against.
// oauth_grant (the claude.ai connector) has no home node and never gets
// one -- empty write set, every write elicited (refused outright here, no
// dialog channel). A device_token/session_jwt/env identity carrying a
// resolvable X-Portuni-Spawn-Id is scoped to that session's actual write
// set; otherwise env/session_jwt keep the "env" exemption and any other
// identity (a bare device_token, or a headless one) gets the narrowest
// applicable session type with an empty write set, matching
// domain/write-gate.ts's headless/interactive_task semantics.
export async function resolveRestWriteContext(
  req: Pick<IncomingMessage, "headers">,
  identity: RequestIdentity,
): Promise<WriteContext> {
  if (identity.via === "oauth_grant") {
    return { sessionType: "interactive_chat", homeNodeId: null, writableNodes: new Set() };
  }
  const spawnSessionId = spawnSessionIdFromRequest(req);
  if (spawnSessionId) {
    const db = getDb();
    const session = await getSession(db, spawnSessionId);
    if (session && session.user_id === identity.userId && session.state === "running") {
      const scopeRows = await getSessionScope(db, spawnSessionId);
      const writableNodes = new Set(scopeRows.filter((r) => r.writable === 1).map((r) => r.node_id));
      return { sessionType: "interactive_task", homeNodeId: session.node_id, writableNodes };
    }
  }
  if (identity.via === "env" || identity.via === "session_jwt") {
    return { sessionType: "env", homeNodeId: null, writableNodes: new Set() };
  }
  if (identity.headless) {
    return { sessionType: "headless", homeNodeId: null, writableNodes: new Set() };
  }
  return { sessionType: "interactive_task", homeNodeId: null, writableNodes: new Set() };
}

// Gate a REST mutation targeting nodeId. Returns true when the caller may
// proceed. On refusal, writes the 403 response itself (same JSON shape as
// the MCP write gate's structured refusal) and returns false.
export async function guardRestNodeWrite(
  req: Pick<IncomingMessage, "headers">,
  res: ServerResponse,
  identity: RequestIdentity,
  nodeId: string,
): Promise<boolean> {
  const ctx = await resolveRestWriteContext(req, identity);
  const outcome = guardWrite(ctx, nodeId);
  if (outcome.kind === "allow") return true;
  respondJson(res, 403, writeGuardError(nodeId, outcome.kind, outcome.message));
  return false;
}

// Headless-only gate for the file-plane routes that stay otherwise ungated
// above (PUT file content, register/register-batch, move, delete, sync,
// remote-sweep) -- CentralClient's own teammate-sync channel calls these
// with a bare (non-headless) device token and must keep working unchanged,
// so this deliberately does NOT call guardRestNodeWrite unconditionally
// (that would 403 every teammate's sync run, see the header comment). It
// only enforces write scope when the caller IS a headless device token
// (#212): an admin-minted, unattended credential with no elicitation
// channel, distinguishable from a teammate's device token via
// RequestIdentity.headless. resolveRestWriteContext already resolves a
// headless identity to its bound session's write scope via
// X-Portuni-Spawn-Id when present (home node only, headless sessions never
// expand mid-run) and refuses outright with an empty scope when absent --
// exactly the "resolve via the session it's bound to, otherwise refuse"
// rule this issue asks for.
export async function guardHeadlessFileWrite(
  req: Pick<IncomingMessage, "headers">,
  res: ServerResponse,
  identity: RequestIdentity,
  nodeId: string,
): Promise<boolean> {
  if (!(identity.via === "device_token" && identity.headless === true)) return true;
  return guardRestNodeWrite(req, res, identity, nodeId);
}

// Batch variant for handlePositions (api/nodes.ts): filters nodeIds down to
// the ones this request's write context may touch, silently dropping the
// rest -- matching the existing "hidden node -> silently omitted" pattern
// for batch endpoints (e.g. handleSyncInfoBatch) rather than 403ing the
// whole batch over one out-of-scope entry.
export async function filterRestWritableNodeIds(
  req: Pick<IncomingMessage, "headers">,
  identity: RequestIdentity,
  nodeIds: readonly string[],
): Promise<Set<string>> {
  const ctx = await resolveRestWriteContext(req, identity);
  return new Set(nodeIds.filter((id) => guardWrite(ctx, id).kind === "allow"));
}
