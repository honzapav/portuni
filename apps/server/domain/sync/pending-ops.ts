// Pending file operations: intents for the remote+local+DB mutations
// (moveFile, renameFile, renameFolder, deleteFile, deleteFileRemote) that
// currently execute remote -> local -> DB without a transaction. A row is
// written here before the mutation's first side effect and cleared on
// success; a leftover row (remote step threw) is retried idempotently by
// retryPendingFileOps, called at the start of every sync run
// (remoteSweep, Task 6 step 6) until it completes.
//
// Idempotent by construction: each executor inspects the remote before
// doing anything, and only performs the steps still missing. It never
// destroys data to force an op "complete" -- an ambiguous remote state
// (both source and destination present, or neither) fails the op with
// that message instead of guessing.

import type { Client } from "@libsql/client";
import { ulid } from "ulid";
import { getAdapter } from "./adapter-cache.js";
import { deleteFileState } from "./local-db.js";

export type PendingOp =
  | {
      op: "move";
      from_remote_name: string;
      from_remote_path: string;
      to_remote_name: string;
      to_remote_path: string;
      to_node_id: string;
      filename: string;
    }
  | { op: "delete"; remote_name: string; remote_path: string; filename: string };

export interface PendingOpRow {
  id: string;
  user_id: string;
  node_id: string;
  file_id: string;
  payload: PendingOp;
  attempts: number;
  last_error: string | null;
}

export async function enqueuePendingOp(
  db: Client,
  a: { userId: string; nodeId: string; fileId: string; payload: PendingOp },
): Promise<string> {
  const id = ulid();
  await db.execute({
    sql: `INSERT INTO pending_file_ops (id, user_id, node_id, file_id, payload) VALUES (?, ?, ?, ?, ?)`,
    args: [id, a.userId, a.nodeId, a.fileId, JSON.stringify(a.payload)],
  });
  return id;
}

export async function completePendingOp(db: Client, id: string): Promise<void> {
  await db.execute({ sql: "DELETE FROM pending_file_ops WHERE id = ?", args: [id] });
}

export async function failPendingOp(db: Client, id: string, error: string): Promise<void> {
  await db.execute({
    sql: `UPDATE pending_file_ops SET attempts = attempts + 1, last_error = ?, updated_at = datetime('now') WHERE id = ?`,
    args: [error, id],
  });
}

export async function listPendingOps(db: Client, nodeId: string): Promise<PendingOpRow[]> {
  const r = await db.execute({
    sql: "SELECT id, user_id, node_id, file_id, payload, attempts, last_error FROM pending_file_ops WHERE node_id = ? ORDER BY created_at",
    args: [nodeId],
  });
  return r.rows.map((row) => ({
    id: row.id as string,
    user_id: row.user_id as string,
    node_id: row.node_id as string,
    file_id: row.file_id as string,
    payload: JSON.parse(row.payload as string) as PendingOp,
    attempts: Number(row.attempts),
    last_error: (row.last_error as string | null) ?? null,
  }));
}

// Refuse to touch the remote on a guess. The op's payload captured the
// file's remote binding at enqueue time; by retry time something else may
// have happened -- a manual repair, another device, or (worst case) a
// completely different file adopted/pushed to the exact path this op names.
// Acting on the payload alone could delete or move a DIFFERENT file's remote
// object. Require the CURRENT `files` row for this op's file_id to still
// point at one of the paths the op describes (the untouched starting state,
// or -- for a move -- the already-applied destination, which is what makes
// the retry idempotent). If the row is gone, only proceed when no other row
// has since claimed any of those paths; otherwise fail with an ambiguity
// message instead of guessing, exactly like the both-present branch below.
async function assertRecordStillMatches(
  db: Client,
  row: PendingOpRow,
  candidates: Array<{ remote_name: string; remote_path: string }>,
): Promise<void> {
  const cur = await db.execute({
    sql: "SELECT remote_name, remote_path FROM files WHERE id = ?",
    args: [row.file_id],
  });
  if (cur.rows.length > 0) {
    const curName = cur.rows[0].remote_name as string | null;
    const curPath = cur.rows[0].remote_path as string | null;
    const matches = candidates.some(
      (c) => c.remote_name === curName && c.remote_path === curPath,
    );
    if (!matches) {
      throw new Error(
        `file ${row.file_id} record now points at ${curName}:${curPath}, which does not match the pending op -- refusing to guess`,
      );
    }
    return;
  }
  for (const c of candidates) {
    const claim = await db.execute({
      sql: "SELECT id FROM files WHERE remote_name = ? AND remote_path = ?",
      args: [c.remote_name, c.remote_path],
    });
    if (claim.rows.length > 0) {
      throw new Error(
        `file ${row.file_id} record is gone and ${c.remote_name}:${c.remote_path} is now claimed by a different file (${claim.rows[0].id as string}) -- refusing to guess`,
      );
    }
  }
}

// Idempotent executors. Each one looks at the remote first and only does the
// steps that are still missing, then fixes the record and audits the outcome
// with the same rows the first-time path writes (tombstones included).
async function runMove(
  db: Client,
  row: PendingOpRow,
  p: Extract<PendingOp, { op: "move" }>,
): Promise<void> {
  await assertRecordStillMatches(db, row, [
    { remote_name: p.from_remote_name, remote_path: p.from_remote_path },
    { remote_name: p.to_remote_name, remote_path: p.to_remote_path },
  ]);
  const src = await getAdapter(db, p.from_remote_name);
  const dst = p.to_remote_name === p.from_remote_name ? src : await getAdapter(db, p.to_remote_name);
  const atFrom = await src.stat(p.from_remote_path);
  const atTo = await dst.stat(p.to_remote_path);
  if (atFrom && atTo) {
    throw new Error(`both ${p.from_remote_path} and ${p.to_remote_path} exist on the remote`);
  }
  if (!atFrom && !atTo) {
    throw new Error(`neither ${p.from_remote_path} nor ${p.to_remote_path} exists on the remote`);
  }
  if (atFrom && !atTo) {
    if (src === dst) {
      await src.rename(p.from_remote_path, p.to_remote_path);
    } else {
      await dst.put(p.to_remote_path, await src.get(p.from_remote_path));
      await src.delete(p.from_remote_path);
    }
  }
  const now = new Date().toISOString();
  await db.execute({
    sql: `UPDATE files SET remote_name = ?, remote_path = ?, node_id = ?, filename = ?, updated_at = ? WHERE id = ?`,
    args: [p.to_remote_name, p.to_remote_path, p.to_node_id, p.filename, now, row.file_id],
  });
  await db.execute({
    sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
          VALUES (?, ?, 'sync_move', 'file', ?, ?, ?)`,
    args: [
      ulid(),
      row.user_id,
      row.file_id,
      JSON.stringify({
        node_id: row.node_id,
        old_remote_path: p.from_remote_path,
        repaired: true,
        old: { remote_name: p.from_remote_name, remote_path: p.from_remote_path },
        new: { remote_name: p.to_remote_name, remote_path: p.to_remote_path },
      }),
      now,
    ],
  });
}

async function runDelete(
  db: Client,
  row: PendingOpRow,
  p: Extract<PendingOp, { op: "delete" }>,
): Promise<void> {
  await assertRecordStillMatches(db, row, [
    { remote_name: p.remote_name, remote_path: p.remote_path },
  ]);
  const adapter = await getAdapter(db, p.remote_name);
  if ((await adapter.stat(p.remote_path)) !== null) await adapter.delete(p.remote_path);
  await db.execute({ sql: "DELETE FROM files WHERE id = ?", args: [row.file_id] });
  await deleteFileState(row.file_id).catch(() => undefined);
  await db.execute({
    sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
          VALUES (?, ?, 'sync_delete', 'file', ?, ?, ?)`,
    args: [
      ulid(),
      row.user_id,
      row.file_id,
      JSON.stringify({
        mode: "complete",
        node_id: row.node_id,
        remote_name: p.remote_name,
        remote_path: p.remote_path,
        filename: p.filename,
        repaired: true,
      }),
      new Date().toISOString(),
    ],
  });
}

export interface RetryResult {
  repaired: Array<{ file_id: string; op: PendingOp["op"]; filename: string }>;
  pending_repairs: Array<{
    file_id: string;
    op: PendingOp["op"];
    attempts: number;
    last_error: string | null;
  }>;
}

export async function retryPendingFileOps(
  db: Client,
  a: { userId: string; nodeId: string },
): Promise<RetryResult> {
  const out: RetryResult = { repaired: [], pending_repairs: [] };
  for (const row of await listPendingOps(db, a.nodeId)) {
    try {
      if (row.payload.op === "move") await runMove(db, row, row.payload);
      else await runDelete(db, row, row.payload);
      await completePendingOp(db, row.id);
      out.repaired.push({ file_id: row.file_id, op: row.payload.op, filename: row.payload.filename });
    } catch (e) {
      const error = (e as Error).message;
      await failPendingOp(db, row.id, error);
      out.pending_repairs.push({
        file_id: row.file_id,
        op: row.payload.op,
        attempts: row.attempts + 1,
        last_error: error,
      });
    }
  }
  return out;
}
