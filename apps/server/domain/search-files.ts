// Content search across Portuni-tracked files, backed by the remotes'
// own search (Drive `fullText contains`, fs grep). The remote answers with
// paths; only paths that map onto a `files` record are returned, so a loose
// object on the drive that Portuni never registered is never surfaced.
// Callers apply scope + group visibility on the returned node ids -- this
// module knows nothing about the session.

import type { Client } from "@libsql/client";
import type { InValue } from "@libsql/client";
import { getAdapter } from "./sync/adapter-cache.js";
import { buildNodeRoot } from "./sync/remote-path.js";
import { mimeFor } from "./sync/engine.js";
import type { SearchHit } from "./sync/types.js";

export interface SearchFilesArgs {
  query: string;
  // Max records to return (after joining hits onto `files`).
  limit: number;
  // Restrict to one node.
  nodeId?: string;
}

export interface SearchFileRecord {
  file_id: string;
  node_id: string;
  node_name: string;
  node_type: string;
  filename: string;
  // Path within the node ("wip/notes.md"), the form portuni_read_file
  // takes. null when the record's remote_path does not sit under the node's
  // current root (a stale record after a sync_key change).
  path: string | null;
  remote_name: string;
  remote_path: string;
  mime_type: string | null;
  status: string;
  modified_at?: string;
  snippet?: string;
}

const IN_CHUNK = 200;

interface FileRow {
  id: string;
  node_id: string;
  node_name: string;
  node_type: string;
  node_sync_key: string;
  org_sync_key: string | null;
  filename: string;
  remote_path: string;
  mime_type: string | null;
  status: string;
}

async function remoteNamesFor(db: Client, nodeId: string | undefined): Promise<string[]> {
  const r = nodeId === undefined
    ? await db.execute("SELECT DISTINCT remote_name FROM files WHERE remote_name IS NOT NULL ORDER BY remote_name")
    : await db.execute({
        sql: "SELECT DISTINCT remote_name FROM files WHERE remote_name IS NOT NULL AND node_id = ? ORDER BY remote_name",
        args: [nodeId],
      });
  return r.rows.map((row) => row.remote_name as string);
}

async function recordsFor(
  db: Client,
  remoteName: string,
  paths: string[],
  a: SearchFilesArgs,
): Promise<Map<string, FileRow>> {
  const out = new Map<string, FileRow>();
  for (let i = 0; i < paths.length; i += IN_CHUNK) {
    const chunk = paths.slice(i, i + IN_CHUNK);
    const conds = ["f.remote_name = ?", `f.remote_path IN (${chunk.map(() => "?").join(",")})`];
    const params: InValue[] = [remoteName, ...chunk];
    if (a.nodeId !== undefined) {
      conds.push("f.node_id = ?");
      params.push(a.nodeId);
    }
    const r = await db.execute({
      sql: `SELECT f.id, f.node_id, f.filename, f.remote_path, f.mime_type, f.status,
                   n.name AS node_name, n.type AS node_type, n.sync_key AS node_sync_key,
                   (SELECT org.sync_key FROM edges e JOIN nodes org ON org.id = e.target_id
                     WHERE e.source_id = f.node_id AND e.relation = 'belongs_to' AND org.type = 'organization' LIMIT 1) AS org_sync_key
            FROM files f JOIN nodes n ON n.id = f.node_id
            WHERE ${conds.join(" AND ")}`,
      args: params,
    });
    for (const row of r.rows) {
      const rp = row.remote_path as string;
      // Two records on one remote path cannot exist (unique index), so the
      // first row per path is the only one.
      if (!out.has(rp)) {
        out.set(rp, {
          id: row.id as string,
          node_id: row.node_id as string,
          node_name: row.node_name as string,
          node_type: row.node_type as string,
          node_sync_key: row.node_sync_key as string,
          org_sync_key: (row.org_sync_key as string | null) ?? null,
          filename: row.filename as string,
          remote_path: rp,
          mime_type: (row.mime_type as string | null) ?? null,
          status: row.status as string,
        });
      }
    }
  }
  return out;
}

// "<nodeRoot>/<section>/<subpath>/<filename>" -> "<section>/<subpath>/<filename>".
function relPathFor(row: FileRow): string | null {
  let nodeRoot: string;
  try {
    nodeRoot = buildNodeRoot({
      orgSyncKey: row.org_sync_key,
      nodeType: row.node_type,
      nodeSyncKey: row.node_sync_key,
    });
  } catch {
    return null;
  }
  const prefix = `${nodeRoot}/`;
  return row.remote_path.startsWith(prefix) ? row.remote_path.slice(prefix.length) : null;
}

function toRecord(row: FileRow, remoteName: string, hit: SearchHit): SearchFileRecord {
  const mime =
    row.mime_type ??
    mimeFor(row.filename) ??
    (hit.mimeType !== "application/octet-stream" ? hit.mimeType : null);
  return {
    file_id: row.id,
    node_id: row.node_id,
    node_name: row.node_name,
    node_type: row.node_type,
    filename: row.filename,
    path: relPathFor(row),
    remote_name: remoteName,
    remote_path: row.remote_path,
    mime_type: mime,
    status: row.status,
    modified_at: hit.modifiedTime,
    snippet: hit.snippet,
  };
}

// Search every remote that holds tracked files (or the one node's remotes)
// and join the hits onto `files`. Remotes whose adapter has no `search` are
// skipped. Hits are returned in the order the backend produced them, one
// remote after another; the caller trims to its own limit after visibility
// filtering.
export async function searchFiles(db: Client, a: SearchFilesArgs): Promise<SearchFileRecord[]> {
  const query = a.query.trim();
  if (query.length === 0) return [];
  const remotes = await remoteNamesFor(db, a.nodeId);
  const out: SearchFileRecord[] = [];
  for (const remoteName of remotes) {
    if (out.length >= a.limit) break;
    const adapter = await getAdapter(db, remoteName);
    if (!adapter.search) continue;
    // Over-fetch: hits that are not tracked records (or are outside the
    // node filter) drop out of the join, so ask the backend for more than
    // the caller wants.
    const hits = await adapter.search(query, { limit: Math.min(a.limit * 3, 150) });
    if (hits.length === 0) continue;
    const rows = await recordsFor(db, remoteName, hits.map((h) => h.path), a);
    for (const hit of hits) {
      const row = rows.get(hit.path);
      if (!row) continue;
      out.push(toRecord(row, remoteName, hit));
      if (out.length >= a.limit) break;
    }
  }
  return out;
}
