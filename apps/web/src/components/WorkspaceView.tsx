// Workspace layout shell. What fills the center depends on the selected node:
//
//   - selected node HAS terminals  -> terminal canvas center, detail aside (right)
//   - selected node has NO terminal -> the node's detail / editor takes center
//     stage (Option A: a node's "home" is its detail; a terminal is optional)
//   - nothing selected, something open -> "pick a node" hint
//   - nothing open at all            -> the search picker (WorkspaceEmpty)
//
// The open-node list and its terminal tabs live in the global Sidebar
// (workspace view); this component owns only the center + right-detail layout
// and the detail-collapse state.

import { useState } from "react";
import { ChevronLeft } from "lucide-react";
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
  // Open a node (no terminal) from the empty-state picker.
  onOpenNodeFromPicker: (node: GraphNode) => void;
  // How many nodes are open, so the empty-state picker only shows when the
  // workspace is truly empty (a node can be open without any session).
  openNodeCount: number;
  // Detail data for the selected node. Fetched in App.tsx whenever
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
  // detail surface swaps DetailPane for EditorPane (Option C).
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
  onOpenNodeFromPicker,
  openNodeCount,
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

  // Does the selected node actually have a terminal? That decides whether the
  // center is the terminal canvas (detail to the side) or the detail itself.
  const selectedHasSessions =
    selectedNodeId != null && sessions.some((s) => s.nodeId === selectedNodeId);

  // The editor occupies the detail surface only when its open file belongs to
  // the currently-selected node AND we're not in fullscreen. When fullscreen,
  // App renders EditorFullscreen instead and the pane must not mount a second
  // editor shell (that would double-render the shared instance's body).
  const showEditor =
    !editorFullscreen &&
    editorFile != null &&
    selectedNodeId != null &&
    editorFile.nodeId === selectedNodeId;

  // The detail surface (DetailPane, or EditorPane when a file is open),
  // rendered either center-stage (no terminal) or in the right aside (with a
  // terminal). `collapsible` adds the collapse chevron used only in the aside.
  const detailSurface = (collapsible: boolean) =>
    showEditor && editorFile ? (
      <EditorPane
        editor={editor}
        relPath={editorFile.relPath}
        mode={editorMode}
        onModeChange={onEditorModeChange}
        onClose={onCloseEditor}
        onExpand={onExpandEditor}
      />
    ) : (
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
        onCollapse={collapsible ? toggleDetail : undefined}
      />
    );

  return (
    <div className="flex h-full w-full overflow-hidden bg-[var(--color-bg)]">
      <main className="relative flex min-w-0 flex-1 flex-col">
        {/*
          Terminal canvas. Mounted whenever ANY session exists so every
          xterm's scrollback survives switching to a terminal-less node
          (see the comment atop TerminalTabs.tsx); only VISIBLE when the
          selected node actually has sessions.
        */}
        {sessions.length > 0 && (
          <div
            className={selectedHasSessions ? "absolute inset-0" : "hidden"}
            aria-hidden={!selectedHasSessions}
          >
            <TerminalTabs
              sessions={sessions}
              selectedNodeId={selectedNodeId}
              activeSessionIdByNode={activeSessionIdByNode}
              onCloseSession={onCloseSession}
              theme={theme}
            />
          </div>
        )}

        {/* Option A: a selected node with no terminal shows its detail /
            files (or the editor) center-stage, in a readable column. */}
        {!selectedHasSessions && selectedNodeId && (
          <div className="absolute inset-0 flex justify-center">
            <div className="flex h-full w-full max-w-[920px] flex-col border-x border-[var(--color-border)]">
              {detailSurface(false)}
            </div>
          </div>
        )}

        {/* Nothing selected. Show the picker only when the workspace is truly
            empty; otherwise nudge the user to pick from the left. */}
        {!selectedNodeId &&
          (openNodeCount === 0 ? (
            <WorkspaceEmpty graph={graph} onPick={(n) => onOpenNodeFromPicker(n)} />
          ) : (
            <div className="flex h-full items-center justify-center text-[13px] text-[var(--color-text-dim)]">
              Vyber uzel vlevo.
            </div>
          ))}
      </main>

      {/* Right detail aside -- only when a terminal occupies the center. For a
          terminal-less node the detail IS the center, so there's no aside. */}
      {selectedHasSessions &&
        (detailVisible ? (
          <aside className="flex h-full w-[40vw] min-w-[440px] shrink-0 flex-col border-l border-[var(--color-border)]">
            {detailSurface(true)}
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
        ))}
    </div>
  );
}
