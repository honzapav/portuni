import type { DbClient } from "./db.js";
import { ulid } from "ulid";
import { getDb } from "./db.js";
import { nowExpr } from "./sql.js";
import { publishNodeChange } from "./change-feed.js";

// The node an audit entry is about, for the change feed: the target when it
// is a node, else the `node_id` the detail carries (every file action and
// most child-entity actions do). A write with neither publishes nothing --
// its caller publishes on its own (edges name two nodes, for instance).
export function auditNodeId(targetType: string, targetId: string, detail?: Record<string, unknown>): string | null {
  if (targetType === "node") return targetId;
  const inDetail = detail?.node_id;
  return typeof inDetail === "string" && inDetail.length > 0 ? inDetail : null;
}

function auditChangeKind(action: string, targetType: string): "node" | "files" {
  return targetType === "file" || action.startsWith("sync_") ? "files" : "node";
}

// Shared audit-log writer. Domain modules call this with their own DbClient
// (so they remain pure functions testable against an in-memory DB).
export async function writeAudit(
  db: DbClient,
  userId: string,
  action: string,
  targetType: string,
  targetId: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ${nowExpr(db.dialect)})`,
    args: [ulid(), userId, action, targetType, targetId, detail ? JSON.stringify(detail) : null],
  });
  const nodeId = auditNodeId(targetType, targetId, detail);
  if (nodeId !== null) publishNodeChange(nodeId, auditChangeKind(action, targetType));
}

// Convenience wrapper for callers without an explicit DbClient (HTTP handlers
// that operate on the ambient process-wide DB).
export function logAudit(
  userId: string,
  action: string,
  targetType: string,
  targetId: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  return writeAudit(getDb(), userId, action, targetType, targetId, detail);
}
