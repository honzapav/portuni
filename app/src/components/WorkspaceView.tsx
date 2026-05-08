// 3-column layout shell: workspace node list on the left, terminal tabs
// in the middle, the selected node's detail (the existing DetailPane in
// embedded mode) on the right. The detail-collapse state lives here so
// the layout owns its own UI state.

import { useState } from "react";
import { ChevronLeft, X } from "lucide-react";
import type { GraphPayload, GraphNode, NodeDetail } from "../types";
import type { TerminalSession } from "../lib/sessions";
import WorkspaceNodeList from "./WorkspaceNodeList";
import TerminalTabs from "./TerminalTabs";
import WorkspaceEmpty from "./WorkspaceEmpty";
import DetailPane from "./DetailPane";

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
  // Detail data for the right column. Fetched in App.tsx whenever
  // selectedNodeId changes.
  nodeDetail: NodeDetail | null;
  nodeDetailLoading: boolean;
  nodeDetailError: string | null;
  agentCommand: string;
  onOpenTerminal: (nodeId: string) => void;
  // Refetch graph + this view's node detail after an edit. DetailPane's
  // edit / lifecycle / sync flows all funnel through this.
  onMutate: () => Promise<void>;
};

export default function WorkspaceView({
  sessions,
  selectedNodeId,
  onSelectNode,
  now,
  graph,
  activeSessionIdByNode,
  onSetActiveSession,
  onCloseSession,
  onOpenSessionFromPicker,
  onNewSessionForCurrentNode,
  nodeDetail,
  nodeDetailLoading,
  nodeDetailError,
  agentCommand,
  onOpenTerminal,
  onMutate,
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
        {sessions.length === 0 ? (
          <WorkspaceEmpty graph={graph} onPick={(n) => onOpenSessionFromPicker(n)} />
        ) : selectedNodeId ? (
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
        <aside className="flex h-full w-[40vw] min-w-[440px] shrink-0 flex-col border-l border-[var(--color-border)]">
          {selectedNodeId ? (
            <DetailPane
              node={nodeDetail}
              graph={graph}
              loading={nodeDetailLoading}
              error={nodeDetailError}
              onSelect={(id) => onSelectNode(id)}
              canGoBack={false}
              onBack={() => {}}
              onMutate={onMutate}
              agentCommand={agentCommand}
              onOpenTerminal={onOpenTerminal}
              onHide={toggleDetail}
              embedded
            />
          ) : (
            <>
              <div className="flex items-center justify-end border-b border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2">
                <button
                  onClick={toggleDetail}
                  title="Skrýt detail"
                  aria-label="Skrýt detail"
                  className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-dim)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
                >
                  <X size={13} />
                </button>
              </div>
              <div className="flex flex-1 items-center justify-center px-4 text-center text-[13px] text-[var(--color-text-dim)]">
                Vyber uzel vlevo nebo otevři terminál.
              </div>
            </>
          )}
        </aside>
      ) : (
        <button
          onClick={toggleDetail}
          title="Zobrazit detail"
          aria-label="Zobrazit detail"
          className="flex h-full w-6 shrink-0 items-center justify-center border-l border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
        >
          <ChevronLeft size={14} />
        </button>
      )}
    </div>
  );
}
