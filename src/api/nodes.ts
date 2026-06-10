// REST endpoints for /nodes (CRUD), /nodes/:id/sync-status,
// /nodes/:id/folder-url, /nodes/:id/sync, /nodes/:id/move, /positions.

import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../infra/db.js";
import { logAudit } from "../infra/audit.js";
import {
  NODE_TYPES,
  NODE_VISIBILITIES,
  SOLO_USER,
} from "../infra/schema.js";
import { buildNodeRoot } from "../domain/sync/remote-path.js";
import { resolveRemote } from "../domain/sync/routing.js";
import { getAdapter } from "../domain/sync/adapter-cache.js";
import { statusScan, storeFile, pullFile } from "../domain/sync/engine.js";
import { listUntrackedLocal } from "../domain/sync/discover-local.js";
import { mimeFor } from "../domain/sync/engine.js";
import { createNodeInternal, updateNodeInternal } from "../domain/nodes.js";
import { moveNodeToOrganization } from "../domain/edges.js";
import { loadNodeDetail } from "../domain/queries/node-detail.js";
import {
  createMirrorForNode,
  MirrorCreateError,
} from "../domain/sync/mirror-create.js";
import {
  buildSeatbeltProfile,
  resolveSandboxScopeForNode,
} from "../domain/sandbox-profile.js";
import type { SyncStatusResponse, SyncRunResponse, UntrackedFile } from "../shared/api-types.js";
import { parseBody, parseJsonBody, respondError , respondJson} from "../http/middleware.js";
import { z } from "zod";

export async function handleGetNode(
  req: IncomingMessage,
  res: ServerResponse,
  nodeId: string,
): Promise<void> {
  if (!nodeId) {
    respondJson(res, 400, { error: "node id required" });
    return;
  }
  try {
    const node = await loadNodeDetail(getDb(), SOLO_USER, nodeId);
    if (!node) {
      respondJson(res, 404, { error: "node not found" });
      return;
    }
    respondJson(res, 200, node);
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
      respondJson(res, 400, { error: "body required" });
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
        respondJson(res, 400, {
          error: `invalid visibility '${body.visibility}'. Valid: ${NODE_VISIBILITIES.join(", ")}`,
        });
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
      respondJson(res, 400, { error: "no fields to update" });
      return;
    }
    await updateNodeInternal(getDb(), SOLO_USER, update);
    const node = await loadNodeDetail(getDb(), SOLO_USER, nodeId);
    if (!node) {
      respondJson(res, 404, { error: "node not found" });
      return;
    }
    respondJson(res, 200, node);
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
      respondJson(res, 400, { error: "new_org_id required" });
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
      respondJson(res, 404, { error: "node not found" });
      return;
    }
    respondJson(res, 200, { ...result, node });
  } catch (err) {
    respondError(res, `${req.method} /nodes/${nodeId}/move`, err);
  }
}

const CreateNodeBody = z
  .object({
    type: z.enum(NODE_TYPES),
    name: z.string().trim().min(1),
    description: z.string().nullable().optional(),
    organization_id: z.string().optional(),
    goal: z.string().nullable().optional(),
    lifecycle_state: z.string().nullable().optional(),
  })
  .refine(
    (b) => b.type === "organization" || typeof b.organization_id === "string",
    { message: "organization_id is required for non-organization types", path: ["organization_id"] },
  );

// Create a node. Routes through createNodeInternal so the org-invariant
// (every non-organization node belongs to exactly one organization via
// belongs_to) is enforced atomically — same as the MCP path.
export async function handleCreateNode(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await parseJsonBody(req, res, CreateNodeBody);
  if (!body) return;
  try {
    const id = await createNodeInternal(getDb(), SOLO_USER, {
      type: body.type,
      name: body.name,
      description: body.description ?? undefined,
      organization_id: body.organization_id,
      goal: body.goal ?? undefined,
      lifecycle_state: body.lifecycle_state ?? undefined,
    });
    const node = await loadNodeDetail(getDb(), SOLO_USER, id);
    respondJson(res, 201, node);
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
      respondJson(res, 404, { error: "node not found" });
      return;
    }
    await db.execute({
      sql: "UPDATE nodes SET status = 'archived', updated_at = ? WHERE id = ?",
      args: [new Date().toISOString(), nodeId],
    });
    await logAudit(SOLO_USER, "archive_node", "node", nodeId, {});
    respondJson(res, 200, { archived: nodeId });
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
    const untrackedRaw = await listUntrackedLocal(getDb(), { userId: SOLO_USER, nodeId });
    const untracked: UntrackedFile[] = untrackedRaw.map((u) => ({
      relative_path: u.subpath
        ? `${u.section}/${u.subpath}/${u.filename}`
        : `${u.section}/${u.filename}`,
      section: u.section,
      subpath: u.subpath,
      filename: u.filename,
      local_path: u.local_path,
      mime_type: mimeFor(u.filename),
    }));
    const payload: SyncStatusResponse = { files: tagged, untracked };
    respondJson(res, 200, payload);
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
      respondJson(res, 404, { error: "node not found" });
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
        respondJson(res, 200, { url: null, reason: "no organization" });
        return;
      }
      orgSyncKey = orgRow.rows[0].sync_key as string;
    } else {
      orgSyncKey = nodeSyncKey;
    }
    const remoteName = await resolveRemote(db, nodeType, orgSyncKey);
    if (!remoteName) {
      respondJson(res, 200, { url: null, reason: "no remote routed" });
      return;
    }
    const adapter = await getAdapter(db, remoteName);
    if (!adapter.folderUrl) {
      respondJson(res, 200, {
        url: null,
        remote_name: remoteName,
        reason: "remote backend has no web URL",
      });
      return;
    }
    const folderPath = buildNodeRoot({
      orgSyncKey: nodeType === "organization" ? null : orgSyncKey,
      nodeType,
      nodeSyncKey,
    });
    const folderUrl = await adapter.folderUrl(folderPath);
    respondJson(res, 200, {
      url: folderUrl,
      remote_name: remoteName,
      ...(folderUrl === null ? { reason: "folder not synced yet" } : {}),
    });
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
      adopted: [],
      conflicts: [],
      deleted_local: [],
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
    // pull_candidates: remote moved forward, local at last-synced -- safe
    // to download. deleted_local is NOT pulled: the local deletion may be
    // intentional, and auto-restoring made it impossible to ever remove a
    // file from the mirror. It is reported for an explicit decision
    // (portuni_pull restores, portuni_delete_file removes everywhere).
    for (const e of scan.pull_candidates) {
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
    for (const e of scan.deleted_local) {
      result.deleted_local.push({ file_id: e.file_id, filename: e.filename });
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
    // Deterministic registration: adopt any file the agent wrote to the
    // mirror but never registered. Each storeFile registers + pushes.
    const untracked = await listUntrackedLocal(db, { userId: SOLO_USER, nodeId });
    for (const u of untracked) {
      try {
        const sr = await storeFile(db, {
          userId: SOLO_USER,
          nodeId: u.node_id,
          localPath: u.local_path,
        });
        result.adopted.push({ file_id: sr.file_id, filename: u.filename });
      } catch (err) {
        result.errors.push({ file_id: "", filename: u.filename, error: String(err) });
      }
    }
    respondJson(res, 200, result);
  } catch (err) {
    respondError(res, `${req.method} /nodes/${nodeId}/sync`, err);
  }
}

// Idempotent "make me a working folder for this node" entry point. Wraps
// the same domain function the MCP `portuni_mirror` tool calls. New mirror
// returns 201; existing one returns 200 with the current path. The UI
// hits this from the create-node modal and the "Spustit Claude" launcher.
export async function handleCreateNodeMirror(
  req: IncomingMessage,
  res: ServerResponse,
  nodeId: string,
): Promise<void> {
  if (!nodeId) {
    respondJson(res, 400, { error: "node id required" });
    return;
  }
  try {
    const result = await createMirrorForNode(getDb(), SOLO_USER, { nodeId });
    // Best-effort folder URL on the routed remote — not part of the
    // happy-path mirror creation. We don't await any heavy listing here;
    // folderUrl returns null when the folder hasn't been synced yet.
    let remoteUrl: string | null = null;
    try {
      remoteUrl = await resolveRemoteFolderUrl(getDb(), nodeId);
    } catch {
      remoteUrl = null;
    }
    respondJson(res, result.created ? 201 : 200, {
      node_id: result.node_id,
      local_path: result.local_path,
      created: result.created,
      remote_url: remoteUrl,
      subdirs: result.subdirs,
      remote_scaffold: result.remote_scaffold,
      scope_config: result.scope_config,
    });
  } catch (err) {
    if (err instanceof MirrorCreateError) {
      const status =
        err.code === "NODE_NOT_FOUND"
          ? 404
          : err.code === "PATH_TRAVERSAL"
            ? 400
            : 500;
      respondJson(res, status, { error: err.message, code: err.code });
      return;
    }
    respondError(res, `${req.method} /nodes/${nodeId}/mirror`, err);
  }
}

// Disk-scope profile for spawning an agent terminal inside the node's
// mirror. The desktop app fetches this right before pty_spawn and wraps
// the shell in `sandbox-exec -f <profile>`, so any agent binary gets the
// same boundary the MCP session scope enforces on the graph: home mirror
// read+write, depth-1 neighbor mirrors read-only, rest of PORTUNI_ROOT
// denied by the kernel. 409 NO_MIRROR mirrors the create-mirror-first
// flow the app already follows.
export async function handleNodeSandboxProfile(
  req: IncomingMessage,
  res: ServerResponse,
  nodeId: string,
): Promise<void> {
  if (!nodeId) {
    respondJson(res, 400, { error: "node id required" });
    return;
  }
  try {
    const db = getDb();
    const exists = await db.execute({
      sql: "SELECT 1 FROM nodes WHERE id = ?",
      args: [nodeId],
    });
    if (exists.rows.length === 0) {
      respondJson(res, 404, { error: `node ${nodeId} not found` });
      return;
    }
    const scope = await resolveSandboxScopeForNode(db, SOLO_USER, nodeId);
    if (!scope) {
      respondJson(res, 409, {
        error: `node ${nodeId} has no local mirror on this device`,
        code: "NO_MIRROR",
      });
      return;
    }
    respondJson(res, 200, {
      profile: buildSeatbeltProfile(scope),
      portuni_root: scope.portuniRoot,
      home_mirror: scope.homeMirror,
      neighbor_mirrors: scope.neighborMirrors,
    });
  } catch (err) {
    respondError(res, `${req.method} /nodes/${nodeId}/sandbox-profile`, err);
  }
}

// Helper used by handleCreateNodeMirror — same shape as handleFolderUrl
// above but returns just the URL or null without writing the response.
async function resolveRemoteFolderUrl(
  db: ReturnType<typeof getDb>,
  nodeId: string,
): Promise<string | null> {
  const nodeRow = await db.execute({
    sql: "SELECT id, type, sync_key FROM nodes WHERE id = ?",
    args: [nodeId],
  });
  if (nodeRow.rows.length === 0) return null;
  const n = nodeRow.rows[0];
  const nodeType = n.type as string;
  const nodeSyncKey = n.sync_key as string;
  let orgSyncKey: string | null = null;
  if (nodeType !== "organization") {
    const orgRow = await db.execute({
      sql: `SELECT o.sync_key FROM edges e
            JOIN nodes o ON o.id = e.target_id
            WHERE e.source_id = ? AND e.relation = 'belongs_to' LIMIT 1`,
      args: [nodeId],
    });
    if (orgRow.rows.length === 0) return null;
    orgSyncKey = orgRow.rows[0].sync_key as string;
  } else {
    orgSyncKey = nodeSyncKey;
  }
  const remoteName = await resolveRemote(db, nodeType, orgSyncKey);
  if (!remoteName) return null;
  const adapter = await getAdapter(db, remoteName);
  if (!adapter.folderUrl) return null;
  const folderPath = buildNodeRoot({
    orgSyncKey: nodeType === "organization" ? null : orgSyncKey,
    nodeType,
    nodeSyncKey,
  });
  return adapter.folderUrl(folderPath);
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
      respondJson(res, 200, { updated: 0 });
      return;
    }
    const db = getDb();
    // One batch instead of a round trip per node -- this fires after every
    // drag/layout settle, often with dozens of nodes.
    const valid = updates.filter(
      (entry): entry is { id: string; x: number; y: number } =>
        !!entry &&
        typeof entry.id === "string" &&
        typeof entry.x === "number" &&
        typeof entry.y === "number" &&
        Number.isFinite(entry.x) &&
        Number.isFinite(entry.y),
    );
    let updated = 0;
    if (valid.length > 0) {
      const results = await db.batch(
        valid.map((entry) => ({
          sql: "UPDATE nodes SET pos_x = ?, pos_y = ? WHERE id = ?",
          args: [entry.x, entry.y, entry.id],
        })),
        "write",
      );
      for (const r of results) updated += r.rowsAffected;
    }
    respondJson(res, 200, { updated });
  } catch (err) {
    respondError(res, `${req.method} /positions`, err);
  }
}
