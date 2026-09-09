// MCP-layer wrapper around the domain write gate (../domain/write-gate.ts),
// mirroring list-scope-gate.ts's pattern for reads: bundles the tool
// error-response shape once so mutation handlers don't each re-implement it.

import {
  guardWrite,
  writeGuardError,
  WRITE_SCOPE_WHY,
  type WriteContext,
} from "../domain/write-gate.js";
import { getDb } from "../infra/db.js";
import { loadNodeScopeMeta, nodeConsentPrompt, type SessionScope } from "./scope.js";
import type { Elicitor } from "./elicit.js";

type ToolErrorResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
};

export type WriteGateResult = { kind: "ok" } | { kind: "error"; response: ToolErrorResponse };

export function writeContextFromScope(scope: SessionScope): WriteContext {
  return {
    sessionType: scope.sessionType,
    homeNodeId: scope.homeNodeId,
    writableNodes: new Set(scope.writableNodes()),
  };
}

// Name and type of the node a write dialog is about. Best-effort: a failed
// lookup (no DB configured in a test harness, node vanished mid-call) leaves
// the prompt on the bare ID rather than failing the write.
async function nodeIdentity(nodeId: string): Promise<{ name: string | null; type: string | null }> {
  try {
    const meta = await loadNodeScopeMeta(getDb(), nodeId);
    return { name: meta.name, type: meta.type };
  } catch {
    return { name: null, type: null };
  }
}

// Gate a mutation targeting `nodeId`. Callers check `.kind === "error"` and
// return `.response` verbatim -- the same shape every tool handler already
// returns for its own errors.
//
// elicitor is optional (absent in most test harnesses -- see
// SessionCtx.elicit): when provided, an "elicit" outcome (interactive_task
// or interactive_chat, i.e. never headless -- guardWrite only ever refuses
// headless outright) tries a real protocol dialog before falling back to
// the structured-refusal convention. Accepting grants write access via
// scope.addWritable, the same mechanism portuni_expand_scope's writable
// flag uses.
export async function guardNodeWrite(
  scope: SessionScope,
  nodeId: string,
  elicitor?: Elicitor,
): Promise<WriteGateResult> {
  const outcome = guardWrite(writeContextFromScope(scope), nodeId);
  if (outcome.kind === "allow") return { kind: "ok" };
  if (outcome.kind === "elicit" && elicitor !== undefined) {
    // The dialog gets the node's name and type; the agent-facing hint, with
    // its expand_scope instructions, goes to the structured error below. The
    // lookup happens only on this branch -- a dialog is already a round trip
    // to a human, so one extra query costs nothing, and the hot allow path
    // stays DB-free.
    const dialogOutcome = await elicitor.confirm(
      nodeConsentPrompt("write to", nodeId, await nodeIdentity(nodeId), WRITE_SCOPE_WHY),
    );
    if (dialogOutcome === "accept") {
      scope.addWritable(nodeId);
      return { kind: "ok" };
    }
  }
  return {
    kind: "error",
    response: {
      content: [
        { type: "text", text: JSON.stringify(writeGuardError(nodeId, outcome.kind, outcome.agentHint)) },
      ],
      isError: true,
    },
  };
}
