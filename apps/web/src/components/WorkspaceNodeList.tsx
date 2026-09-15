// Left column of the workspace view. Lists every OPEN node in open-first
// order (see deriveWorkspaceNodeRows); a node stays until it is explicitly
// closed. Under each node, its running/suspended sessions (threads) are
// sub-rows, so any live thread on any node is one click away without first
// selecting its parent. The row's "+" starts a new task on that node.
import { Plus, X } from "lucide-react";
import type { WorkspaceNodeRow } from "../lib/sessions";
import { sessionRowChip } from "../lib/session-views";
import type { SessionSummary } from "../types";

type Props = {
  rows: WorkspaceNodeRow[];
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  onCloseNode: (id: string) => void;
  // "+" on a node row: start a new task there (opens NewTaskDialog).
  onNewTask: (id: string) => void;
  // #343: each open node's own running/suspended persistent (runner)
  // sessions, already live-overlaid by the caller (mergeLiveSessionStates).
  // Status comes from state/waiting_since (session_state frames).
  openSessionsByNode: Record<string, SessionSummary[]>;
  onOpenSessionChat: (nodeId: string, sessionId: string) => void;
};

function nodeTypeVar(type: string): string {
  const known = ["organization", "project", "process", "area", "principle"];
  return known.includes(type) ? `var(--color-node-${type})` : "var(--color-node-default)";
}

export default function WorkspaceNodeList({
  rows,
  selectedNodeId,
  onSelectNode,
  onCloseNode,
  onNewTask,
  openSessionsByNode,
  onOpenSessionChat,
}: Props) {
  if (rows.length === 0) {
    return (
      <div className="px-4 py-6 text-[13px] text-[var(--color-text-dim)]">
        Žádné otevřené uzly.
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-0.5 px-2 py-2">
      {rows.map((r) => {
        const persistentSessions = openSessionsByNode[r.id] ?? [];
        const running = persistentSessions.some((s) => s.state === "running");
        const selected = r.id === selectedNodeId;
        return (
          <li key={r.id}>
            {/* Node row. Outer element selects the node; the + / × controls
                are role=button spans so we don't nest <button> (invalid). */}
            {/* biome-ignore lint/a11y/useSemanticElements: nested <button> is invalid HTML; role+tabIndex is the documented workaround */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => onSelectNode(r.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelectNode(r.id);
                }
              }}
              className={`group flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                selected
                  ? "bg-[var(--color-surface)] text-[var(--color-text)]"
                  : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
              }`}
            >
              <span
                className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: nodeTypeVar(r.type) }}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate" title={r.name}>
                {r.name}
              </span>
              {running && (
                <span
                  role="img"
                  className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
                  title="Agent pracuje"
                  aria-label="running"
                />
              )}
              {/* No working folder on an organization, so no task either --
                  same rule as DetailPane's NewTaskButton. */}
              {r.type !== "organization" && (
                // biome-ignore lint/a11y/useSemanticElements: see note above
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    onNewTask(r.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      onNewTask(r.id);
                    }
                  }}
                  title="Nový úkol pro tento uzel"
                  aria-label="Nový úkol"
                  className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--color-text-dim)] opacity-0 transition-opacity hover:bg-[var(--color-bg)] hover:text-[var(--color-text)] group-hover:opacity-100"
                >
                  <Plus size={11} />
                </span>
              )}
              {/* biome-ignore lint/a11y/useSemanticElements: see note above */}
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseNode(r.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    onCloseNode(r.id);
                  }
                }}
                title="Zavřít uzel"
                aria-label="Zavřít uzel"
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--color-text-dim)] opacity-0 transition-opacity hover:bg-[var(--color-bg)] hover:text-[var(--color-text)] group-hover:opacity-100"
              >
                <X size={11} />
              </span>
            </div>

            {persistentSessions.length > 0 ? (
              <ul className="ml-3 flex flex-col gap-0.5 border-l border-[var(--color-border)] py-0.5 pl-1">
                {persistentSessions.map((s) => {
                  const chip = sessionRowChip(s.state, s.waiting_since);
                  return (
                    <li key={s.id}>
                      {/* biome-ignore lint/a11y/useSemanticElements: nested <button> is invalid HTML; role+tabIndex is the documented workaround */}
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => onOpenSessionChat(r.id, s.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onOpenSessionChat(r.id, s.id);
                          }
                        }}
                        title={chip.label}
                        className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px] text-[var(--color-text-dim)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
                      >
                        <span
                          role="img"
                          aria-label={chip.label}
                          className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${chip.pulsing ? "animate-pulse" : ""}`}
                          style={{ background: chip.color }}
                        />
                        <span className="min-w-0 flex-1 truncate text-[12px]">{s.name}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
