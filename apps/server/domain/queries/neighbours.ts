// Depth-1 graph neighbours of a node. The single definition of "depth-1",
// shared by scope seeding (apps/server/mcp/scope.ts seedScopeFromHome) and
// the Seatbelt read-grant set (apps/server/domain/sandbox-profile.ts), so the
// disk grant can never diverge from the seeded session scope.

import type { Client } from "@libsql/client";

// Distinct peer ids across every edge touching nodeId, in either direction.
// Raw (no visibility filtering) -- callers that need group visibility layer
// filterVisibleNodeIds on top; the sandbox grant does not (it only ever
// grants the caller's own locally-mirrored nodes).
export async function nodeNeighbourIds(db: Client, nodeId: string): Promise<string[]> {
  const res = await db.execute({
    sql: `SELECT DISTINCT
            CASE WHEN e.source_id = ? THEN e.target_id ELSE e.source_id END AS peer_id
          FROM edges e
          WHERE e.source_id = ? OR e.target_id = ?`,
    args: [nodeId, nodeId, nodeId],
  });
  return res.rows.map((row) => row.peer_id as string).filter(Boolean);
}
