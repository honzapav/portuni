// REST endpoints for /nodes (CRUD), /nodes/:id/sync-status,
// /nodes/:id/folder-url, /nodes/:id/sync, /nodes/:id/move, /positions.

import type { IncomingMessage, ServerResponse } from "node:http";
import { ulid } from "ulid";
import { getDb } from "../infra/db.js";
import { logAudit } from "../infra/audit.js";
import {
  NODE_TYPES,
  NODE_VISIBILITIES,
  SOLO_USER,
} from "../infra/schema.js";
import { generateSyncKey } from "../domain/sync/sync-key.js";
import { buildNodeRoot } from "../domain/sync/remote-path.js";
import { resolveRemote } from "../domain/sync/routing.js";
import { getAdapter } from "../domain/sync/adapter-cache.js";
import { statusScan, storeFile, pullFile } from "../domain/sync/engine.js";
import { updateNodeInternal } from "../domain/nodes.js";
import { moveNodeToOrganization } from "../domain/edges.js";
import { loadNodeDetail } from "../domain/queries/node-detail.js";
import type { SyncStatusResponse, SyncRunResponse } from "../shared/api-types.js";
import { parseBody, respondError } from "../http/middleware.js";

export async function handleGetNode(
  req: IncomingMessage,
  res: ServerResponse,
  nodeId: string,
): Promise<void> {
  if (!nodeId) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "node id required" }));
    return;
  }
  try {
    const node = await loadNodeDetail(getDb(), SOLO_USER, nodeId);
    if (!node) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "node not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(node));
  } catch (err) {
    respondError(res, `${req.method} /nodes/${nodeId}`, err);
  }
}

// Update fields on an existing node. Routes through updateNodeInternal so
// lifecycle/owner/goal validation + audit logging stay centralized in the
// pure function.
export async function handlePatchNode(
  req: IncomingMessage,
  res: ServerResponse,
  nodeId: string,
): Promise<void> {
  try {
    const body = (await parseBody(req)) as
      | {
          name?: string;
          description?: string | null;
          goal?: string | null;
          lifecycle_state?: string | null;
          owner_id?: string | null;
          visibility?: string;
        }
      | undefined;
    if (!body) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "body required" }));
      return;
    }
    const update: {
      node_id: string;
      name?: string;
      description?: string | null;
      goal?: string | null;
      lifecycle_state?: string | null;
      owner_id?: string | null;
      visibility?: (typeof NODE_VISIBILITIES)[number];
    } = { node_id: nodeId };
    if (typeof body.name === "string" && body.name.trim().length > 0) {
      update.name = body.name.trim();
    }
    if (body.description !== undefined) {
      update.description = body.description === null ? null : String(body.description);
    }
    if (body.goal !== undefined) {
      update.goal = body.goal === null ? null : String(body.goal);
    }
    if (body.lifecycle_state !== undefined) {
      update.lifecycle_state =
        body.lifecycle_state === null ? null : String(body.lifecycle_state);
    }
    if (body.owner_id !== undefined) {
      update.owner_id = body.owner_id === null ? null : String(body.owner_id);
    }
    if (body.visibility !== undefined) {
      if (!(NODE_VISIBILITIES as readonly string[]).includes(body.visibility)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: `invalid visibility '${body.visibility}'. Valid: ${NODE_VISIBILITIES.join(", ")}`,
          }),
        );
        return;
      }
      update.visibility = body.visibility as (typeof NODE_VISIBILITIES)[number];
    }
    const hasUpdate =
      update.name !== undefined ||
      update.description !== undefined ||
      update.goal !== undefined ||
      update.lifecycle_state !== undefined ||
      update.owner_id !== undefined ||
      update.visibility !== undefined;
    if (!hasUpdate) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no fields to update" }));
      return;
    }
    await updateNodeInternal(getDb(), SOLO_USER, update);
    const node = await loadNodeDetail(getDb(), SOLO_USER, nodeId);
    if (!node) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "node not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(node));
  } catch (err) {
    respondError(res, `${req.method} /nodes/${nodeId}`, err);
  }
}

// Move a node to a different organization. Atomic rebind of the existing
// belongs_to -> organization edge -- see moveNodeToOrganization() for why
// neither disconnect+connect nor connect+disconnect can satisfy the
// org-invariant triggers, and why an in-place UPDATE legally bypasses both.
export async function handleMoveNode(
  req: IncomingMessage,
  res: ServerResponse,
  nodeId: string,
): Promise<void> {
  try {
    const body = (await parseBody(req)) as { new_org_id?: string } | undefined;
    if (!body?.new_org_id || typeof body.new_org_id !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "new_org_id required" }));
      return;
    }
    const result = await moveNodeToOrganization(
      getDb(),
      SOLO_USER,
      nodeId,
      body.new_org_id,
    );
    const node = await loadNodeDetail(getDb(), SOLO_USER, nodeId);
    if (!node) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "node not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...result, node }));
  } catch (err) {
    respondError(res, `${req.method} /nodes/${nodeId}/move`, err);
  }
}

// Create a node. Note: this REST endpoint stays minimal (no
// organization_id, lifecycle_state, etc.) because the frontend's "new
// node" dialog only collects type + name + description. MCP's
// portuni_create_node is the rich path.
export async function handleCreateNode(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const body = (await parseBody(req)) as
      | { type?: string; name?: string; description?: string | null }
      | undefined;
    if (!body?.type || !body.name) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "type and name required" }));
      return;
    }
    if (!(NODE_TYPES as readonly string[]).includes(body.type)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: `invalid type; must be one of ${NODE_TYPES.join(", ")}`,
        }),
      );
      return;
    }
    const db = getDb();
    const id = ulid();
    const now = new Date().toISOString();
    const syncKey = await generateSyncKey(db, body.name.trim());
    await db.execute({
      sql: `INSERT INTO nodes (id, type, name, description, meta, status, visibility, sync_key, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        body.type,
        body.name.trim(),
        body.description ?? null,
        null,
        "active",
        "team",
        syncKey,
        SOLO_USER,
        now,
        now,
      ],
    });
    await logAudit(SOLO_USER, "create_node", "node", id, {
      type: body.type,
      name: body.name,
    });
    const node = await loadNodeDetail(db, SOLO_USER, id);
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify(node));
  } catch (err) {
    respondError(res, `${req.method} /nodes`, err);
  }
}

// Soft-delete a node (status=archived). Edges and audit history stay.
export async function handleDeleteNode(
  req: IncomingMessage,
  res: ServerResponse,
  nodeId: string,
): Promise<void> {
  try {
    const db = getDb();
    const existing = await db.execute({
      sql: "SELECT id FROM nodes WHERE id = ?",
      args: [nodeId],
    });
    if (existing.rows.length === 0) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "node not found" }));
      return;
    }
    await db.execute({
      sql: "UPDATE nodes SET status = 'archived', updated_at = ? WHERE id = ?",
      args: [new Date().toISOString(), nodeId],
    });
    await logAudit(SOLO_USER, "archive_node", "node", nodeId, {});
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ archived: nodeId }));
  } catch (err) {
    respondError(res, `${req.method} /nodes/${nodeId}`, err);
  }
}

// Per-node sync status. Wraps engine.statusScan so the UI can show a class
// (clean/push/pull/conflict/orphan/native) per tracked file. Discovery is
// disabled: untracked files are not listed in the detail pane and discovery
// would do costly remote-list calls.
export async function handleSyncStatus(
  req: IncomingMessage,
  res: ServerResponse,
  nodeId: string,
): Promise<void> {
  try {
    const result = await statusScan(getDb(), {
      userId: SOLO_USER,
      nodeId,
      includeDiscovery: false,
      // DB-only fast path: no fs.stat, no Drive .stat() calls. The UI
      // indicator is allowed to lag a real on-disk change until the next
      // storeFile/pullFile/sync writes file_state.
      fast: true,
    });
    const tagged: Array<{
      file_id: string;
      sync_class: SyncStatusResponse["files"][number]["sync_class"];
      local_hash: string | null;
      remote_hash: string | null;
      last_synced_hash: string | null;
      local_path: string | null;
      remote_name: string | null;
      remote_path: string | null;
    }> = [];
    const push = (
      arr: typeof result.clean,
      cls: SyncStatusResponse["files"][number]["sync_class"],
    ) => {
      for (const e of arr) {
        tagged.push({
          file_id: e.file_id,
          sync_class: cls,
          local_hash: e.local_hash,
          remote_hash: e.remote_hash,
          last_synced_hash: e.last_synced_hash,
          local_path: e.local_path,
          remote_name: e.remote_name,
          remote_path: e.remote_path,
        });
      }
    };
    push(result.clean, "clean");
    push(result.push_candidates, "push");
    push(result.pull_candidates, "pull");
    push(result.conflicts, "conflict");
    push(result.orphan, "orphan");
    push(result.native, "native");
    push(result.deleted_local, "deleted_local");
    const payload: SyncStatusResponse = { files: tagged };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  } catch (err) {
    respondError(res, `${req.method} /nodes/${nodeId}/sync-status`, err);
  }
}

// Browser-openable URL of the node's folder on its routed remote. Returns
// { url, remote_name } when the routed adapter exposes folderUrl AND the
// folder already exists on the remote; { url: null } otherwise (no remote
// routed, backend can't produce a web URL, or node has never been synced).
export async function handleFolderUrl(
  req: IncomingMessage,
  res: ServerResponse,
  nodeId: string,
): Promise<void> {
  try {
    const db = getDb();
    const nodeRow = await db.execute({
      sql: "SELECT id, type, sync_key FROM nodes WHERE id = ?",
      args: [nodeId],
    });
    if (nodeRow.rows.length === 0) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "node not found" }));
      return;
    }
    const n = nodeRow.rows[0];
    const nodeType = n.type as string;
    const nodeSyncKey = n.sync_key as string;
    let orgSyncKey: string | null = null;
    if (nodeType !== "organization") {
      const orgRow = await db.execute({
        sql: `SELECT o.sync_key FROM edges e
              JOIN nodes o ON o.id = e.target_id
              WHERE e.source_id = ? AND e.relation = 'belongs_to'
              LIMIT 1`,
        args: [nodeId],
      });
      if (orgRow.rows.length === 0) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ url: null, reason: "no organization" }));
        return;
      }
      orgSyncKey = orgRow.rows[0].sync_key as string;
    } else {
      orgSyncKey = nodeSyncKey;
    }
    const remoteName = await resolveRemote(db, nodeType, orgSyncKey);
    if (!remoteName) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ url: null, reason: "no remote routed" }));
      return;
    }
    const adapter = await getAdapter(db, remoteName);
    if (!adapter.folderUrl) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          url: null,
          remote_name: remoteName,
          reason: "remote backend has no web URL",
        }),
      );
      return;
    }
    const folderPath = buildNodeRoot({
      orgSyncKey: nodeType === "organization" ? null : orgSyncKey,
      nodeType,
      nodeSyncKey,
    });
    const folderUrl = await adapter.folderUrl(folderPath);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        url: folderUrl,
        remote_name: remoteName,
        ...(folderUrl === null ? { reason: "folder not synced yet" } : {}),
      }),
    );
  } catch (err) {
    respondError(res, `${req.method} /nodes/${nodeId}/folder-url`, err);
  }
}

// Per-node sync trigger. Re-runs statusScan and acts on it: push candidates
// are uploaded via storeFile, pull candidates downloaded via pullFile.
// Conflicts are surfaced but never auto-resolved -- the data-safety default
// ("Portuni never auto-merges") applies. The sequential loop avoids racing
// on the per-device file_state cache.
export async function handleSyncRun(
  req: IncomingMessage,
  res: ServerResponse,
  nodeId: string,
): Promise<void> {
  try {
    const db = getDb();
    const scan = await statusScan(db, {
      userId: SOLO_USER,
      nodeId,
      includeDiscovery: false,
    });
    const result: SyncRunResponse = {
      pushed: [],
      pulled: [],
      conflicts: [],
      errors: [],
      skipped: [],
    };
    for (const e of scan.push_candidates) {
      if (!e.local_path) {
        result.errors.push({
          file_id: e.file_id,
          filename: e.filename,
          error: "no local path -- node has no mirror on this device",
        });
        continue;
      }
      try {
        await storeFile(db, {
          userId: SOLO_USER,
          nodeId: e.node_id,
          localPath: e.local_path,
        });
        result.pushed.push({ file_id: e.file_id, filename: e.filename });
      } catch (err) {
        result.errors.push({
          file_id: e.file_id,
          filename: e.filename,
          error: String(err),
        });
      }
    }
    // pull_candidates: remote moved forward, local at last-synced.
    // deleted_local: local file is gone but remote + last_synced_hash are
    // intact -- pull restores it. Both go through pullFile.
    for (const e of [...scan.pull_candidates, ...scan.deleted_local]) {
      try {
        await pullFile(db, { userId: SOLO_USER, fileId: e.file_id });
        result.pulled.push({ file_id: e.file_id, filename: e.filename });
      } catch (err) {
        result.errors.push({
          file_id: e.file_id,
          filename: e.filename,
          error: String(err),
        });
      }
    }
    for (const e of scan.conflicts) {
      result.conflicts.push({ file_id: e.file_id, filename: e.filename });
    }
    for (const e of [...scan.clean, ...scan.orphan, ...scan.native]) {
      result.skipped.push({
        file_id: e.file_id,
        filename: e.filename,
        sync_class: e.class,
      });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (err) {
    respondError(res, `${req.method} /nodes/${nodeId}/sync`, err);
  }
}

// Batch-save persisted node positions. Called by the frontend after layout
// settles and after the user drops a dragged node. No auth/audit -- positions
// are purely UI state and the MCP tool layer never touches them.
export async function handlePositions(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const body = (await parseBody(req)) as
      | { updates?: Array<{ id?: string; x?: number; y?: number }> }
      | undefined;
    const updates = Array.isArray(body?.updates) ? body!.updates : [];
    if (updates.length === 0) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ updated: 0 }));
      return;
    }
    const db = getDb();
    let updated = 0;
    for (const entry of updates) {
      if (
        !entry ||
        typeof entry.id !== "string" ||
        typeof entry.x !== "number" ||
        typeof entry.y !== "number" ||
        !Number.isFinite(entry.x) ||
        !Number.isFinite(entry.y)
      ) {
        continue;
      }
      const result = await db.execute({
        sql: `UPDATE nodes SET pos_x = ?, pos_y = ?
               WHERE id = ?`,
        args: [entry.x, entry.y, entry.id],
      });
      updated += result.rowsAffected;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ updated }));
  } catch (err) {
    respondError(res, `${req.method} /positions`, err);
  }
}
