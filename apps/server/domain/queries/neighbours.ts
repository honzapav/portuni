// Depth-1 graph neighbours of a node. The single definition of "depth-1",
// used by scope seeding (apps/server/mcp/scope.ts seedScopeFromHome).

import type { DbClient } from "../../infra/db.js";

// Distinct peer ids across every edge touching nodeId, in either direction.
// Raw (no visibility filtering) -- callers that need group visibility layer
// filterVisibleNodeIds on top.
export async function nodeNeighbourIds(db: DbClient, nodeId: string): Promise<string[]> {
  const res = await db.execute({
    sql: `SELECT DISTINCT
            CASE WHEN e.source_id = ? THEN e.target_id ELSE e.source_id END AS peer_id
          FROM edges e
          WHERE e.source_id = ? OR e.target_id = ?`,
    args: [nodeId, nodeId, nodeId],
  });
  return res.rows.map((row) => row.peer_id as string).filter(Boolean);
}
