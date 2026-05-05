import type { Client } from "@libsql/client";
import { ulid } from "ulid";
import { getDb } from "./db.js";

// Shared audit-log writer. Domain modules call this with their own Client
// (so they remain pure functions testable against an in-memory DB).
export async function writeAudit(
  db: Client,
  userId: string,
  action: string,
  targetType: string,
  targetId: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    args: [ulid(), userId, action, targetType, targetId, detail ? JSON.stringify(detail) : null],
  });
}

// Convenience wrapper for callers without an explicit Client (HTTP handlers
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
