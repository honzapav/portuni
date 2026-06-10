// Left column of the workspace view. Lists every node that currently has
// at least one PTY session, in the order the first session was created.
// A node disappears the instant its last session is closed (no pinning
// in v1 — see spec).
//
// When a node is selected, its sessions expand inline as sub-rows so the
// user can pick which session to view, close one, or open a new one
// without leaving the left column. Previously these controls lived in a
// separate tab strip at the top of the middle column; consolidating
// here means the middle column is just the terminal canvas.
import { Plus, X } from "lucide-react";
import {
  countSessionsByNode,
  isSessionActive,
  nodeIsActive,
  type TerminalSession,
} from "../lib/sessions";
import { useNowTick } from "../lib/use-now-tick";

type NodeRow = {
  id: string;
  name: string;
  type: string;
};

type Props = {
  sessions: TerminalSession[];
  selectedNodeId: string | null;
  activeSessionIdByNode: Record<string, string>;
  onSelectNode: (id: string) => void;
  onSelectSession: (nodeId: string, sessionId: string) => void;
  onCloseSession: (id: string) => void;
  onNewSession: (nodeId: string) => void;
};

function nodeTypeVar(type: string): string {
  const known = ["organization", "project", "process", "area", "principle"];
  return known.includes(type) ? `var(--color-node-${type})` : "var(--color-node-default)";
}

export default function WorkspaceNodeList({
  sessions,
  selectedNodeId,
  activeSessionIdByNode,
  onSelectNode,
  onSelectSession,
  onCloseSession,
  onNewSession,
}: Props) {
  // Tick locally -- only this list needs a clock for the activity dots.
  // In App the same interval used to re-render the entire tree every second.
  const now = useNowTick();
  const counts = countSessionsByNode(sessions);

  // Stable order: first-seen wins. We can derive this from sessions[]
  // because they're appended chronologically.
  const seen = new Set<string>();
  const rows: NodeRow[] = [];
  for (const s of sessions) {
    if (seen.has(s.nodeId)) continue;
    seen.add(s.nodeId);
    rows.push({ id: s.nodeId, name: s.nodeName, type: s.nodeType });
  }

  if (rows.length === 0) {
    return (
      <div className="px-4 py-6 text-[13px] text-[var(--color-text-dim)]">
        Žádné aktivní sessions.
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-0.5 px-2 py-2">
      {rows.map((r) => {
        const count = counts.get(r.id) ?? 0;
        const active = nodeIsActive(sessions, r.id, now);
        const selected = r.id === selectedNodeId;
        const nodeSessions = selected
          ? sessions.filter((s) => s.nodeId === r.id)
          : [];
        const activeSessionId = activeSessionIdByNode[r.id] ?? null;
        return (
          <li key={r.id}>
            <button
              onClick={() => onSelectNode(r.id)}
              className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                selected
                  ? "bg-[var(--color-surface)] text-[var(--color-text)]"
                  : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
              }`}
            >
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: nodeTypeVar(r.type) }}
                aria-hidden
              />
              <span className="flex-1 truncate">{r.name}</span>
              <span className="font-mono text-[11px] text-[var(--color-text-dim)]">{count}</span>
              <span
                role="img"
                className={`inline-block h-1.5 w-1.5 rounded-full ${active ? "bg-emerald-500" : "bg-amber-500/70"}`}
                title={active ? "Agent píše" : "Idle"}
                aria-label={active ? "active" : "idle"}
              />
            </button>
            {selected && nodeSessions.length > 0 ? (
              <ul className="ml-3 flex flex-col gap-0.5 border-l border-[var(--color-border)] pl-1 py-0.5">
                {nodeSessions.map((s, idx) => {
                  const sessActive = isSessionActive(now, s.lastOutputAt);
                  const sessSelected = s.id === activeSessionId;
                  return (
                    <li key={s.id} className="flex">
                      <button
                        type="button"
                        onClick={() => onSelectSession(r.id, s.id)}
                        className={`group flex flex-1 items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px] transition-colors ${
                          sessSelected
                            ? "bg-[var(--color-bg)] text-[var(--color-text)]"
                            : "text-[var(--color-text-dim)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
                        }`}
                      >
                        <span
                          role="img"
                          aria-label={sessActive ? "active" : "idle"}
                          className={`inline-block h-1.5 w-1.5 rounded-full ${sessActive ? "bg-emerald-500" : "bg-amber-500/70"}`}
                        />
                        <span className="font-mono text-[11.5px]">#{idx + 1}</span>
                        <span className="flex-1" />
                        {/*
                          The X icon is rendered inline so we don't need a
                          nested <button>. We split out a span-with-role
                          for the click target — same a11y pattern used in
                          TerminalTabs' old strip — so the outer button's
                          onClick (select session) and the inner click
                          (close session) are distinct.
                        */}
                        {/* biome-ignore lint/a11y/useSemanticElements: nested <button> inside <button> is invalid HTML; role+tabIndex is the documented workaround */}
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            onCloseSession(s.id);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              e.stopPropagation();
                              onCloseSession(s.id);
                            }
                          }}
                          title="Zavřít session"
                          aria-label="Zavřít session"
                          className="inline-flex h-4 w-4 items-center justify-center rounded text-[var(--color-text-dim)] opacity-0 transition-opacity hover:bg-[var(--color-bg)] hover:text-[var(--color-text)] group-hover:opacity-100"
                        >
                          <X size={10} />
                        </span>
                      </button>
                    </li>
                  );
                })}
                <li>
                  <button
                    type="button"
                    onClick={() => onNewSession(r.id)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] text-[var(--color-text-dim)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
                    title="Nová session pro tento uzel"
                  >
                    <Plus size={12} />
                    Nová session
                  </button>
                </li>
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
