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
import {
  X,
  RefreshCw,
  Loader2,
  Check,
  AlertTriangle,
  ArrowUp,
  CirclePlus,
  CircleSlash,
  Trash2,
} from "lucide-react";
import type { SyncPendingResponse, SyncRunResponse, SyncJobSummary } from "../types";
import { runNodeSync, startSyncJob, fetchSyncJob, fetchCurrentSyncJob } from "../api";
import { useDataMode } from "../lib/central";

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
  // A local workspace has no remote (#310/#312) -- a sync run there would
  // only ever fail with LOCAL_MODE_NO_REMOTE, so "Synchronizovat"/
  // "Synchronizovat vše" stay hidden. Optimistically hidden while loading.
  const dataMode = useDataMode();
  const isCentralMode = dataMode?.mode === "central";
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
  // Only these can be cleared by a run at all -- so they alone decide
  // whether "Synchronizovat vse" has anything to do.
  const actionable = pending.nodes.filter((n) => n.total > 0);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-[600px] flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Two rows, not one: title + actions above, counts below. Crammed
            onto a single line these wrapped mid-phrase ("Synchronizovat /
            vse", "+12 k / rozhodnuti") as soon as a decisions count was
            present. */}
        <div className="flex flex-col gap-1.5 border-b border-[var(--color-border)] px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="text-[14.5px] font-semibold text-[var(--color-text)]">
              Nesynchronizováno
            </div>
            <span className="flex-1" />
            {allBusy && job && (
              <span className="whitespace-nowrap text-[11.5px] tabular-nums text-[var(--color-text-dim)]">
                {job.completed}/{job.total}
              </span>
            )}
            {isCentralMode && actionable.length > 0 && (
              <button
                type="button"
                onClick={syncAll}
                disabled={allBusy}
                className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--color-accent-dim)] px-3 py-1 text-[12.5px] text-[var(--color-accent)] hover:bg-[var(--color-surface)] disabled:opacity-50"
              >
                {allBusy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                Synchronizovat vše
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              title="Zavřít"
              className="shrink-0 rounded p-1 text-[var(--color-text-dim)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
            >
              <X size={14} />
            </button>
          </div>
          <div className="flex items-baseline gap-4 whitespace-nowrap text-[12px] text-[var(--color-text-dim)]">
            <span>
              <span className="tabular-nums text-[var(--color-text)]">{pending.total}</span>{" "}
              {fileWord(pending.total)} k synchronizaci
            </span>
            {pending.decisions > 0 && (
              <span
                className="text-[var(--color-danger)]"
                title="Konflikty a lokálně smazané soubory. Sync run se jich z principu nedotkne — otevři uzel a rozhodni."
              >
                <span className="tabular-nums">{pending.decisions}</span> k rozhodnutí
              </span>
            )}
          </div>
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
              // A run clears push + untracked and nothing else, so a node
              // holding only conflicts / local deletions cannot be helped by
              // one -- offering "Synchronizovat" there promises work that
              // will not happen. Send it to the node instead.
              const decisionsOnly = n.total === 0 && n.decisions > 0;
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
                  {/* Icons, not literal glyphs: the old badges spelled the
                      counts with characters no bundled font covers, so
                      deleted_local rendered as a "DEL" tofu box. */}
                  <span className="flex shrink-0 items-center gap-2.5">
                    <Count icon={ArrowUp} n={n.push} label="K odeslání" />
                    <Count icon={CirclePlus} n={n.untracked} label="Neregistrováno" />
                    <Count icon={CircleSlash} n={n.remote_missing} label="Chybí na remote" />
                    <Count icon={AlertTriangle} n={n.conflict} label="Konflikt — vyžaduje rozhodnutí" danger />
                    <Count icon={Trash2} n={n.deleted_local} label="Smazáno lokálně — vyžaduje rozhodnutí" danger />
                  </span>
                  {nodeJobStatus === "done" ? (
                    <span
                      className="flex w-[124px] shrink-0 items-center justify-end gap-1 px-2 py-1 text-[12px] text-[var(--color-accent)]"
                      title="Synchronizováno"
                    >
                      <Check size={12} />
                    </span>
                  ) : nodeJobStatus === "error" ? (
                    <span
                      className="flex w-[124px] shrink-0 items-center justify-end gap-1 px-2 py-1 text-[12px] text-[var(--color-danger)]"
                      title="Selhalo"
                    >
                      <AlertTriangle size={12} />
                    </span>
                  ) : (
                    // Fixed width so the buttons line up into a column
                    // instead of stepping in and out with each node name.
                    <span className="flex w-[124px] shrink-0 justify-end">
                      {decisionsOnly ? (
                        <button
                          type="button"
                          onClick={() => onSelectNode(n.node_id)}
                          title="Sync run konflikty neřeší — otevři uzel a rozhodni"
                          className="whitespace-nowrap rounded px-2 py-1 text-[12px] text-[var(--color-danger)] hover:bg-[var(--color-surface)]"
                        >
                          Rozhodnout
                        </button>
                      ) : (
                        isCentralMode && (
                          <button
                            type="button"
                            onClick={() => syncOne(n.node_id)}
                            disabled={isBusy}
                            className="flex items-center gap-1.5 whitespace-nowrap rounded px-2 py-1 text-[12px] text-[var(--color-text-dim)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] disabled:opacity-50"
                          >
                            {isBusy ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                            Synchronizovat
                          </button>
                        )
                      )}
                    </span>
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

// One count badge. Renders nothing at zero, so a row shows only the classes
// it actually has.
function Count({
  icon: Icon,
  n,
  label,
  danger,
}: {
  icon: typeof ArrowUp;
  n: number;
  label: string;
  danger?: boolean;
}) {
  if (n <= 0) return null;
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11.5px] tabular-nums ${
        danger ? "text-[var(--color-danger)]" : "text-[var(--color-text-dim)]"
      }`}
      title={label}
    >
      <Icon size={11} />
      {n}
    </span>
  );
}

// Czech counts the noun by the number: 1 soubor, 2-4 soubory, 0 and 5+ souborů.
function fileWord(n: number): string {
  if (n === 1) return "soubor";
  if (n >= 2 && n <= 4) return "soubory";
  return "souborů";
}
