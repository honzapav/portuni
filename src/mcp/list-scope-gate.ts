// Shared scope-gate for global-listing MCP tools (portuni_list_events,
// portuni_list_files, ...). With node_id we run the standard read guard;
// without it we run the global-query gate and audit the pass-through. The
// per-tool callback shape (content + isError) is encoded once here so the
// listing tools don't each re-implement it.

import type { Client } from "@libsql/client";
import { logAudit } from "../infra/audit.js";
import { SOLO_USER } from "../infra/schema.js";
import { decideGlobalQuery, guardNodeRead, type SessionScope } from "./scope.js";

type ToolErrorResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
};

export type ListScopeGateResult =
  | { kind: "ok" }
  | { kind: "error"; response: ToolErrorResponse };

export async function guardListScope(
  db: Client,
  scope: SessionScope,
  nodeId: string | undefined,
  toolName: string,
  auditTarget: string,
  filters: Record<string, unknown>,
): Promise<ListScopeGateResult> {
  if (nodeId !== undefined) {
    const guard = await guardNodeRead(
      db,
      scope,
      nodeId,
      SOLO_USER,
      async (action, targetId, detail) => {
        await logAudit(SOLO_USER, action, "scope", targetId, detail);
      },
    );
    if (guard.kind === "not_found") {
      return {
        kind: "error",
        response: {
          content: [{ type: "text", text: `Error: node ${nodeId} not found` }],
          isError: true,
        },
      };
    }
    if (guard.kind === "elicit") {
      return {
        kind: "error",
        response: {
          content: [{ type: "text", text: JSON.stringify(guard.error) }],
          isError: true,
        },
      };
    }
    return { kind: "ok" };
  }

  const g = decideGlobalQuery(scope);
  if (g.kind === "elicit") {
    return {
      kind: "error",
      response: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "scope_expansion_required",
              tool: toolName,
              hint: g.message,
            }),
          },
        ],
        isError: true,
      },
    };
  }
  scope.globalQuerySeen = true;
  await logAudit(SOLO_USER, "scope_global_query", "scope", auditTarget, {
    tool: toolName,
    filters,
    mode: scope.mode,
  });
  return { kind: "ok" };
}
