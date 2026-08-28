// Remote sweep: reconcile the node's `files` rows against what the remote
// actually holds. Runs only inside a deliberate sync run (server side, where
// the remote credentials live).
//   - a pushed record whose object is gone from the remote -> record deleted
//     + sync_delete_remote tombstone (devices clean up byte-identical copies;
//     edited copies come back as new_local and get pushed again)
//   - a remote file under wip/outputs/resources that no record tracks ->
//     adopted (devices pull it in the same run)
import type { Client } from "@libsql/client";
import { ulid } from "ulid";
import { getAdapter } from "./adapter-cache.js";
import { resolveRemote } from "./routing.js";
import { resolveNodeInfo } from "./node-info.js";
import { buildNodeRoot } from "./remote-path.js";
import { adoptFiles } from "./engine-mutations.js";
import { sha256Buffer } from "./hash.js";
import type { FileRef } from "./types.js";
import { retryPendingFileOps, type RetryResult } from "./pending-ops.js";

export interface RemoteSweepArgs { userId: string; nodeId: string }
export interface RemoteSweepFile { file_id: string; filename: string; remote_path: string }
export interface RemoteSweepResult {
  adopted: RemoteSweepFile[];
  deleted_on_remote: RemoteSweepFile[];
  errors: Array<{ remote_path: string; error: string }>;
  repaired: RetryResult["repaired"];
  pending_repairs: RetryResult["pending_repairs"];
}

const SECTIONS = new Set(["wip", "outputs", "resources"]);

// Files at any depth under <nodeRoot>/<section>/ qualify for adoption; a
// path segment starting with "." is skipped.
// An organization's root spans its children's subtrees; those paths have a
// type-plural segment (projects/...) where the section would be and are
// skipped here -- the child node's own sweep handles them.
function adoptableSection(nodeRoot: string, remotePath: string): "wip" | "outputs" | "resources" | null {
  const rel = remotePath.startsWith(`${nodeRoot}/`) ? remotePath.slice(nodeRoot.length + 1) : null;
  if (!rel) return null;
  const [section, ...rest] = rel.split("/");
  if (!SECTIONS.has(section) || rest.length === 0) return null;
  if (rest.some((seg) => seg.startsWith("."))) return null;
  return section as "wip" | "outputs" | "resources";
}

export async function remoteSweep(db: Client, a: RemoteSweepArgs): Promise<RemoteSweepResult> {
  const out: RemoteSweepResult = {
    adopted: [],
    deleted_on_remote: [],
    errors: [],
    repaired: [],
    pending_repairs: [],
  };
  // Retry any leftover pending file ops (Task 6) before reconciling the
  // remote listing -- a still-half-moved/deleted file should be fixed up
  // first, otherwise the sweep below could misclassify it.
  const retry = await retryPendingFileOps(db, a);
  out.repaired.push(...retry.repaired);
  out.pending_repairs.push(...retry.pending_repairs);
  const info = await resolveNodeInfo(db, a.nodeId);
  const remoteName = await resolveRemote(db, info.nodeType, info.orgSyncKey);
  if (!remoteName) return out;
  const adapter = await getAdapter(db, remoteName);
  const nodeRoot = buildNodeRoot(info);

  let listing: FileRef[];
  try {
    listing = await adapter.list(nodeRoot);
  } catch (e) {
    out.errors.push({ remote_path: nodeRoot, error: `list failed: ${(e as Error).message}` });
    return out;
  }
  const present = new Map<string, FileRef>();
  for (const f of listing) present.set(f.path.normalize("NFC"), f);

  // 1. Deleted on the remote. Only rows that once had a remote object
  // (pushed or native) -- a never-pushed registration has nothing to lose.
  const rows = await db.execute({
    sql: `SELECT id, filename, remote_path, current_remote_hash, is_native_format
          FROM files WHERE node_id = ? AND remote_name = ? AND remote_path IS NOT NULL`,
    args: [a.nodeId, remoteName],
  });
  const missingCandidates = rows.rows.filter((r) => {
    const hadObject = (r.current_remote_hash as string | null) !== null || Number(r.is_native_format) === 1;
    return hadObject && !present.has((r.remote_path as string).normalize("NFC"));
  });

  // Some backends (the fs/OpenDAL adapter included) swallow an unreachable
  // root into an empty listing and a null stat instead of throwing -- so an
  // empty `present` map is not by itself proof that files are gone. Before
  // trusting any missing candidate, confirm the node root itself is still
  // visible on the remote. If it isn't, we cannot tell "deleted" from
  // "can't see the remote right now" -- report an error and touch nothing.
  if (missingCandidates.length > 0) {
    let rootSeen: boolean;
    try {
      rootSeen = (await adapter.stat(nodeRoot)) !== null;
    } catch {
      rootSeen = false;
    }
    if (!rootSeen) {
      out.errors.push({ remote_path: nodeRoot, error: "node root not reachable on remote" });
      return out;
    }
  }

  for (const r of missingCandidates) {
    const remotePath = r.remote_path as string;
    // A listing can lag a fresh upload; confirm the object is really gone
    // before destroying the record.
    let stat: FileRef | null;
    try {
      stat = await adapter.stat(remotePath);
    } catch (e) {
      out.errors.push({ remote_path: remotePath, error: `stat failed: ${(e as Error).message}` });
      continue;
    }
    if (stat !== null) continue;
    const now = new Date().toISOString();
    await db.execute({ sql: "DELETE FROM files WHERE id = ?", args: [r.id as string] });
    await db.execute({
      sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
            VALUES (?, ?, 'sync_delete_remote', 'file', ?, ?, ?)`,
      args: [
        ulid(),
        a.userId,
        r.id as string,
        JSON.stringify({
          node_id: a.nodeId,
          remote_name: remoteName,
          remote_path: remotePath,
          filename: r.filename as string,
          mode: "complete",
          reason: "remote_sweep",
          hash: (r.current_remote_hash as string | null) ?? null,
        }),
        now,
      ],
    });
    out.deleted_on_remote.push({ file_id: r.id as string, filename: r.filename as string, remote_path: remotePath });
  }

  // 2. New on the remote. Known = any record anywhere under this root (an
  // org mirror lists its children's files too).
  const likePrefix = nodeRoot.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  const known = await db.execute({
    sql: "SELECT remote_path FROM files WHERE remote_name = ? AND remote_path LIKE ? ESCAPE '\\'",
    args: [remoteName, `${likePrefix}/%`],
  });
  const knownSet = new Set(known.rows.map((r) => (r.remote_path as string).normalize("NFC")));
  const bySection = new Map<"wip" | "output", string[]>();
  // adoptFiles echoes back whatever path string it was given as
  // `remote_path`, so this doubles as a lookup from that path back to the
  // FileRef the listing produced for it -- needed below to tell "this
  // backend never reports hashes" (fs/OpenDAL) from "this file structurally
  // has no content hash" (a Drive native Doc/Sheet/Slide).
  const refsByPath = new Map<string, FileRef>();
  for (const [path, ref] of present) {
    if (knownSet.has(path)) continue;
    const section = adoptableSection(nodeRoot, ref.path);
    if (!section) continue;
    const status = section === "outputs" ? "output" : "wip";
    if (!bySection.has(status)) bySection.set(status, []);
    bySection.get(status)!.push(ref.path);
    refsByPath.set(ref.path, ref);
  }
  for (const [status, paths] of bySection) {
    const res = await adoptFiles(db, { userId: a.userId, nodeId: a.nodeId, paths, status });
    for (const f of res.adopted) {
      out.adopted.push({ file_id: f.file_id, filename: f.filename, remote_path: f.remote_path });
      // adoptFiles records whatever hash the backend's stat() reports, which
      // for backends without a content-addressable stat (e.g. the fs/OpenDAL
      // adapter) is null. Backfill it here by hashing the content directly,
      // so an adopted record carries the same kind of hash storeFile does --
      // otherwise every later statusScan comparison against it is starved.
      // Native-format remote objects (Drive Docs/Sheets/Slides) are the
      // structural exception: they have no bytes `get()` can fetch with
      // alt=media, `hash: null` is by design, and there is nothing to
      // backfill -- AdoptFilesResult doesn't carry is_native_format, so look
      // the listing's FileRef back up by path instead of guessing from the
      // hash alone.
      const isNative = refsByPath.get(f.remote_path)?.is_native_format === true;
      if (!f.hash && !isNative) {
        try {
          const content = await adapter.get(f.remote_path);
          await db.execute({
            sql: "UPDATE files SET current_remote_hash = ? WHERE id = ?",
            args: [sha256Buffer(content), f.file_id],
          });
        } catch (e) {
          out.errors.push({ remote_path: f.remote_path, error: `hash backfill failed: ${(e as Error).message}` });
        }
      }
    }
    for (const s of res.skipped) {
      if (s.reason !== "already tracked") out.errors.push({ remote_path: s.remote_path, error: s.reason });
    }
  }
  return out;
}
