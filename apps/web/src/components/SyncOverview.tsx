// Global "unsynced" overview. Lists every node with local work not yet on a
// remote, with one-click per-node sync and a sync-all. Opened from the
// StatusFooter badge.
//
// "Synchronizovat vše" (#273) starts a server-side background job
// (POST /sync/jobs) instead of looping runNodeSync client-side: closing
// this modal, switching windows, or a slow node no longer stalls the whole
// batch behind one spinner with no visible progress. A job already running
// when the modal mounts (e.g. reopened after being closed mid-run) is
// picked back up via GET /sync/jobs/current. Per-node "Synchronizovat"
// stays a direct runNodeSync call -- one node is already fast enough that
// a job adds nothing but latency.
import { useEffect, useRef, useState } from "react";
import { X, RefreshCw, Loader2, Check, AlertTriangle } from "lucide-react";
import type { SyncPendingResponse, SyncRunResponse, SyncJobSummary } from "../types";
import { runNodeSync, startSyncJob, fetchSyncJob, fetchCurrentSyncJob } from "../api";

const JOB_POLL_MS = 800;

export default function SyncOverview({
  pending,
  onClose,
  onSynced,
  onMutated,
  onSelectNode,
}: {
  pending: SyncPendingResponse;
  onClose: () => void;
  // Applied per finished run, so a synced node leaves the list at once
  // instead of waiting out the cross-mirror rescan behind onMutated.
  onSynced: (nodeId: string, run: SyncRunResponse) => void;
  onMutated: () => void;
  onSelectNode: (id: string) => void;
}) {
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [job, setJob] = useState<SyncJobSummary | null>(null);
  // Guards onSynced/onMutated so a re-render (e.g. a duplicate poll
  // response) never re-applies the same node's result twice.
  const appliedNodesRef = useRef<Set<string>>(new Set());
  const notifiedMutatedRef = useRef<string | null>(null);

  // Reattach to an already-running job on mount, so closing and reopening
  // the modal (or switching windows) does not lose track of progress.
  useEffect(() => {
    let cancelled = false;
    fetchCurrentSyncJob()
      .then((j) => {
        if (!cancelled && j && j.status === "running") setJob(j);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll the active job to completion. Applies each node's result the
  // moment it finishes (not just at the very end), same immediacy the old
  // client-side loop had.
  useEffect(() => {
    if (job?.status !== "running") return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      let next: SyncJobSummary;
      try {
        next = await fetchSyncJob(job.id);
      } catch {
        return; // transient -- keep polling
      }
      if (cancelled) return;
      setJob(next);
      for (const n of next.nodes) {
        if (n.status === "done" && n.result && !appliedNodesRef.current.has(n.node_id)) {
          appliedNodesRef.current.add(n.node_id);
          onSynced(n.node_id, n.result);
        }
      }
      if (next.status === "done") {
        window.clearInterval(timer);
        if (notifiedMutatedRef.current !== next.id) {
          notifiedMutatedRef.current = next.id;
          onMutated();
        }
      }
    }, JOB_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- polls by job.id/status, not the whole object
  }, [job?.id, job?.status]);

  const syncOne = async (nodeId: string) => {
    setBusy((b) => new Set(b).add(nodeId));
    try {
      onSynced(nodeId, await runNodeSync(nodeId));
      onMutated();
    } catch {
      /* per-node failure is surfaced by the refreshed aggregate */
    } finally {
      setBusy((b) => {
        const n = new Set(b);
        n.delete(nodeId);
        return n;
      });
    }
  };

  const syncAll = async () => {
    try {
      // Only actionable nodes -- a decisions-only node (conflict/deleted_local)
      // is never touched by a run, so including it here would just be a
      // wasted round trip.
      const nodeIds = pending.nodes.filter((n) => n.total > 0).map((n) => n.node_id);
      appliedNodesRef.current = new Set();
      const started = await startSyncJob(nodeIds);
      setJob(started);
    } catch {
      /* the job simply never started; the button re-enables for a retry */
    }
  };

  const allBusy = job?.status === "running";
  const jobNodeStatus = (nodeId: string) => job?.nodes.find((n) => n.node_id === nodeId)?.status ?? null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-[560px] flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-3">
          <div className="text-[14.5px] font-semibold text-[var(--color-text)]">
            Nesynchronizováno
          </div>
          <span className="font-mono text-[12px] text-[var(--color-text-dim)]">
            {pending.total} souborů
          </span>
          {pending.decisions > 0 && (
            <span
              className="font-mono text-[12px] text-[var(--color-danger)]"
              title="Konflikty a lokálně smazané soubory -- Synchronizovat vše je nevyřeší, otevřete uzel a rozhodněte"
            >
              +{pending.decisions} k rozhodnutí
            </span>
          )}
          <span className="flex-1" />
          {allBusy && job && (
            <span className="font-mono text-[11.5px] text-[var(--color-text-dim)]">
              {job.completed}/{job.total}
            </span>
          )}
          {pending.nodes.length > 0 && (
            <button
              type="button"
              onClick={syncAll}
              disabled={allBusy}
              className="flex items-center gap-1 rounded-md border border-[var(--color-accent-dim)] px-3 py-1 text-[12.5px] text-[var(--color-accent)] hover:bg-[var(--color-surface)] disabled:opacity-50"
            >
              {allBusy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              Synchronizovat vše
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            title="Zavřít"
            className="rounded p-1 text-[var(--color-text-dim)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
          >
            <X size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {pending.nodes.length === 0 ? (
            <div className="px-3 py-6 text-center text-[13px] text-[var(--color-text-dim)]">
              Všechno je synchronizované.
            </div>
          ) : (
            pending.nodes.map((n) => {
              const nodeJobStatus = jobNodeStatus(n.node_id);
              const isBusy = busy.has(n.node_id) || nodeJobStatus === "running" || nodeJobStatus === "pending";
              return (
                <div
                  key={n.node_id}
                  className="flex items-center gap-3 rounded-md px-3 py-2 hover:bg-[var(--color-surface)]"
                >
                  <button
                    type="button"
                    onClick={() => onSelectNode(n.node_id)}
                    className="min-w-0 flex-1 truncate text-left text-[13.5px] text-[var(--color-text)] hover:underline"
                    title="Přejít na uzel"
                  >
                    {n.node_name}
                  </button>
                  <span className="font-mono text-[11.5px] text-[var(--color-text-dim)]">
                    {n.push > 0 && <span title="Ke pushnutí">{"↑"}{n.push} </span>}
                    {n.untracked > 0 && <span title="Neregistrováno">{"◯"}{n.untracked} </span>}
                    {n.conflict > 0 && (
                      <span className="text-[var(--color-danger)]" title="Konflikt">{"⚠"}{n.conflict} </span>
                    )}
                    {n.remote_missing > 0 && <span title="Chybí na remote">{"⊘"}{n.remote_missing} </span>}
                    {n.deleted_local > 0 && <span title="Smazáno lokálně">{"␡"}{n.deleted_local} </span>}
                  </span>
                  {nodeJobStatus === "done" ? (
                    <span className="flex items-center gap-1 px-2 py-1 text-[12px] text-[var(--color-accent)]" title="Synchronizováno">
                      <Check size={12} />
                    </span>
                  ) : nodeJobStatus === "error" ? (
                    <span className="flex items-center gap-1 px-2 py-1 text-[12px] text-[var(--color-danger)]" title="Selhalo">
                      <AlertTriangle size={12} />
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => syncOne(n.node_id)}
                      disabled={isBusy}
                      className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-[12px] text-[var(--color-text)] hover:border-[var(--color-border-strong)] disabled:opacity-50"
                    >
                      {isBusy ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                      Synchronizovat
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
