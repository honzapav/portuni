// Staging of in-scope node files into the home mirror.
//
// Single-source model: staging fires on EVERY scope entry, not just a
// user-approved expansion. Any path that adds a node to the session scope
// (auto-seed, session_init, get_node/get_context auto-allow, expand_scope)
// goes through SessionScope.onAdd -> ScopeReconciler, which calls this
// staging routine. The Seatbelt profile is home-only (home mirror rw, the
// rest of PORTUNI_ROOT denied), so copying a node's mirror into
// <homeMirror>/.portuni-scope/<nodeId>/ — inside the visible zone,
// read-only — is the ONLY way a non-home in-scope node's files become
// readable to the agent. Re-staging refreshes the copy.
//
// Dot-segment paths are excluded from both sync walkers
// (sync/mirror-ignore.ts), so staged copies never get auto-adopted or
// pushed to a remote.

import { cp, chmod, mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";

export interface StageResult {
  // Absolute path of the staged copy.
  staged_path: string;
  // Number of files copied.
  files: number;
}

async function countAndChmodFiles(dir: string): Promise<number> {
  let count = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      count += await countAndChmodFiles(p);
    } else if (entry.isFile()) {
      // Read-only is a courtesy guardrail (the sandbox grants rw inside
      // the home mirror); best-effort, never fatal.
      try {
        await chmod(p, 0o444);
      } catch {
        /* best-effort */
      }
      count += 1;
    }
  }
  return count;
}

// Copy `nodeMirror` into `<homeMirror>/.portuni-scope/<nodeId>/`.
// Dot-segments in the source (e.g. .claude/, .git/, the source's own
// .portuni-scope/) are skipped. Re-staging replaces the previous copy
// wholesale so stale files do not linger.
export async function stageNodeIntoMirror(args: {
  homeMirror: string;
  nodeId: string;
  nodeMirror: string;
}): Promise<StageResult> {
  const src = await stat(args.nodeMirror);
  if (!src.isDirectory()) {
    throw new Error(`node mirror is not a directory: ${args.nodeMirror}`);
  }

  const target = join(args.homeMirror, ".portuni-scope", args.nodeId);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });

  await cp(args.nodeMirror, target, {
    recursive: true,
    filter: (source) => !basename(source).startsWith(".") || source === args.nodeMirror,
  });

  const files = await countAndChmodFiles(target);
  return { staged_path: target, files };
}
