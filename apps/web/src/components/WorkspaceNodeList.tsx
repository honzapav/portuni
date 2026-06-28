// Left column of the workspace view. Lists every OPEN node -- whether or not
// it has a terminal -- in open-first order (see deriveWorkspaceNodeRows). A
// node stays until it is explicitly closed; opening a terminal is optional.
//
// Every node's sessions are shown at once as sub-rows (not only the selected
// node's), so any terminal in any node is a single click away without first
// selecting its parent. Each session tab can be renamed inline; the default
// label is "#<n>".
import { useState } from "react";
import { Plus, X, Pencil, Check } from "lucide-react";
import {
  nodeHasWorkingAgent,
  sessionIsAgentWorking,
  sessionDisplayName,
  type TerminalSession,
  type WorkspaceNodeRow,
} from "../lib/sessions";
import { useNowTick } from "../lib/use-now-tick";

type Props = {
  // The open set: open nodes ∪ nodes-with-sessions, already ordered.
  rows: WorkspaceNodeRow[];
  sessions: TerminalSession[];
  selectedNodeId: string | null;
  activeSessionIdByNode: Record<string, string>;
  onSelectNode: (id: string) => void;
  onSelectSession: (nodeId: string, sessionId: string) => void;
  onCloseSession: (id: string) => void;
  onCloseNode: (id: string) => void;
  onNewSession: (nodeId: string) => void;
  onRenameSession: (sessionId: string, label: string) => void;
};

function nodeTypeVar(type: string): string {
  const known = ["organization", "project", "process", "area", "principle"];
  return known.includes(type) ? `var(--color-node-${type})` : "var(--color-node-default)";
}

export default function WorkspaceNodeList({
  rows,
  sessions,
  selectedNodeId,
  activeSessionIdByNode,
  onSelectNode,
  onSelectSession,
  onCloseSession,
  onCloseNode,
  onNewSession,
  onRenameSession,
}: Props) {
  // Tick locally -- only this list needs a clock for the activity dots.
  // In App the same interval used to re-render the entire tree every second.
  const now = useNowTick();

  // The session being renamed inline (its id) and the working draft. Only
  // one tab is editable at a time.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const startRename = (s: TerminalSession) => {
    setEditingId(s.id);
    setDraft(s.label ?? "");
  };
  const commitRename = () => {
    if (editingId) onRenameSession(editingId, draft);
    setEditingId(null);
  };
  const cancelRename = () => setEditingId(null);

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
        const nodeSessions = sessions.filter((s) => s.nodeId === r.id);
        const active = nodeHasWorkingAgent(sessions, r.id, now);
        const selected = r.id === selectedNodeId;
        const activeSessionId = activeSessionIdByNode[r.id] ?? null;
        return (
          <li key={r.id}>
            {/* Node row. Outer <button> selects the node; the + / × controls
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
              <span
                role="img"
                className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${active ? "bg-emerald-500" : "bg-amber-500/70"}`}
                title={active ? "Agent pracuje" : "Idle"}
                aria-label={active ? "active" : "idle"}
              />
              {/* biome-ignore lint/a11y/useSemanticElements: see note above */}
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  onNewSession(r.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    onNewSession(r.id);
                  }
                }}
                title="Nový terminál pro tento uzel"
                aria-label="Nový terminál"
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--color-text-dim)] opacity-0 transition-opacity hover:bg-[var(--color-bg)] hover:text-[var(--color-text)] group-hover:opacity-100"
              >
                <Plus size={11} />
              </span>
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
                title="Zavřít uzel (a jeho terminály)"
                aria-label="Zavřít uzel"
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--color-text-dim)] opacity-0 transition-opacity hover:bg-[var(--color-bg)] hover:text-[var(--color-text)] group-hover:opacity-100"
              >
                <X size={11} />
              </span>
            </div>

            {nodeSessions.length > 0 ? (
              <ul className="ml-3 flex flex-col gap-0.5 border-l border-[var(--color-border)] py-0.5 pl-1">
                {nodeSessions.map((s, idx) => {
                  const sessActive = sessionIsAgentWorking(s, now);
                  // Highlight the tab that is actually on screen: the active
                  // session of the currently-selected node.
                  const sessVisible = selected && s.id === activeSessionId;
                  if (editingId === s.id) {
                    return (
                      <li key={s.id} className="flex items-center gap-1 px-2 py-1">
                        <input
                          autoFocus
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onBlur={commitRename}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              commitRename();
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              cancelRename();
                            }
                          }}
                          placeholder={`#${idx + 1}`}
                          className="min-w-0 flex-1 rounded border border-[var(--color-accent-dim)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
                        />
                        {/* Mousedown (not click) so it fires before the input's blur. */}
                        <button
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            commitRename();
                          }}
                          title="Uložit název"
                          aria-label="Uložit název"
                          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
                        >
                          <Check size={11} />
                        </button>
                      </li>
                    );
                  }
                  return (
                    <li key={s.id} className="relative flex">
                      {/* On-screen terminal: a straight accent rail tick on
                          the session tree's left rail. Replaces an inset
                          box-shadow that bent around the row's rounded
                          corners. */}
                      {sessVisible && (
                        <span
                          aria-hidden
                          className="pointer-events-none absolute inset-y-1 left-0 z-10 w-0.5 rounded-full bg-[var(--color-accent)]"
                        />
                      )}
                      {/* biome-ignore lint/a11y/useSemanticElements: nested <button> is invalid HTML; role+tabIndex is the documented workaround */}
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => onSelectSession(r.id, s.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onSelectSession(r.id, s.id);
                          }
                        }}
                        onDoubleClick={() => startRename(s)}
                        className={`group flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px] transition-colors ${
                          sessVisible
                            ? "bg-[var(--color-surface)] font-medium text-[var(--color-text)]"
                            : "text-[var(--color-text-dim)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
                        }`}
                      >
                        <span
                          role="img"
                          aria-label={sessActive ? "active" : "idle"}
                          title={sessActive ? "Agent pracuje" : "Idle"}
                          className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${sessActive ? "bg-emerald-500" : "bg-amber-500/70"}`}
                        />
                        <span
                          title={sessionDisplayName(s, idx)}
                          className={`min-w-0 flex-1 truncate text-[12px] ${
                            s.label
                              ? ""
                              : "font-mono"
                          } ${sessVisible ? "text-[var(--color-accent)]" : ""}`}
                        >
                          {sessionDisplayName(s, idx)}
                        </span>
                        {/* biome-ignore lint/a11y/useSemanticElements: see note above */}
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => {
                            e.stopPropagation();
                            startRename(s);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              e.stopPropagation();
                              startRename(s);
                            }
                          }}
                          title="Přejmenovat"
                          aria-label="Přejmenovat terminál"
                          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--color-text-dim)] opacity-0 transition-opacity hover:bg-[var(--color-bg)] hover:text-[var(--color-text)] group-hover:opacity-100"
                        >
                          <Pencil size={10} />
                        </span>
                        {/* biome-ignore lint/a11y/useSemanticElements: see note above */}
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => {
                            e.stopPropagation();
                            onCloseSession(s.id);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              e.stopPropagation();
                              onCloseSession(s.id);
                            }
                          }}
                          title="Zavřít terminál"
                          aria-label="Zavřít terminál"
                          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--color-text-dim)] opacity-0 transition-opacity hover:bg-[var(--color-bg)] hover:text-[var(--color-text)] group-hover:opacity-100"
                        >
                          <X size={10} />
                        </span>
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
