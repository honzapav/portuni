import { createClient, type Client } from "@libsql/client";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface FileStateRow {
  file_id: string;
  last_synced_hash: string;
  last_synced_at: string;
  cached_local_hash: string | null;
  cached_mtime: number | null;
  cached_size: number | null;
}

export interface RemoteStatRow {
  file_id: string;
  remote_hash: string | null;
  remote_modified_at: string | null;
  fetched_at: string;
}

export interface LocalMirrorRow {
  user_id: string;
  node_id: string;
  local_path: string;
  registered_at: string;
}

let cached: Client | null = null;
let cachedPath: string | null = null;

function workspaceRoot(): string {
  const root = process.env.PORTUNI_WORKSPACE_ROOT;
  if (!root) throw new Error("PORTUNI_WORKSPACE_ROOT must be set for local sync.db");
  return root;
}

async function ensureSchema(db: Client): Promise<void> {
  await db.execute(`CREATE TABLE IF NOT EXISTS file_state (
    file_id TEXT PRIMARY KEY,
    last_synced_hash TEXT NOT NULL,
    last_synced_at DATETIME NOT NULL,
    cached_local_hash TEXT,
    cached_mtime INTEGER,
    cached_size INTEGER
  )`);
  await db.execute(
    "CREATE INDEX IF NOT EXISTS idx_file_state_cached_hash ON file_state(cached_local_hash)",
  );
  await db.execute(`CREATE TABLE IF NOT EXISTS remote_stat_cache (
    file_id TEXT PRIMARY KEY,
    remote_hash TEXT,
    remote_modified_at DATETIME,
    fetched_at DATETIME NOT NULL
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS local_mirrors (
    user_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    local_path TEXT NOT NULL,
    registered_at DATETIME NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, node_id)
  )`);
}

export async function getLocalDb(): Promise<Client> {
  const dir = join(workspaceRoot(), ".portuni");
  const path = join(dir, "sync.db");
  if (cached && cachedPath === path) return cached;
  await mkdir(dir, { recursive: true });
  const db = createClient({ url: `file:${path}` });
  await ensureSchema(db);
  cached = db;
  cachedPath = path;
  return db;
}

export function resetLocalDbForTests(): void {
  cached = null;
  cachedPath = null;
}

// file_state CRUD
export async function upsertFileState(
  row: Omit<FileStateRow, "last_synced_at"> & { last_synced_at?: string },
): Promise<void> {
  const db = await getLocalDb();
  const ts = row.last_synced_at ?? new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO file_state (file_id, last_synced_hash, last_synced_at, cached_local_hash, cached_mtime, cached_size)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(file_id) DO UPDATE SET
            last_synced_hash = excluded.last_synced_hash,
            last_synced_at = excluded.last_synced_at,
            cached_local_hash = excluded.cached_local_hash,
            cached_mtime = excluded.cached_mtime,
            cached_size = excluded.cached_size`,
    args: [
      row.file_id,
      row.last_synced_hash,
      ts,
      row.cached_local_hash ?? null,
      row.cached_mtime ?? null,
      row.cached_size ?? null,
    ],
  });
}

export async function getFileState(fileId: string): Promise<FileStateRow | null> {
  const db = await getLocalDb();
  const r = await db.execute({
    sql: "SELECT * FROM file_state WHERE file_id = ?",
    args: [fileId],
  });
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    file_id: row.file_id as string,
    last_synced_hash: row.last_synced_hash as string,
    last_synced_at: row.last_synced_at as string,
    cached_local_hash: (row.cached_local_hash as string | null) ?? null,
    cached_mtime: row.cached_mtime === null ? null : Number(row.cached_mtime),
    cached_size: row.cached_size === null ? null : Number(row.cached_size),
  };
}

export async function deleteFileState(fileId: string): Promise<void> {
  const db = await getLocalDb();
  await db.execute({ sql: "DELETE FROM file_state WHERE file_id = ?", args: [fileId] });
}

// remote_stat_cache CRUD
export async function upsertRemoteStat(
  row: Omit<RemoteStatRow, "fetched_at"> & { fetched_at?: string },
): Promise<void> {
  const db = await getLocalDb();
  const ts = row.fetched_at ?? new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO remote_stat_cache (file_id, remote_hash, remote_modified_at, fetched_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(file_id) DO UPDATE SET
            remote_hash = excluded.remote_hash,
            remote_modified_at = excluded.remote_modified_at,
            fetched_at = excluded.fetched_at`,
    args: [row.file_id, row.remote_hash ?? null, row.remote_modified_at ?? null, ts],
  });
}

export async function getRemoteStat(fileId: string): Promise<RemoteStatRow | null> {
  const db = await getLocalDb();
  const r = await db.execute({
    sql: "SELECT * FROM remote_stat_cache WHERE file_id = ?",
    args: [fileId],
  });
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    file_id: row.file_id as string,
    remote_hash: (row.remote_hash as string | null) ?? null,
    remote_modified_at: (row.remote_modified_at as string | null) ?? null,
    fetched_at: row.fetched_at as string,
  };
}

// local_mirrors CRUD
export async function upsertLocalMirror(
  row: Omit<LocalMirrorRow, "registered_at"> & { registered_at?: string },
): Promise<void> {
  const db = await getLocalDb();
  await db.execute({
    sql: `INSERT INTO local_mirrors (user_id, node_id, local_path, registered_at)
          VALUES (?, ?, ?, COALESCE(?, datetime('now')))
          ON CONFLICT(user_id, node_id) DO UPDATE SET
            local_path = excluded.local_path,
            registered_at = excluded.registered_at`,
    args: [row.user_id, row.node_id, row.local_path, row.registered_at ?? null],
  });
}

export async function getLocalMirror(
  userId: string,
  nodeId: string,
): Promise<LocalMirrorRow | null> {
  const db = await getLocalDb();
  const r = await db.execute({
    sql: "SELECT * FROM local_mirrors WHERE user_id = ? AND node_id = ?",
    args: [userId, nodeId],
  });
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    user_id: row.user_id as string,
    node_id: row.node_id as string,
    local_path: row.local_path as string,
    registered_at: row.registered_at as string,
  };
}

export async function deleteLocalMirror(userId: string, nodeId: string): Promise<void> {
  const db = await getLocalDb();
  await db.execute({
    sql: "DELETE FROM local_mirrors WHERE user_id = ? AND node_id = ?",
    args: [userId, nodeId],
  });
}

export async function listLocalMirrors(userId: string): Promise<LocalMirrorRow[]> {
  const db = await getLocalDb();
  const r = await db.execute({
    sql: "SELECT * FROM local_mirrors WHERE user_id = ? ORDER BY registered_at DESC",
    args: [userId],
  });
  return r.rows.map((row) => ({
    user_id: row.user_id as string,
    node_id: row.node_id as string,
    local_path: row.local_path as string,
    registered_at: row.registered_at as string,
  }));
}
