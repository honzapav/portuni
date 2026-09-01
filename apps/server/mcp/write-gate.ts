// MCP-layer wrapper around the domain write gate (../domain/write-gate.ts),
// mirroring list-scope-gate.ts's pattern for reads: bundles the tool
// error-response shape once so mutation handlers don't each re-implement it.

import { guardWrite, writeGuardError, type WriteContext } from "../domain/write-gate.js";
import type { SessionScope } from "./scope.js";

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

// Gate a mutation targeting `nodeId`. Callers check `.kind === "error"` and
// return `.response` verbatim -- the same shape every tool handler already
// returns for its own errors.
export function guardNodeWrite(scope: SessionScope, nodeId: string): WriteGateResult {
  const outcome = guardWrite(writeContextFromScope(scope), nodeId);
  if (outcome.kind === "allow") return { kind: "ok" };
  return {
    kind: "error",
    response: {
      content: [
        { type: "text", text: JSON.stringify(writeGuardError(nodeId, outcome.kind, outcome.message)) },
      ],
      isError: true,
    },
  };
}
