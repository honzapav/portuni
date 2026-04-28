// Read projection: full graph payload (nodes + edges) for the frontend.
// Pure: takes a libsql Client, no HTTP/MCP coupling.

import type { Client } from "@libsql/client";
import type { GraphPayload } from "../../shared/api-types.js";

export async function loadGraph(db: Client): Promise<GraphPayload> {
  // Return all nodes regardless of status. The frontend filters by
  // completed/archived on the client so toggles are instantaneous and
  // completed work stays visible by default.
  // LEFT JOIN actors so we can render the owner pip on the graph
  // without an extra round-trip per node.
  const nodesRes = await db.execute({
    sql: `SELECT n.id, n.type, n.name, n.description, n.status,
                 n.lifecycle_state, n.pos_x, n.pos_y,
                 a.id   AS owner_id,
                 a.name AS owner_name
          FROM nodes n
          LEFT JOIN actors a ON a.id = n.owner_id
          ORDER BY n.type, n.name`,
  });

  const edgesRes = await db.execute({
    sql: `SELECT id, source_id, target_id, relation
          FROM edges`,
  });

  return {
    nodes: nodesRes.rows.map((row) => ({
      id: row.id as string,
      type: row.type as string,
      name: row.name as string,
      description: (row.description as string | null) ?? null,
      status: row.status as string,
      lifecycle_state: (row.lifecycle_state as string | null) ?? null,
      owner:
        row.owner_id != null
          ? { id: row.owner_id as string, name: row.owner_name as string }
          : null,
      pos_x: row.pos_x as number | null,
      pos_y: row.pos_y as number | null,
    })),
    edges: edgesRes.rows.map((row) => ({
      id: row.id as string,
      source_id: row.source_id as string,
      target_id: row.target_id as string,
      relation: row.relation as string,
    })),
  };
}
