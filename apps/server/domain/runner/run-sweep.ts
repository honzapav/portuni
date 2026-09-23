// Boot-time cleanup for orphaned runner children (#325): session-runtime.ts
// writes <dataDir>/runs/<runId>.pid when a run starts and removes it on
// run_ended, so a pid file still present at boot names a run this process
// can no longer be tracking -- the live SessionRuntime that started it did
// not survive to see it end (sidecar crash or restart). Local mode only:
// a pid file is only ever written by the process that itself spawned the
// child, on this same machine, so only that process's own next boot can
// ever find it -- there is no cross-host lookup to build. "Local mode" is
// about the machine, not the data mode: a central-mode sidecar spawns the
// same children and leaves the same pid files behind, so #393 made the
// db-shaped half of this sweep injected (the record store and how a run is
// resolved) and central mode supplies its own, backed by CentralSessionStore.
//
// Mirrors boot/session-sweep.ts's shape one level down: that sweep already
// suspends a 'running' session row with no live run at all (a hand-opened
// CLI); this one additionally reaps the child process and closes out the
// run row for a session a runner task was driving. Order matters (spec):
// this sweep must run BEFORE sweepStaleRunningSessionsOnBoot, since it is
// this sweep's own suspend that already resolves the session -- by the time
// the other sweep looks at 'running' rows, a session this one touched is no
// longer one of them.

import { execFile as nodeExecFile } from "node:child_process";
import type { DbClient } from "../../infra/db.js";
import { DbSessionStore, type SessionStore } from "./store.js";
import { deviceSessionContentStore, type SessionContentStore } from "./store-content.js";
import { isProcessAlive } from "./process-liveness.js";
import { listPidFiles, readPidFile, removePidFileAt, type PidFileEntry } from "./pid-file.js";

const DEFAULT_SIGTERM_GRACE_MS = 5_000;

export interface RunSweepDeps {
  execFile?: typeof nodeExecFile;
  isAlive?: (pid: number) => boolean;
  sigtermGraceMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SweptRun {
  id: string;
  session_id: string;
  ended_at: string | null;
}

// What the sweep needs beyond the filesystem: where a run record lives and
// where the transcript is written. Local mode reads the record straight off
// the graph db; central mode goes through CentralSessionStore. The
// transcript is the device's either way. #458 dropped the third member (how
// a session is suspended): a dead run's session is suspended with no
// handoff in both backends, which is a plain record patch -- the process
// that could have summarised the run is the one that died.
export interface RunSweepBackend {
  store: SessionStore;
  // The transcript the sweep's own run_ended event goes into: this device's
  // content.db in both workspaces (#456), never the record store.
  content: SessionContentStore;
  resolveRun(runId: string, sessionId: string | null): Promise<SweptRun | null>;
}

export interface RunSweepResult {
  // Runs whose orphaned child was actually signaled (SIGTERM, possibly
  // followed by SIGKILL).
  killed: number;
  // Runs marked host_lost (includes ones whose pid was already dead, or
  // alive but not a claude process this sweep would touch).
  cleaned: number;
  // Pid files removed for a run that had already ended by the time this
  // ran -- a normal race between run_ended's own removePidFile and a sweep
  // that started just before it, nothing to clean up beyond the file.
  staleFilesRemoved: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A pid file surviving a crash names a pid that may, by the time this
// sweep runs, belong to an unrelated process the OS handed the same number
// back out to -- including the user's own interactive Claude Code session,
// whose command line contains "claude" just like the child did. Two checks
// from one `ps` call decide whether the pid is still OUR child: the
// command line names claude, AND the process started no later than the
// pid file was written (a reused pid was necessarily started after the
// original died, i.e. after the file). An unparseable start time falls
// back to the command-line check alone rather than skipping the kill.
export interface ProcessIdentity {
  commandLine: string;
  startedAt: Date | null;
}

export function readProcessIdentity(pid: number, execFile: typeof nodeExecFile): Promise<ProcessIdentity | null> {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "lstart=", "-o", "command=", "-p", String(pid)], (err, stdout) => {
      if (err || typeof stdout !== "string" || stdout.trim() === "") {
        resolve(null);
        return;
      }
      resolve(parseProcessIdentity(stdout));
    });
  });
}

// `lstart=` renders as e.g. "Sat Sep 13 20:15:03 2026" (five space-separated
// fields, fixed by ps on both macOS and Linux), followed by the command
// line on the same row. Exported for its own unit test.
export function parseProcessIdentity(psRow: string): ProcessIdentity {
  const line = psRow.trim().split("\n")[0] ?? "";
  const fields = line.split(/\s+/);
  const stamp = fields.slice(0, 5).join(" ");
  const parsed = Date.parse(stamp);
  const startedAt = fields.length >= 5 && !Number.isNaN(parsed) ? new Date(parsed) : null;
  const commandLine = startedAt ? fields.slice(5).join(" ") : line;
  return { commandLine, startedAt };
}

// Tolerates ps's whole-second start time against the file's millisecond
// stamp, plus a little clock slop.
const START_TOLERANCE_MS = 5_000;

export function isOurChild(identity: ProcessIdentity | null, pidFileStartedAt: string): boolean {
  if (!identity) return false;
  if (!identity.commandLine.includes("claude")) return false;
  if (identity.startedAt === null) return true;
  const recorded = Date.parse(pidFileStartedAt);
  if (Number.isNaN(recorded)) return true;
  return identity.startedAt.getTime() <= recorded + START_TOLERANCE_MS;
}

// The child was spawned as its own process-group leader
// (adapters/claude.ts); signal the group so its helpers go with it, then
// the pid itself as a fallback.
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // Not a group leader here (or already gone) -- the pid alone.
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

async function loadRun(db: DbClient, runId: string): Promise<{ id: string; session_id: string; ended_at: string | null } | null> {
  const res = await db.execute({ sql: "SELECT id, session_id, ended_at FROM session_runs WHERE id = ?", args: [runId] });
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return {
    id: String(row.id),
    session_id: String(row.session_id),
    ended_at: row.ended_at === null ? null : String(row.ended_at),
  };
}

async function sweepOne(
  backend: RunSweepBackend,
  entry: PidFileEntry,
  deps: Required<RunSweepDeps>,
  result: RunSweepResult,
): Promise<void> {
  const content = await readPidFile(entry.path);
  if (!content) {
    await removePidFileAt(entry.path);
    return;
  }

  const run = await backend.resolveRun(entry.runId, content.session_id);
  if (!run || run.ended_at !== null) {
    await removePidFileAt(entry.path);
    if (run) result.staleFilesRemoved++;
    return;
  }

  if (deps.isAlive(content.pid) && isOurChild(await readProcessIdentity(content.pid, deps.execFile), content.started_at)) {
    signalGroup(content.pid, "SIGTERM");
    await deps.sleep(deps.sigtermGraceMs);
    if (deps.isAlive(content.pid)) signalGroup(content.pid, "SIGKILL");
    result.killed++;
  }

  const store = backend.store;
  await backend.content.appendEvents(run.session_id, run.id, [
    { kind: "run_ended", payload: { run_id: run.id, reason: "host_lost", usage: null } },
  ]);
  await store.patchRun(run.id, { ended_at: new Date().toISOString(), end_reason: "host_lost" });

  // #458: suspended with no handoff. The run this sweep is closing out died
  // with the process that was driving it; there is no summary to write on
  // its behalf that the next run could trust, and the central server has no
  // content to write one from either. The thread is resumable from its
  // transcript, which is on this device.
  const session = await store.getSession(run.session_id);
  if (session?.state === "running") {
    await store.patchSession(run.session_id, { state: "suspended", waiting_since: null });
  }

  await removePidFileAt(entry.path);
  result.cleaned++;
}

export async function sweepOrphanedRunsOn(
  backend: RunSweepBackend,
  dataDir: string,
  deps: RunSweepDeps = {},
): Promise<RunSweepResult> {
  const resolved: Required<RunSweepDeps> = {
    execFile: deps.execFile ?? nodeExecFile,
    isAlive: deps.isAlive ?? isProcessAlive,
    sigtermGraceMs: deps.sigtermGraceMs ?? DEFAULT_SIGTERM_GRACE_MS,
    sleep: deps.sleep ?? defaultSleep,
  };
  const result: RunSweepResult = { killed: 0, cleaned: 0, staleFilesRemoved: 0 };
  for (const entry of await listPidFiles(dataDir)) {
    await sweepOne(backend, entry, resolved, result);
  }
  return result;
}

export function localRunSweepBackend(db: DbClient, content?: SessionContentStore): RunSweepBackend {
  return {
    store: new DbSessionStore(db),
    content: content ?? deviceSessionContentStore(),
    resolveRun: (runId) => loadRun(db, runId),
  };
}

// Central mode has no session_runs table here: the run is resolved through
// the session it belongs to, which is why the pid file records that id
// (#393). A file written before that field existed names no session, so
// there is nothing to resolve -- it is removed as stale rather than left
// to be re-examined at every boot forever.
export function centralRunSweepBackend(store: SessionStore, content: SessionContentStore): RunSweepBackend {
  return {
    store,
    content,
    resolveRun: async (runId, sessionId) => {
      if (!sessionId) return null;
      const runs = await store.listRuns(sessionId);
      const run = runs.find((r) => r.id === runId);
      return run ? { id: run.id, session_id: run.session_id, ended_at: run.ended_at } : null;
    },
  };
}

export async function sweepOrphanedRuns(
  db: DbClient,
  dataDir: string,
  deps: RunSweepDeps = {},
  content?: SessionContentStore,
): Promise<RunSweepResult> {
  return sweepOrphanedRunsOn(localRunSweepBackend(db, content), dataDir, deps);
}
