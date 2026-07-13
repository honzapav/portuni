import type { Client } from "@libsql/client";
import {
  getLocalMirror,
  upsertLocalMirror,
  deleteLocalMirror,
  listLocalMirrors,
  type LocalMirrorRow,
} from "./local-db.js";

// Change hub: the mirror watcher subscribes so mirrors registered after it
// started still get watched + backfilled (same-process only, which is the
// invariant anyway -- exactly one watcher owns a machine's mirrors).
type MirrorRegistryListener = () => void;
const listeners = new Set<MirrorRegistryListener>();

export function onMirrorRegistryChange(listener: MirrorRegistryListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyChange(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      /* a broken listener must not fail the registry write */
    }
  }
}

export async function registerMirror(
  userId: string,
  nodeId: string,
  localPath: string,
): Promise<void> {
  await upsertLocalMirror({ user_id: userId, node_id: nodeId, local_path: localPath });
  notifyChange();
}

export async function getMirrorPath(userId: string, nodeId: string): Promise<string | null> {
  const r = await getLocalMirror(userId, nodeId);
  return r?.local_path ?? null;
}

export async function unregisterMirror(userId: string, nodeId: string): Promise<void> {
  await deleteLocalMirror(userId, nodeId);
  notifyChange();
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
  if (removed.length > 0) notifyChange();
  return { checked: rows.length, removed };
}
