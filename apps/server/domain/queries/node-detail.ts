// Read projection: full node detail payload for the frontend's detail pane.
// Pure: takes a libsql Client + a userId for mirror lookup.

import type { Client } from "@libsql/client";
import { NodeRow } from "../../shared/types.js";
import type { NodeDetail } from "../../shared/api-types.js";
import { listUserMirrors, unregisterMirror } from "../sync/mirror-registry.js";
import { getLocalMirror } from "../sync/local-db.js";
import { deriveLocalPath, buildNodeRoot } from "../sync/remote-path.js";

export async function loadNodeDetail(
  db: Client,
  userId: string,
  nodeId: string,
): Promise<NodeDetail | null> {
  void listUserMirrors;
  void unregisterMirror;

  const nodeRes = await db.execute({
    sql: "SELECT * FROM nodes WHERE id = ?",
    args: [nodeId],
  });
  if (nodeRes.rows.length === 0) return null;
  const row = NodeRow.parse(nodeRes.rows[0]);

  const edgeRes = await db.execute({
    sql: `SELECT e.id, e.source_id, e.target_id, e.relation,
                 ns.name as source_name, ns.type as source_type,
                 nt.name as target_name, nt.type as target_type
          FROM edges e
          JOIN nodes ns ON ns.id = e.source_id
          JOIN nodes nt ON nt.id = e.target_id
          WHERE e.source_id = ? OR e.target_id = ?`,
    args: [row.id, row.id],
  });

  const edges = edgeRes.rows.map((edge) => {
    const sourceId = edge.source_id as string;
    const targetId = edge.target_id as string;
    const isOutgoing = sourceId === row.id;
    return {
      id: edge.id as string,
      relation: edge.relation as string,
      direction: (isOutgoing ? "outgoing" : "incoming") as "outgoing" | "incoming",
      peer_id: isOutgoing ? targetId : sourceId,
      peer_name: isOutgoing ? (edge.target_name as string) : (edge.source_name as string),
      peer_type: isOutgoing ? (edge.target_type as string) : (edge.source_type as string),
    };
  });

  const mirror = await getLocalMirror(userId, row.id);
  const mirrorPath = mirror?.local_path ?? null;
  const local_mirror = mirror
    ? { local_path: mirror.local_path, registered_at: mirror.registered_at }
    : null;

  // Resolve the org_sync_key once for this node so per-file derivation can
  // reuse it. Organizations themselves have no parent org -- buildNodeRoot
  // falls back to the node's own sync_key in that case.
  let orgSyncKey: string | null = null;
  if (row.type !== "organization") {
    const orgRes = await db.execute({
      sql: `SELECT org.sync_key FROM edges e
              JOIN nodes org ON org.id = e.target_id
             WHERE e.source_id = ? AND e.relation = 'belongs_to' AND org.type = 'organization'
             LIMIT 1`,
      args: [row.id],
    });
    orgSyncKey = orgRes.rows.length > 0 ? (orgRes.rows[0].sync_key as string | null) ?? null : null;
  } else {
    orgSyncKey = row.sync_key;
  }

  const fileRes = await db.execute({
    sql: `SELECT id, filename, status, description, remote_path, mime_type
          FROM files WHERE node_id = ? ORDER BY created_at DESC`,
    args: [row.id],
  });
  const files = fileRes.rows.map((f) => {
    const remotePath = (f.remote_path as string | null) ?? null;
    let derivedLocal: string | null = null;
    if (mirrorPath && remotePath) {
      const nodeRoot = buildNodeRoot({
        orgSyncKey,
        nodeType: row.type,
        nodeSyncKey: row.sync_key,
      });
      try {
        derivedLocal = deriveLocalPath({ mirrorRoot: mirrorPath, nodeRoot, remotePath });
      } catch {
        derivedLocal = null;
      }
    }
    const relative_path =
      mirrorPath && derivedLocal?.startsWith(mirrorPath + "/")
        ? derivedLocal.slice(mirrorPath.length + 1)
        : null;
    return {
      id: f.id as string,
      filename: f.filename as string,
      status: f.status as string,
      description: (f.description as string | null) ?? null,
      local_path: derivedLocal,
      relative_path,
      mime_type: (f.mime_type as string | null) ?? null,
    };
  });

  const eventRes = await db.execute({
    sql: `SELECT id, type, content, meta, status, refs, task_ref, created_at
          FROM events WHERE node_id = ? AND status = 'active'
          ORDER BY created_at DESC LIMIT 20`,
    args: [row.id],
  });
  const events = eventRes.rows.map((e) => ({
    id: e.id as string,
    type: e.type as string,
    content: e.content as string,
    meta: e.meta ? JSON.parse(e.meta as string) : null,
    status: e.status as string,
    refs: e.refs ? JSON.parse(e.refs as string) : null,
    task_ref: (e.task_ref as string | null) ?? null,
    created_at: e.created_at as string,
  }));

  // Owner
  const ownerRow = row.owner_id
    ? (await db.execute({ sql: "SELECT id, name FROM actors WHERE id = ?", args: [row.owner_id] })).rows[0]
    : null;
  const owner = ownerRow ? { id: ownerRow.id as string, name: ownerRow.name as string } : null;

  // Responsibilities with assignees: fetch in two queries (one for the
  // responsibilities, one JOIN that returns every assignee for those
  // responsibilities) and bucket assignees by responsibility id in JS.
  // Avoiding N+1 keeps detail loads cheap on Turso/cloud.
  const respRes = await db.execute({
    sql: "SELECT id, title, description, sort_order FROM responsibilities WHERE node_id = ? ORDER BY sort_order, title",
    args: [row.id],
  });
  type AssigneeBucket = Array<{ id: string; name: string; type: string }>;
  const assigneesByResp = new Map<string, AssigneeBucket>();
  if (respRes.rows.length > 0) {
    const ids = respRes.rows.map((r) => r.id as string);
    const placeholders = ids.map(() => "?").join(",");
    const assigneeRes = await db.execute({
      sql: `SELECT ra.responsibility_id AS rid, a.id, a.name, a.type
            FROM actors a
            JOIN responsibility_assignments ra ON ra.actor_id = a.id
            WHERE ra.responsibility_id IN (${placeholders})
            ORDER BY a.name`,
      args: ids,
    });
    for (const x of assigneeRes.rows) {
      const rid = x.rid as string;
      let bucket = assigneesByResp.get(rid);
      if (!bucket) {
        bucket = [];
        assigneesByResp.set(rid, bucket);
      }
      bucket.push({
        id: x.id as string,
        name: x.name as string,
        type: x.type as string,
      });
    }
  }
  const responsibilities = respRes.rows.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    description: (r.description as string | null) ?? null,
    sort_order: (r.sort_order as number) ?? 0,
    assignees: assigneesByResp.get(r.id as string) ?? [],
  }));

  const dsRes = await db.execute({
    sql: "SELECT id, name, description, external_link FROM data_sources WHERE node_id = ? ORDER BY name",
    args: [row.id],
  });
  const data_sources = dsRes.rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    description: (r.description as string | null) ?? null,
    external_link: (r.external_link as string | null) ?? null,
  }));

  const toolsRes = await db.execute({
    sql: "SELECT id, name, description, external_link FROM tools WHERE node_id = ? ORDER BY name",
    args: [row.id],
  });
  const tools = toolsRes.rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    description: (r.description as string | null) ?? null,
    external_link: (r.external_link as string | null) ?? null,
  }));

  return {
    id: row.id,
    type: row.type,
    name: row.name,
    description: row.description,
    meta: row.meta ? JSON.parse(row.meta) : null,
    status: row.status,
    visibility: row.visibility,
    created_at: row.created_at,
    updated_at: row.updated_at,
    edges,
    files,
    events,
    local_mirror,
    owner,
    responsibilities,
    data_sources,
    tools,
    goal: row.goal ?? null,
    lifecycle_state: row.lifecycle_state ?? null,
  };
}
