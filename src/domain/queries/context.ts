// Read projection: resolve a filesystem path to its owning node + depth-1
// neighbors. Used by REST GET /context for the SessionStart hook.

import type { Client } from "@libsql/client";
import { NodeSummaryRow } from "../../shared/types.js";
import { listUserMirrors, unregisterMirror } from "../sync/mirror-registry.js";

export async function resolveContext(
  db: Client,
  userId: string,
  path: string,
): Promise<unknown> {
  // Find node whose local_path matches or is a parent of the given path.
  // Read mirrors from per-device sync.db; tolerate stale rows (mirror exists
  // for a node that was purged from the shared DB) by skipping them and
  // firing a fire-and-forget cleanup.
  const rawMirrors = await listUserMirrors(userId);
  const mirrors: Array<{ node_id: string; local_path: string }> = [];
  for (const m of rawMirrors) {
    const e = await db.execute({
      sql: "SELECT 1 FROM nodes WHERE id = ? LIMIT 1",
      args: [m.node_id],
    });
    if (e.rows.length > 0) {
      mirrors.push({ node_id: m.node_id, local_path: m.local_path });
    } else {
      void unregisterMirror(userId, m.node_id).catch(() => undefined);
    }
  }
  // Longest-prefix match: order by path length desc.
  mirrors.sort((a, b) => b.local_path.length - a.local_path.length);

  let nodeId: string | null = null;
  let mirrorPath: string | null = null;
  for (const row of mirrors) {
    const lp = row.local_path;
    if (path === lp || path.startsWith(lp + "/")) {
      nodeId = row.node_id;
      mirrorPath = lp;
      break;
    }
  }

  if (!nodeId) {
    return { match: false, path };
  }

  const nodeRes = await db.execute({
    sql: "SELECT id, type, name, description, status FROM nodes WHERE id = ?",
    args: [nodeId],
  });
  const node = NodeSummaryRow.parse(nodeRes.rows[0]);

  const edges = await db.execute({
    sql: `SELECT e.relation,
            CASE WHEN e.source_id = ? THEN 'outgoing' ELSE 'incoming' END as direction,
            CASE WHEN e.source_id = ? THEN t.id ELSE s.id END as related_id,
            CASE WHEN e.source_id = ? THEN t.name ELSE s.name END as related_name,
            CASE WHEN e.source_id = ? THEN t.type ELSE s.type END as related_type
          FROM edges e
          JOIN nodes s ON e.source_id = s.id
          JOIN nodes t ON e.target_id = t.id
          WHERE e.source_id = ? OR e.target_id = ?`,
    args: [nodeId, nodeId, nodeId, nodeId, nodeId, nodeId],
  });

  const eventRes = await db.execute({
    sql: `SELECT id, type, content, created_at
          FROM events WHERE node_id = ? AND status = 'active'
          ORDER BY created_at DESC LIMIT 5`,
    args: [nodeId],
  });

  const events = eventRes.rows.map((e) => ({
    type: e.type as string,
    content: e.content as string,
    created_at: e.created_at as string,
  }));

  const relatedIds = edges.rows.map((r) => r.related_id as string);
  const relatedMirrors: Record<string, string> = {};
  if (relatedIds.length > 0) {
    const allMirrors = await listUserMirrors(userId);
    for (const m of allMirrors) {
      if (!relatedIds.includes(m.node_id)) continue;
      const e = await db.execute({
        sql: "SELECT 1 FROM nodes WHERE id = ? LIMIT 1",
        args: [m.node_id],
      });
      if (e.rows.length > 0) {
        relatedMirrors[m.node_id] = m.local_path;
      } else {
        void unregisterMirror(userId, m.node_id).catch(() => undefined);
      }
    }
  }

  return {
    match: true,
    node: {
      id: node.id,
      type: node.type,
      name: node.name,
      description: node.description,
      status: node.status,
      local_path: mirrorPath,
    },
    edges: edges.rows.map((e) => ({
      relation: e.relation,
      direction: e.direction,
      related: {
        id: e.related_id,
        type: e.related_type,
        name: e.related_name,
        local_path: relatedMirrors[e.related_id as string] || null,
      },
    })),
    events,
  };
}
