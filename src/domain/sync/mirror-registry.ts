import type { Client } from "@libsql/client";
import {
  getLocalMirror,
  upsertLocalMirror,
  deleteLocalMirror,
  listLocalMirrors,
  type LocalMirrorRow,
} from "./local-db.js";

export async function registerMirror(
  userId: string,
  nodeId: string,
  localPath: string,
): Promise<void> {
  await upsertLocalMirror({ user_id: userId, node_id: nodeId, local_path: localPath });
}

export async function getMirrorPath(userId: string, nodeId: string): Promise<string | null> {
  const r = await getLocalMirror(userId, nodeId);
  return r?.local_path ?? null;
}

export async function unregisterMirror(userId: string, nodeId: string): Promise<void> {
  await deleteLocalMirror(userId, nodeId);
}

export async function listUserMirrors(userId: string): Promise<LocalMirrorRow[]> {
  return listLocalMirrors(userId);
}

export interface StaleCleanReport {
  checked: number;
  removed: string[];
}

export async function tryCleanStaleMirrors(
  shared: Client,
  userId: string,
): Promise<StaleCleanReport> {
  const rows = await listLocalMirrors(userId);
  const removed: string[] = [];
  for (const m of rows) {
    const r = await shared.execute({
      sql: "SELECT 1 FROM nodes WHERE id = ? LIMIT 1",
      args: [m.node_id],
    });
    if (r.rows.length === 0) {
      await deleteLocalMirror(userId, m.node_id);
      removed.push(m.node_id);
    }
  }
  return { checked: rows.length, removed };
}
