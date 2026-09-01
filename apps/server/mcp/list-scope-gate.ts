// Shared scope-gate for per-node MCP listing tools (portuni_list_events,
// portuni_list_files, ...). With node_id we run the standard read guard; the
// per-tool callback shape (content + isError) is encoded once here so the
// listing tools don't each re-implement it. Without node_id there is nothing
// to gate here -- each caller restricts to its own in-memory scope set
// directly (search and global list_nodes skip this module entirely: they are
// permission-only, see docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md
// "Search is discovery, not ingestion").

import type { Client } from "@libsql/client";
import { guardNodeRead, type SessionScope } from "./scope.js";
import type { GroupIdentityView } from "../auth/node-access.js";
import type { Elicitor } from "./elicit.js";

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
  userId: string,
  identity?: GroupIdentityView,
  elicitor?: Elicitor,
): Promise<ListScopeGateResult> {
  if (nodeId === undefined) {
    return { kind: "ok" };
  }

  const guard = await guardNodeRead(db, scope, nodeId, userId, identity, elicitor);
  if (guard.kind === "not_found") {
    return {
      kind: "error",
      response: {
        content: [{ type: "text", text: `Error: node ${nodeId} not found` }],
        isError: true,
      },
    };
  }
  if (guard.kind === "elicit" || guard.kind === "refused") {
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
