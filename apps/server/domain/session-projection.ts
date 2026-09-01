// Per-session projection directory (spec: "Disk contract",
// docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md,
// issue #191).
//
// Ad-hoc (non-seed) nodes a session expands into mid-run are not granted
// their real mirror path by the Seatbelt profile -- only home + depth-1
// neighbours are, frozen at spawn (domain/sandbox-profile.ts). Instead they
// are hardlinked into <projectionRoot>/<sessionId>/<nodeId>/, a location
// under the read-only parent the Seatbelt profile does grant
// (resolveProjectionRootForNode). Hardlinks mean no data duplication and
// always-current content: an edit to the real mirror file is visible
// through the link immediately, no re-copy needed.
//
// Placed OUTSIDE every mirror on purpose: nesting hardlinks inside a
// watched mirror would make the mirror-watcher treat them as new local
// files of that mirror's node, corrupting its sync state.
//
// A tiny in-memory registry (registerProjectedNode / projectedEntriesForNode)
// lets the mirror-watcher -- which only knows about mirror paths, not
// sessions -- find which projection directories need a create/delete
// mirrored for a given node's file change. It is process-local and never
// persisted: on restart it starts empty and is rebuilt as each session's
// disk-projector re-projects its accumulated read set (restart
// consolidation).

import { dirname, join, relative, sep } from "node:path";
import { copyFile, link, mkdir, readdir, rm, stat } from "node:fs/promises";
import type { Client } from "@libsql/client";
import { loadMirrorIgnore } from "./sync/mirror-ignore.js";

// Hardlink, falling back to a real copy across a filesystem boundary
// (EXDEV -- a mirror on another volume than the projection root, e.g. a
// custom mirror path or an external drive). A copy loses the "always
// current" property (an edit to the source needs a re-copy, which
// relinkOne below already triggers on every watched change), but it is
// strictly better than the silent empty-directory failure this used to be.
// Any other error is logged -- best-effort must not mean invisible.
export async function linkOrCopy(src: string, dest: string): Promise<boolean> {
  try {
    await link(src, dest);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return true; // already linked from a previous call
    if (code === "EXDEV") {
      await copyFile(src, dest);
      return true;
    }
    console.error(`[portuni:session-projection] failed to project ${src} -> ${dest}:`, err);
    return false;
  }
}

// The three synced content roots inside every mirror (see remote-path.ts
// Section) -- the same scope discover-local.ts and remote-sweep.ts walk.
const SECTIONS = ["wip", "outputs", "resources"] as const;

export function sessionProjectionDir(projectionRoot: string, sessionId: string): string {
  return join(projectionRoot, sessionId);
}

export function nodeProjectionDir(
  projectionRoot: string,
  sessionId: string,
  nodeId: string,
): string {
  return join(sessionProjectionDir(projectionRoot, sessionId), nodeId);
}

// Recursively hardlink every file under mirrorPath's synced sections into
// targetDir, preserving relative structure and the same ignore policy the
// sync engine uses (dotfiles, .portuniignore patterns). Idempotent: an
// already-linked file (EEXIST) counts toward the total without being
// re-linked, so re-projecting an already-expanded node is a cheap no-op.
// Returns the number of files linked (new + already-present).
export async function projectNode(mirrorPath: string, targetDir: string): Promise<number> {
  const isIgnored = await loadMirrorIgnore(mirrorPath);
  let count = 0;
  for (const section of SECTIONS) {
    count += await linkDir(join(mirrorPath, section), mirrorPath, targetDir, isIgnored);
  }
  return count;
}

async function linkDir(
  dir: string,
  mirrorRoot: string,
  targetRoot: string,
  isIgnored: (p: string) => boolean,
): Promise<number> {
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (isIgnored(p)) continue;
    if (ent.isDirectory()) {
      count += await linkDir(p, mirrorRoot, targetRoot, isIgnored);
    } else if (ent.isFile()) {
      const dest = join(targetRoot, relative(mirrorRoot, p));
      await mkdir(dirname(dest), { recursive: true });
      if (await linkOrCopy(p, dest)) count++;
    }
  }
  return count;
}

export async function unprojectNode(
  projectionRoot: string,
  sessionId: string,
  nodeId: string,
): Promise<void> {
  await rm(nodeProjectionDir(projectionRoot, sessionId, nodeId), {
    recursive: true,
    force: true,
  });
}

// Called at session end -- the agent never manages this directory.
export async function cleanupSessionProjection(
  projectionRoot: string,
  sessionId: string,
): Promise<void> {
  await rm(sessionProjectionDir(projectionRoot, sessionId), {
    recursive: true,
    force: true,
  });
}

// Startup sweep (#208): cleanup at session end (cleanupSessionProjection,
// called from transport.ts's onclose) is the only sweeper today -- a crashed
// server process (or the whole desktop app) never runs onclose, so a
// session's hardlinks stay on disk, still covered by the Seatbelt grant on
// <portuniRoot>/.portuni-sessions/<homeNodeId>, readable by the NEXT session
// spawned on that node with no scope event ever recorded for it. Call once
// at boot: any <homeNodeId>/<sessionId> directory whose session is not
// 'running' in the durable sessions table (closed/suspended/archived, or a
// session id that does not exist at all) is stale and removed. A session
// legitimately still 'running' when the server restarts has no live
// connection anyway (this process is what held it) -- its projection is
// kept rather than guessed at, since a resumed connection re-materializes
// it from the accumulated read set regardless (spec: "Restart consolidates").
// Best-effort throughout: a single node/session directory that fails to
// read or remove is logged and skipped, never aborts the whole sweep.
export async function sweepStaleSessionProjections(
  db: Client,
  portuniRoot: string,
): Promise<{ removed: string[] }> {
  const base = join(portuniRoot, ".portuni-sessions");
  const removed: string[] = [];
  let nodeDirs: string[];
  try {
    nodeDirs = await readdir(base);
  } catch {
    return { removed }; // no projection root yet -- nothing to sweep
  }

  for (const nodeId of nodeDirs) {
    const nodeDir = join(base, nodeId);
    let sessionIds: string[];
    try {
      sessionIds = await readdir(nodeDir);
    } catch (err) {
      console.error(`[portuni:session-projection] sweep: failed to read ${nodeDir}:`, err);
      continue;
    }
    for (const sessionId of sessionIds) {
      try {
        const running = await db.execute({
          sql: "SELECT 1 FROM sessions WHERE id = ? AND state = 'running'",
          args: [sessionId],
        });
        if (running.rows.length > 0) continue;
        const target = join(nodeDir, sessionId);
        await rm(target, { recursive: true, force: true });
        removed.push(target);
      } catch (err) {
        console.error(
          `[portuni:session-projection] sweep: failed to remove stale projection for session ${sessionId}:`,
          err,
        );
      }
    }
  }
  return { removed };
}

// --- Registry -------------------------------------------------------------

interface ProjectedEntry {
  sessionId: string;
  mirrorPath: string;
  targetDir: string;
}

const registry = new Map<string, Map<string, ProjectedEntry>>();

export function registerProjectedNode(nodeId: string, entry: ProjectedEntry): void {
  let bySession = registry.get(nodeId);
  if (!bySession) {
    bySession = new Map();
    registry.set(nodeId, bySession);
  }
  bySession.set(entry.sessionId, entry);
}

// Drop every projection this session registered, across all nodes. Call at
// session end alongside cleanupSessionProjection.
export function unregisterSessionProjections(sessionId: string): void {
  for (const [nodeId, bySession] of registry) {
    bySession.delete(sessionId);
    if (bySession.size === 0) registry.delete(nodeId);
  }
}

export function projectedEntriesForNode(nodeId: string): ProjectedEntry[] {
  const bySession = registry.get(nodeId);
  return bySession ? [...bySession.values()] : [];
}

// Test-only: drop every registered projection regardless of session, so
// tests don't leak state into each other via the module-level registry.
export function clearProjectionRegistryForTests(): void {
  registry.clear();
}

// Mirror-watcher hook: a file inside a projected node's mirror was created,
// changed, or deleted. Relinks (create/update) or removes (source deleted)
// the corresponding hardlink in every session currently projecting that
// node. Best-effort throughout -- errors are swallowed so a projection
// hiccup never breaks the deterministic file-state reconciliation the
// watcher exists for.
export async function relinkProjectedFile(nodeId: string, absPath: string): Promise<void> {
  const entries = projectedEntriesForNode(nodeId);
  if (entries.length === 0) return;
  await Promise.all(entries.map((entry) => relinkOne(entry, absPath)));
}

async function relinkOne(entry: ProjectedEntry, absPath: string): Promise<void> {
  const rel = relative(entry.mirrorPath, absPath);
  if (rel.startsWith("..")) return; // outside this entry's mirror
  const section = rel.split(sep)[0];
  if (!(SECTIONS as readonly string[]).includes(section)) return; // never projected
  try {
    const isIgnored = await loadMirrorIgnore(entry.mirrorPath);
    if (isIgnored(absPath)) return;
    const dest = join(entry.targetDir, rel);
    const st = await stat(absPath);
    if (st.isDirectory()) return; // directories are created lazily via mkdir below
    await mkdir(dirname(dest), { recursive: true });
    await rm(dest, { force: true });
    await linkOrCopy(absPath, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Source deleted (or an ignore-file read raced a delete) -- drop the
      // hardlink too.
      const dest = join(entry.targetDir, rel);
      await rm(dest, { recursive: true, force: true }).catch(() => undefined);
    }
    // else swallow -- best-effort.
  }
}
