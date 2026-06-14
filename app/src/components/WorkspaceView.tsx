// 2-column layout shell: terminal tabs on the left, the selected node's
// detail (the existing DetailPane in embedded mode) on the right. The
// node-with-sessions list moved into the global Sidebar (workspace
// view), so this component no longer owns a left column. The
// detail-collapse state lives here so the layout owns its own UI state.

import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { GraphPayload, GraphNode, NodeDetail } from "../types";
import type { TerminalSession } from "../lib/sessions";
import type { Theme } from "../lib/theme";
import type { FileEditor } from "../lib/use-file-editor";
import TerminalTabs from "./TerminalTabs";
import WorkspaceEmpty from "./WorkspaceEmpty";
import DetailPane from "./DetailPane";
import EditorPane, { type EditorMode } from "./EditorPane";

type Props = {
  graph: GraphPayload | null;
  sessions: TerminalSession[];
  // Theme drives xterm colors inside TerminalPane; the rest of the
  // workspace uses CSS variables, but xterm holds a snapshot of those
  // colors that has to be re-applied imperatively when the user
  // toggles dark/light at runtime.
  theme: Theme;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  activeSessionIdByNode: Record<string, string>;
  onCloseSession: (sessionId: string) => void;
  onOpenSessionFromPicker: (node: GraphNode) => void;
  // Detail data for the right column. Fetched in App.tsx whenever
  // selectedNodeId changes.
  nodeDetail: NodeDetail | null;
  nodeDetailLoading: boolean;
  nodeDetailError: string | null;
  agentCommand: string;
  terminalLaunch: string;
  onOpenTerminal: (nodeId: string) => void | Promise<void>;
  // Refetch graph + this view's node detail after an edit. DetailPane's
  // edit / lifecycle / sync flows all funnel through this.
  onMutate: () => Promise<void>;
  // Source-editor wiring. When a file is open for the selected node, the
  // right column swaps DetailPane for EditorPane (Option C).
  editorFile: { nodeId: string; relPath: string } | null;
  // The single editor instance owned by App and shared across the pane
  // and the fullscreen shell. Lifting it here is what preserves unsaved
  // edits across the expand/collapse transition (and avoids a double GET).
  editor: FileEditor;
  editorFullscreen: boolean;
  editorMode: EditorMode;
  onEditorModeChange: (m: EditorMode) => void;
  onOpenFile: (nodeId: string, relPath: string) => void;
  onCloseEditor: () => void;
  onExpandEditor: () => void;
};

export default function WorkspaceView({
  sessions,
  selectedNodeId,
  onSelectNode,
  theme,
  graph,
  activeSessionIdByNode,
  onCloseSession,
  onOpenSessionFromPicker,
  nodeDetail,
  nodeDetailLoading,
  nodeDetailError,
  agentCommand,
  terminalLaunch,
  onOpenTerminal,
  onMutate,
  editorFile,
  editor,
  editorFullscreen,
  editorMode,
  onEditorModeChange,
  onOpenFile,
  onCloseEditor,
  onExpandEditor,
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

  // The editor occupies the right column only when its open file belongs to
  // the currently-selected node AND we're not in fullscreen. When fullscreen,
  // App renders EditorFullscreen instead and the pane must not mount a second
  // editor shell (that would double-render the shared instance's body).
  const showEditor =
    !editorFullscreen &&
    editorFile != null &&
    selectedNodeId != null &&
    editorFile.nodeId === selectedNodeId;

  return (
    <div className="flex h-full w-full overflow-hidden bg-[var(--color-bg)]">
      <main className="flex min-w-0 flex-1 flex-col">
        {sessions.length === 0 ? (
          <WorkspaceEmpty graph={graph} onPick={(n) => onOpenSessionFromPicker(n)} />
        ) : (
          // TerminalTabs receives every live session and decides
          // internally which pane is visible. Mounting all panes across
          // node switches keeps each xterm's scrollback intact — see
          // the comment at the top of TerminalTabs.tsx. Per-node tab
          // controls (select / close / new) live in the global Sidebar
          // (workspace view) now, not in this component.
          <TerminalTabs
            sessions={sessions}
            selectedNodeId={selectedNodeId}
            activeSessionIdByNode={activeSessionIdByNode}
            onCloseSession={onCloseSession}
            theme={theme}
          />
        )}
      </main>
      {detailVisible ? (
        <aside className="flex h-full w-[40vw] min-w-[440px] shrink-0 flex-col border-l border-[var(--color-border)]">
          {showEditor && editorFile ? (
            <EditorPane
              editor={editor}
              relPath={editorFile.relPath}
              mode={editorMode}
              onModeChange={onEditorModeChange}
              onClose={onCloseEditor}
              onExpand={onExpandEditor}
            />
          ) : selectedNodeId ? (
            // Collapse chevron is rendered inside DetailPane's header
            // (left side) so it doesn't overlap the Upravit button.
            <DetailPane
              node={nodeDetail}
              graph={graph}
              loading={nodeDetailLoading}
              error={nodeDetailError}
              onSelect={(id) => onSelectNode(id)}
              canGoBack={false}
              terminalLaunch={terminalLaunch}
              onBack={() => {
                // No-op: workspace doesn't keep a back-stack like graph does.
              }}
              onMutate={onMutate}
              agentCommand={agentCommand}
              onOpenTerminal={onOpenTerminal}
              onOpenFile={onOpenFile}
              embedded
              onCollapse={toggleDetail}
            />
          ) : (
            <div className="relative flex h-full items-center justify-center px-4 text-center text-[13px] text-[var(--color-text-dim)]">
              <button
                onClick={toggleDetail}
                title="Skrýt detail"
                aria-label="Skrýt detail"
                className="absolute left-2 top-2 flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-dim)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
              >
                <ChevronRight size={14} />
              </button>
              Vyber uzel vlevo nebo otevři terminál.
            </div>
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
