// resolveNodeInfo lives here (rather than engine.ts) so engine-mutations.ts
// can use it without forming an import cycle with engine.ts.

import type { Client } from "@libsql/client";
import type { NodeInfo } from "./remote-path.js";

export async function resolveNodeInfo(db: Client, nodeId: string): Promise<NodeInfo> {
  const r = await db.execute({
    sql: "SELECT type, sync_key FROM nodes WHERE id = ?",
    args: [nodeId],
  });
  if (r.rows.length === 0) throw new Error(`Node ${nodeId} not found`);
  const type = r.rows[0].type as string;
  const syncKey = r.rows[0].sync_key as string;
  if (type === "organization") {
    return { orgSyncKey: syncKey, nodeType: type, nodeSyncKey: syncKey };
  }
  const org = await db.execute({
    sql: `SELECT n.sync_key FROM edges e JOIN nodes n ON n.id = e.target_id
          WHERE e.source_id = ? AND e.relation = 'belongs_to' AND n.type = 'organization' LIMIT 1`,
    args: [nodeId],
  });
  const orgSyncKey = org.rows.length > 0 ? (org.rows[0].sync_key as string) : null;
  return { orgSyncKey, nodeType: type, nodeSyncKey: syncKey };
}
