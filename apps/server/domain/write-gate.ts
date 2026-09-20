// Domain-layer write gate: the single source of write-scope enforcement,
// shared by every mutation entry point. Putting this in the domain layer
// rather than the MCP tool layer is deliberate: a check embedded only in
// tools/*.ts would be bypassed by any other entry point reaching the same
// mutation -- specifically the five agent-mode LOCAL_TOOLS (portuni_mirror,
// portuni_store, portuni_pull, portuni_adopt_files; portuni_status is
// read-only) that dispatch straight to CentralClient/REST from
// agent-transport.ts, never touching apps/server/mcp/tools/*.ts at all. See
// docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md
// ("Write scope", "Enforcement points").
//
// Write scope is deliberately narrower than read scope:
//   - `env`: historical unscoped behavior (solo/loopback desktop UI and its
//     own REST/Tauri-proxied calls) -- not part of this model, always allowed.
//   - `interactive_task` / `headless`: write set = home node, plus nodes
//     created by this session or explicitly granted (SessionScope's write
//     set). Anything else requires the user's confirmation.
//   - `interactive_chat`: no home node, so the write set starts with only
//     the nodes this user's earlier connector sessions created (rehydrated
//     from session_scope by mcp/session-persistence.ts's
//     rehydrateConnectorWriteGrants -- a connector client reconnects
//     constantly, so an in-memory-only "created by this session" grant
//     would be gone by the time the user asks to attach a file to the node
//     they just created) -- every other write needs confirmation.
//   - `headless` has no elicitation channel and no deferred-review path for
//     writes mid-run: anything outside the write set is refused outright,
//     never merely deferred (mirrors the hard-floor read behavior).
//
// Mirrors mcp/scope.ts's SessionType union -- duplicated rather than
// imported so this module has no dependency on the MCP layer.
export type WriteSessionType = "interactive_task" | "interactive_chat" | "headless" | "env";

export interface WriteContext {
  sessionType: WriteSessionType;
  homeNodeId: string | null;
  writableNodes: ReadonlySet<string>;
}

// Why a write is gated, in one sentence a person can act on. The domain
// layer has no DB handle and cannot name the node, so callers that can
// (mcp/write-gate.ts, tools/scope.ts) pair this with nodeConsentPrompt;
// agent-transport.ts, which has no graph DB at all, uses it with the bare
// node ID. Kept here so every write dialog gives the same reason.
export const WRITE_SCOPE_WHY = "It is outside this session's write scope.";

export type WriteGuardOutcome =
  | { kind: "allow" }
  // agentHint (not a single shared `message`) because the structured error
  // and the confirmation dialog address different readers: this text names
  // the node ID and the expand_scope call for the agent, and must never be
  // what a human is asked to approve. See ScopeRequestDecision in
  // mcp/scope.ts for the read-side counterpart.
  | { kind: "elicit"; agentHint: string }
  | { kind: "refused"; agentHint: string };

export function guardWrite(ctx: WriteContext, nodeId: string): WriteGuardOutcome {
  if (ctx.sessionType === "env") return { kind: "allow" };
  if (nodeId === ctx.homeNodeId || ctx.writableNodes.has(nodeId)) {
    return { kind: "allow" };
  }
  if (ctx.sessionType === "headless") {
    return {
      kind: "refused",
      agentHint:
        `Node ${nodeId} is outside this headless session's write scope (home node only). ` +
        `Headless sessions cannot expand their write set mid-run -- this write cannot proceed.`,
    };
  }
  // interactive_task (home-only, expandable) and interactive_chat (empty,
  // expandable) both round-trip through user confirmation.
  return {
    kind: "elicit",
    agentHint:
      `Node ${nodeId} is outside this session's write scope. Ask the user to confirm this ` +
      `write, then call portuni_expand_scope with node_ids: ["${nodeId}"], writable: true, ` +
      `reason 'user-confirmed-in-chat'.`,
  };
}

// Hint for an "elicit" outcome whose dialog could not be shown because the
// client never declared the MCP elicitation capability (claude.ai web and
// mobile, Codex CLI): the default agentHint above tells the agent to call
// portuni_expand_scope with writable: true, but that call is refused
// outright on such a client (no honor-system fallback for writes) -- the
// hint would send the agent down a path that cannot ever succeed. Say so
// directly, and name the two paths that do work.
export function noElicitationWriteHint(nodeId: string): string {
  return (
    `Node ${nodeId} is outside this session's write scope, and this client does not support ` +
    `MCP elicitation dialogs, so write access cannot be granted from this session -- do NOT call ` +
    `portuni_expand_scope with writable: true, it will be refused for the same reason. ` +
    `Either continue from a client with confirmation dialogs (Claude Code, the Portuni desktop app) ` +
    `or, for new work, create the node from this chat: nodes created by a connector session stay ` +
    `writable in this user's later connector sessions.`
  );
}

// Hint for an "elicit" outcome whose dialog was really shown but went
// unanswered until the hop's own deadline (mcp/elicit.ts, #409). Unlike the
// capability-absent case above, portuni_expand_scope(writable: true) IS
// available here -- the user simply was not at the keyboard -- so the hint
// keeps that path and only says what happened.
export function timedOutWriteHint(nodeId: string): string {
  return (
    `The confirmation dialog for write access to node ${nodeId} was not answered in time, so the ` +
    `write did not happen. Nothing was changed. Ask the user in chat, then either retry the tool ` +
    `(a new dialog is shown) or call portuni_expand_scope with node_ids: ["${nodeId}"], ` +
    `writable: true, reason 'user-confirmed-in-chat'.`
  );
}

export interface WriteGuardErrorPayload {
  error: string;
  node_id: string;
  hint: string;
  // Present (false) only when the dialog was skipped because the client
  // has no elicitation capability -- the one case where the usual
  // "confirm, then expand_scope" contract cannot be completed from this
  // session. Absent otherwise, so existing payload shapes stay unchanged.
  elicitation_supported?: false;
  // Present (true) only when a dialog WAS shown and went unanswered until
  // the hop's deadline (#409): the tool answers instead of hanging past the
  // client's own tool-call timeout, and the agent can retry.
  dialog_timed_out?: true;
}

export function writeGuardError(
  nodeId: string,
  kind: "elicit" | "refused",
  hint: string,
  opts: { elicitationSupported?: boolean; dialogTimedOut?: boolean } = {},
): WriteGuardErrorPayload {
  let hintText = hint;
  if (opts.elicitationSupported === false) hintText = noElicitationWriteHint(nodeId);
  else if (opts.dialogTimedOut === true) hintText = timedOutWriteHint(nodeId);
  const payload: WriteGuardErrorPayload = {
    error: kind === "refused" ? "write_refused" : "write_expansion_required",
    node_id: nodeId,
    hint: hintText,
  };
  if (opts.elicitationSupported === false) payload.elicitation_supported = false;
  if (opts.dialogTimedOut === true) payload.dialog_timed_out = true;
  return payload;
}
