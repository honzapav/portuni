// Cheap, hash-free discovery of files on disk in a node mirror that are not
// registered in the `files` table. Used by the UI (sync-status `untracked`)
// and the sync run (auto-adopt). Mirrors engine.ts walkMirror but skips
// sha256 -- the hash is recomputed by storeFile at adopt time, and the UI
// only needs paths.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { getMirrorPath } from "./mirror-registry.js";
import { resolveNodeInfo } from "./node-info.js";
import {
  buildNodeRoot,
  deriveLocalPath,
  subpathFromMirror,
  type Section,
} from "./remote-path.js";

export interface UntrackedLocalEntry {
  node_id: string;
  local_path: string;
  section: Section;
  subpath: string | null;
  filename: string;
}

export async function listUntrackedLocal(
  db: Client,
  a: { userId: string; nodeId: string },
): Promise<UntrackedLocalEntry[]> {
  const mirrorRoot = await getMirrorPath(a.userId, a.nodeId);
  if (!mirrorRoot) return [];

  let nodeRoot: string;
  try {
    nodeRoot = buildNodeRoot(await resolveNodeInfo(db, a.nodeId));
  } catch {
    return [];
  }

  // Known local paths derived from this node's registered files.
  const filesRes = await db.execute({
    sql: "SELECT remote_path FROM files WHERE node_id = ?",
    args: [a.nodeId],
  });
  const known = new Set<string>();
  for (const r of filesRes.rows) {
    const rp = r.remote_path as string | null;
    if (!rp) continue;
    try {
      known.add(deriveLocalPath({ mirrorRoot, nodeRoot, remotePath: rp }));
    } catch {
      /* ignore */
    }
  }

  const out: UntrackedLocalEntry[] = [];
  for (const section of ["wip", "outputs", "resources"] as Section[]) {
    await walk(join(mirrorRoot, section), mirrorRoot, a.nodeId, known, out);
  }
  return out;
}

async function walk(
  dir: string,
  mirrorRoot: string,
  nodeId: string,
  known: Set<string>,
  out: UntrackedLocalEntry[],
): Promise<void> {
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      await walk(p, mirrorRoot, nodeId, known, out);
    } else if (ent.isFile()) {
      if (known.has(p)) continue;
      const sub = subpathFromMirror(mirrorRoot, p);
      if (!sub) continue;
      out.push({
        node_id: nodeId,
        local_path: p,
        section: sub.section,
        subpath: sub.subpath,
        filename: sub.filename,
      });
    }
  }
}
