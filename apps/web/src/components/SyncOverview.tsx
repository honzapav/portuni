// Global "unsynced" overview. Lists every node with local work not yet on a
// remote, with one-click per-node sync and a sync-all. Reuses the per-node
// POST /nodes/:id/sync (runNodeSync). Opened from the StatusFooter badge.
import { useState } from "react";
import { X, RefreshCw, Loader2 } from "lucide-react";
import type { SyncPendingResponse } from "../types";
import { runNodeSync } from "../api";

export default function SyncOverview({
  pending,
  onClose,
  onMutated,
  onSelectNode,
}: {
  pending: SyncPendingResponse;
  onClose: () => void;
  onMutated: () => void;
  onSelectNode: (id: string) => void;
}) {
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [allBusy, setAllBusy] = useState(false);

  const syncOne = async (nodeId: string) => {
    setBusy((b) => new Set(b).add(nodeId));
    try {
      await runNodeSync(nodeId);
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
    setAllBusy(true);
    try {
      for (const n of pending.nodes) {
        try {
          await runNodeSync(n.node_id);
        } catch {
          /* keep going; refreshed aggregate shows what remains */
        }
      }
      onMutated();
    } finally {
      setAllBusy(false);
    }
  };

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
          <span className="flex-1" />
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
              const isBusy = busy.has(n.node_id) || allBusy;
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
                    {n.orphan > 0 && <span title="Orphan">{"⊘"}{n.orphan} </span>}
                    {n.deleted_local > 0 && <span title="Smazáno lokálně">{"␡"}{n.deleted_local} </span>}
                  </span>
                  <button
                    type="button"
                    onClick={() => syncOne(n.node_id)}
                    disabled={isBusy}
                    className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-[12px] text-[var(--color-text)] hover:border-[var(--color-border-strong)] disabled:opacity-50"
                  >
                    {isBusy ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                    Synchronizovat
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
