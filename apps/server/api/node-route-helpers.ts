// Shared request-handling steps of the node-scoped REST routes (nodes.ts,
// files.ts, access.ts, sessions.ts and the sync agent's agent-router.ts):
// the node-visibility 404, the visible-and-writable prologue, and the
// mirror-create response shape. Each helper writes the response itself on
// refusal and returns null/false so the caller can just `return`.

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getDb, type DbClient, type DbRow } from "../infra/db.js";
import { respondApiError, type RequestIdentity } from "../http/middleware.js";
import { nodeVisibleTo } from "../auth/node-access.js";
import type { MirrorCreateError, CreateMirrorResult } from "../domain/sync/mirror-create.js";

// Request bodies of the file create/move/rename routes, shared by the
// central handlers (files.ts) and the sync agent's device-side ones
// (agent-router.ts) so the two cannot drift apart.
export const fileCreateSchema = z.object({
  filename: z.string().min(1),
  section: z.enum(["wip", "outputs", "resources"]).optional(),
  subpath: z.string().nullish(),
  content: z.string().optional(),
});

export const fileMoveSchema = z.object({
  new_section: z.enum(["wip", "outputs", "resources"]).optional(),
  new_subpath: z.string().nullable().optional(),
  new_filename: z.string().min(1).optional(),
  new_node_id: z.string().optional(),
  confirmed: z.boolean().optional(),
});

export const fileRenameSchema = z.object({ new_filename: z.string().min(1) });

export function respondNodeNotFound(res: ServerResponse, nodeId: string): void {
  respondApiError(res, 404, "NODE_NOT_FOUND", "node not found", { nodeId });
}

// getDb() plus the visibility check every node route starts with: a hidden
// node looks not-found. Returns the db, or null after answering 404.
export async function openVisibleNode(
  res: ServerResponse,
  identity: RequestIdentity,
  nodeId: string,
): Promise<DbClient | null> {
  const db = getDb();
  if (!(await nodeVisibleTo(db, identity, nodeId))) {
    respondNodeNotFound(res, nodeId);
    return null;
  }
  return db;
}

type NodeWriteGuard = (
  req: Pick<IncomingMessage, "headers">,
  res: ServerResponse,
  identity: RequestIdentity,
  nodeId: string,
) => Promise<boolean>;

// openVisibleNode followed by the route's write gate (guardRestNodeWrite or
// guardHeadlessFileWrite), which answers its own refusal.
export async function openWritableNode(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  nodeId: string,
  guard: NodeWriteGuard,
): Promise<DbClient | null> {
  const db = await openVisibleNode(res, identity, nodeId);
  if (!db) return null;
  if (!(await guard(req, res, identity, nodeId))) return null;
  return db;
}

// The node's row when it exists AND is visible to the caller, else null.
// The existence SELECT is not redundant with nodeVisibleTo: an empty access
// chain reads as "unrestricted", so nodeVisibleTo alone answers true for an
// id that does not exist at all. Both checks are required to 404 correctly.
export async function findVisibleNodeRow(
  db: DbClient,
  identity: RequestIdentity,
  nodeId: string,
  columns = "id",
): Promise<DbRow | null> {
  const nodeRow = await db.execute({ sql: `SELECT ${columns} FROM nodes WHERE id = ?`, args: [nodeId] });
  if (nodeRow.rows.length === 0 || !(await nodeVisibleTo(db, identity, nodeId))) return null;
  return nodeRow.rows[0];
}

export function respondMirrorCreateError(res: ServerResponse, err: MirrorCreateError): void {
  const status = err.code === "NODE_NOT_FOUND" ? 404 : err.code === "PATH_TRAVERSAL" ? 400 : 500;
  respondApiError(res, status, err.code, err.message, err.params);
}

export function mirrorCreatePayload(
  result: CreateMirrorResult,
  remoteUrl: string | null,
): Record<string, unknown> {
  return {
    node_id: result.node_id,
    local_path: result.local_path,
    created: result.created,
    remote_url: remoteUrl,
    subdirs: result.subdirs,
    remote_scaffold: result.remote_scaffold,
    scope_config: result.scope_config,
  };
}
