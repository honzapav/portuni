// In-memory background job for a multi-node sync run (#273). A sync run
// used to be one blocking HTTP request per node, looped client-side for
// "Synchronizovat vše" (apps/web/src/components/SyncOverview.tsx's syncAll)
// -- closing the overview modal, switching windows, or one slow node
// stalled the whole batch behind a single spinner with no way to see what
// was actually happening. A job starts immediately (POST /sync/jobs),
// runs every requested node's runNodeSync with bounded concurrency, and is
// polled for progress (GET /sync/jobs/:id) -- closing the UI does not stop
// it, and GET /sync/jobs/current lets a remounted UI reattach to whatever
// is still running instead of losing track of it.
//
// State lives in memory only, scoped to this process: a sidecar/server
// restart loses in-flight job/progress state, but not correctness -- each
// node's own runNodeSync call is independently safe to re-run (it is the
// same call the existing synchronous per-node route already makes), so a
// lost job is a lost progress view, never lost or duplicated sync work. A
// fully durable, cross-restart job queue (DB-persisted progress) is a
// larger investment than this fix set out to make.

import { ulid } from "ulid";
import type { SyncJobNode, SyncJobSummary, SyncRunResponse } from "../../shared/api-types.js";

const JOB_CONCURRENCY = Math.max(1, Number(process.env.PORTUNI_SYNC_JOB_CONCURRENCY ?? 3));
// How long a finished job stays fetchable by id after it completes, so a
// client that was mid-poll when it finished still gets the final state
// instead of a 404.
const JOB_RETENTION_MS = 10 * 60_000;

interface SyncJob {
  id: string;
  user_id: string;
  status: "running" | "done";
  started_at: string;
  finished_at: string | null;
  nodes: SyncJobNode[];
}

const jobs = new Map<string, SyncJob>();
// One tracked "current" job per user at a time: a second start (a stale
// double-click, another tab) while one is already running reattaches to it
// instead of racing a second job over the same nodes.
const currentJobIdByUser = new Map<string, string>();

function toSummary(job: SyncJob): SyncJobSummary {
  return {
    id: job.id,
    status: job.status,
    started_at: job.started_at,
    finished_at: job.finished_at,
    total: job.nodes.length,
    completed: job.nodes.filter((n) => n.status === "done" || n.status === "error").length,
    errored: job.nodes.filter((n) => n.status === "error").length,
    nodes: job.nodes,
  };
}

// nodeIds must already be authorization-filtered by the caller (the REST
// handler, which has the request context guardWrite needs) -- this module
// has no notion of identity beyond the userId string used to scope
// get/list lookups. runNode does the actual per-node work -- local mode
// passes runNodeSync (sync-run.ts, direct Turso access) and central mode
// passes syncRunCentral (engine-central.ts, via CentralClient); this
// module is agnostic to which, so the job/progress machinery is shared.
export function startSyncJob(
  a: { userId: string; nodeIds: string[]; runNode: (nodeId: string) => Promise<SyncRunResponse> },
): SyncJobSummary {
  const existing = getCurrentSyncJob(a.userId);
  if (existing) return existing;

  const id = ulid();
  const job: SyncJob = {
    id,
    user_id: a.userId,
    status: "running",
    started_at: new Date().toISOString(),
    finished_at: null,
    nodes: a.nodeIds.map((node_id) => ({ node_id, status: "pending" })),
  };
  jobs.set(id, job);
  currentJobIdByUser.set(a.userId, id);

  void runJob(job, a.runNode);
  return toSummary(job);
}

async function runJob(job: SyncJob, runNode: (nodeId: string) => Promise<SyncRunResponse>): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= job.nodes.length) return;
      const n = job.nodes[i];
      n.status = "running";
      try {
        n.result = await runNode(n.node_id);
        n.status = "done";
      } catch (e) {
        n.status = "error";
        n.error = e instanceof Error ? e.message : String(e);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(JOB_CONCURRENCY, job.nodes.length) }, () => worker()),
  );
  job.status = "done";
  job.finished_at = new Date().toISOString();
  // Only clear "current" if nothing else already replaced it (defensive;
  // startSyncJob's own reattach means this should always still be us).
  if (currentJobIdByUser.get(job.user_id) === job.id) {
    currentJobIdByUser.delete(job.user_id);
  }
  const timer = setTimeout(() => jobs.delete(job.id), JOB_RETENTION_MS);
  timer.unref?.();
}

export function getSyncJob(userId: string, jobId: string): SyncJobSummary | null {
  const job = jobs.get(jobId);
  if (!job || job.user_id !== userId) return null;
  return toSummary(job);
}

// The user's own currently-RUNNING job, if any -- lets a remounted overview
// (modal reopened, window switched back to) reattach without needing to
// have remembered the job id. Returns null once the job has finished, even
// if it is still within its retention window (fetch it by id instead).
export function getCurrentSyncJob(userId: string): SyncJobSummary | null {
  const id = currentJobIdByUser.get(userId);
  if (!id) return null;
  const job = jobs.get(id);
  if (job?.status !== "running") return null;
  return toSummary(job);
}
