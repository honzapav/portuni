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
// Trust boundary for the "env" exemption below (#213, tightening #210
// point 2): env auth mode resolves EVERY request to the same unscoped solo
// identity regardless of who sent it (auth/env-adapter.ts) -- including a
// spawned agent terminal, which holds the exact same loopback bearer token
// as the desktop webview and can even export X-Portuni-Spawn-Id itself
// (PORTUNI_SPAWN_SESSION_ID is plain env in that shell). A self-declared
// marker cannot be trusted to distinguish the two.
//
// PORTUNI_WEBVIEW_PROXY_SECRET switches env mode's write gate between two
// postures:
//   - Unset (the historical default -- every standalone/solo deployment
//     and the whole existing test suite, none of which know about this
//     var): env keeps the pre-#213 blanket exemption unconditionally, same
//     as session_jwt below. Nothing changes for a caller that hasn't
//     opted in.
//   - Set: the blanket exemption requires proof, fail-closed otherwise.
//     An env-mode request gets it ONLY with a valid X-Portuni-Webview-Proxy
//     header matching this secret. That header is generated fresh per
//     launch by the Tauri host (apps/desktop/src/lib.rs, random_token()),
//     handed to the sidecar only via child-process env (never written to
//     disk, never exported into a spawned terminal's env, .mcp.json, or
//     PORTUNI_SCOPE.md), and attached to every locally-proxied api_request
//     call from the Rust side -- a spawned shell has no way to read it.
//     The dev-mode equivalent is apps/web/vite.config.ts's dev-proxy,
//     injecting the same header from its own process env (varlock),
//     mirroring how PORTUNI_AUTH_TOKEN already reaches the proxy without
//     landing in the client bundle. A deployment that wants the hardened
//     posture sets the same value for both the server and its proxy.
//
// The X-Portuni-Spawn-Id header (mcp/transport.ts, minted into the
// per-mirror .mcp.json by domain/write-scope.ts for MCP connections) is
// still honored first regardless of the posture above, and still an opt-in
// REST marker: when a request carries it and it resolves (owned by this
// identity, still running), the request is scoped to that session's actual
// write set instead of the blanket exemption -- a legitimate narrowing
// available to every identity shape, not just "env". When the hardened
// posture is active (secret configured) an env-mode request whose spawn id
// does NOT resolve (unknown, foreign, or simply stale) fails closed
// outright instead of falling back to the blanket exemption: a
// forged/guessed id must not be indistinguishable from "no marker at all".
//
// session_jwt (central-mode desktop webview, authenticated via a real
// per-user Google login JWT that never leaves the Rust Keychain/webview
// boundary -- see auth.rs) is unaffected by this issue either way: it is
// not a shared secret a spawned shell could hold, and central-mode graph
// writes never reach this local sidecar's env-mode auth path at all (they
// go straight to the central server over that JWT). It keeps the
// unconditional "env" write context, matching its historical behavior.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestIdentity } from "../auth/request-identity.js";
import { guardWrite, writeGuardError, type WriteContext } from "../domain/write-gate.js";
import { respondJson, timingSafeStringEqual } from "../http/middleware.js";
import { getDb } from "../infra/db.js";
import { getSession, getSessionScope } from "../domain/sessions.js";

function spawnSessionIdFromRequest(req: Pick<IncomingMessage, "headers">): string | null {
  const header = req.headers["x-portuni-spawn-id"];
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  return value || null;
}

function webviewProxySecretFromRequest(req: Pick<IncomingMessage, "headers">): string {
  const header = req.headers["x-portuni-webview-proxy"];
  return (Array.isArray(header) ? header[0] : header)?.trim() ?? "";
}

// Read at call time, not module load: tests (and any other in-process
// caller) set PORTUNI_WEBVIEW_PROXY_SECRET after this module is first
// imported.
function configuredWebviewProxySecret(): string {
  return (process.env.PORTUNI_WEBVIEW_PROXY_SECRET ?? "").trim();
}

function webviewProxyProven(req: Pick<IncomingMessage, "headers">, configured: string): boolean {
  return timingSafeStringEqual(webviewProxySecretFromRequest(req), configured);
}

// Resolve the WriteContext a REST mutation should be checked against.
// oauth_grant (the claude.ai connector) has no home node and never gets
// one -- empty write set, every write elicited (refused outright here, no
// dialog channel). Any identity carrying a resolvable X-Portuni-Spawn-Id is
// scoped to that session's actual write set; env additionally accepts a
// proven X-Portuni-Webview-Proxy marker for the blanket exemption once
// PORTUNI_WEBVIEW_PROXY_SECRET is configured; session_jwt keeps the "env"
// exemption unconditionally; any other identity (a bare device_token, a
// headless one, or -- only in the hardened posture -- an env-mode request
// with neither proof) gets the narrowest applicable session type with an
// empty write set, matching domain/write-gate.ts's headless/
// interactive_task semantics.
export async function resolveRestWriteContext(
  req: Pick<IncomingMessage, "headers">,
  identity: RequestIdentity,
): Promise<WriteContext> {
  if (identity.via === "oauth_grant") {
    return { sessionType: "interactive_chat", homeNodeId: null, writableNodes: new Set() };
  }
  const webviewProxySecret = configuredWebviewProxySecret();
  const spawnSessionId = spawnSessionIdFromRequest(req);
  if (spawnSessionId) {
    const db = getDb();
    const session = await getSession(db, spawnSessionId);
    if (session && session.user_id === identity.userId && session.state === "running") {
      const scopeRows = await getSessionScope(db, spawnSessionId);
      const writableNodes = new Set(scopeRows.filter((r) => r.writable === 1).map((r) => r.node_id));
      return { sessionType: "interactive_task", homeNodeId: session.node_id, writableNodes };
    }
    // Unknown/foreign/stale spawn id on an env-mode request: in the
    // hardened posture, fail closed rather than falling through to the
    // webview-proxy check or the blanket exemption below -- a forged id
    // must not be equivalent to "no marker at all".
    if (identity.via === "env" && webviewProxySecret) {
      return { sessionType: "headless", homeNodeId: null, writableNodes: new Set() };
    }
  }
  if (identity.via === "session_jwt") {
    return { sessionType: "env", homeNodeId: null, writableNodes: new Set() };
  }
  if (identity.via === "env") {
    if (!webviewProxySecret || webviewProxyProven(req, webviewProxySecret)) {
      return { sessionType: "env", homeNodeId: null, writableNodes: new Set() };
    }
    return { sessionType: "headless", homeNodeId: null, writableNodes: new Set() };
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
