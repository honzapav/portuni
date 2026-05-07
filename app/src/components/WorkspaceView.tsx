// 3-column layout shell. In this task it just renders placeholders — the
// real left/middle/right column components arrive in Tasks 6–8. The
// detail-collapse state lives here so the layout owns its own UI state.

import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { GraphPayload, GraphNode } from "../types";
import type { TerminalSession } from "../lib/sessions";
import WorkspaceNodeList from "./WorkspaceNodeList";
import TerminalTabs from "./TerminalTabs";

type Props = {
  graph: GraphPayload | null;
  sessions: TerminalSession[];
  now: number;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  activeSessionIdByNode: Record<string, string>;
  onSetActiveSession: (nodeId: string, sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onOpenSessionFromPicker: (node: GraphNode) => void;
  onNewSessionForCurrentNode: (nodeId: string) => void;
  detailNodeId: string | null;
};

export default function WorkspaceView({
  sessions,
  selectedNodeId,
  onSelectNode,
  now,
  graph: _graph,
  activeSessionIdByNode,
  onSetActiveSession,
  onCloseSession,
  onOpenSessionFromPicker: _onOpenSessionFromPicker,
  onNewSessionForCurrentNode,
  detailNodeId: _detailNodeId,
}: Props) {
  const [detailVisible, setDetailVisible] = useState<boolean>(() => {
    return localStorage.getItem("portuni:workspace.detailVisible") !== "false";
  });
  const toggleDetail = () => {
    setDetailVisible((v) => {
      localStorage.setItem("portuni:workspace.detailVisible", String(!v));
      return !v;
    });
  };

  return (
    <div className="flex h-full w-full overflow-hidden bg-[var(--color-bg)]">
      <aside className="flex w-[260px] shrink-0 flex-col border-r border-[var(--color-border)]">
        <div className="px-4 py-3 text-[12px] font-semibold uppercase tracking-wider text-[var(--color-text-dim)]">
          Práce
        </div>
        <div className="flex-1 overflow-y-auto scroll-thin">
          <WorkspaceNodeList
            sessions={sessions}
            selectedNodeId={selectedNodeId}
            onSelectNode={onSelectNode}
            now={now}
          />
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        {selectedNodeId ? (
          <TerminalTabs
            sessionsForNode={sessions.filter((s) => s.nodeId === selectedNodeId)}
            activeSessionId={activeSessionIdByNode[selectedNodeId] ?? null}
            onSelectSession={(id) => onSetActiveSession(selectedNodeId, id)}
            onCloseSession={onCloseSession}
            onNewSession={() => onNewSessionForCurrentNode(selectedNodeId)}
            now={now}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-[14px] text-[var(--color-text-dim)]">
            Vyber uzel vlevo nebo otevři terminál z detailu.
          </div>
        )}
      </main>
      {detailVisible ? (
        <aside className="flex w-[360px] shrink-0 flex-col border-l border-[var(--color-border)]">
          <div className="flex items-center justify-between px-4 py-2">
            <span className="text-[12px] font-semibold uppercase tracking-wider text-[var(--color-text-dim)]">
              Detail
            </span>
            <button onClick={toggleDetail} title="Skrýt detail">
              <ChevronRight size={14} />
            </button>
          </div>
          <div className="flex-1 px-4 text-[13px] text-[var(--color-text-dim)]">
            Detail placeholder
          </div>
        </aside>
      ) : (
        <button
          onClick={toggleDetail}
          title="Zobrazit detail"
          className="flex h-full w-6 shrink-0 items-center justify-center border-l border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
        >
          <ChevronLeft size={14} />
        </button>
      )}
    </div>
  );
}
