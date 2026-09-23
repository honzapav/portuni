// Workspace layout shell (docs/superpowers/specs/2026-09-15-task-surface-
// design.md, rule 4: "the node detail is the right aside whenever a thread
// is open, and takes the centre only when the node has none"):
//
//   - selected node has an open session -> SessionChat centre, node detail /
//                                          editor in the right aside
//   - selected node, no session        -> the node's detail / editor centre
//   - nothing selected, something open -> "pick a node" hint
//   - nothing open at all              -> the search picker (WorkspaceEmpty)
//
// The open-node list and its session sub-rows live in the global Sidebar
// (workspace view); this component owns the centre + aside layout and the
// aside's collapse state.
//
// Every thread open in this window keeps a mounted SessionChat (#429, the
// spec's "mounted for every open thread and toggled"); only the shown one
// is visible. A hidden pane is hidden with `visibility: hidden`, not
// `display: none`: display none destroys the layout box, and with it the
// transcript's scroll offset -- the very thing keeping the pane mounted is
// for. `inert` keeps a hidden pane out of the tab order and out of reach
// of the pointer.

import { lazy, Suspense, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { GraphPayload, GraphNode, NodeDetail, SessionRunRow, SessionSummary } from "../types";
import type { SessionsClient, SessionStateMessage } from "../lib/sessions-client";
import type { SessionStore } from "../lib/session-store";
import { shownChatSessionId } from "../lib/session-views";
import type { FileEditor } from "../lib/use-file-editor";
import { scopedKey } from "../lib/workspace-storage";
import WorkspaceEmpty from "./WorkspaceEmpty";
import DetailPane from "./DetailPane";
import EditorPane, { type EditorMode } from "./EditorPane";

// SessionChat pulls in the AI Elements/shadcn/Streamdown stack (radix-ui,
// shiki, motion, streamdown...), dead weight until a thread is actually
// open -- lazy-loaded so it lands in its own chunk instead of every
// window's startup bundle.
const SessionChat = lazy(() => import("./SessionChat"));

type Props = {
  graph: GraphPayload | null;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  // Open a node from the empty-state picker.
  onOpenNodeFromPicker: (node: GraphNode) => void;
  // How many nodes are open, so the empty-state picker only shows when the
  // workspace is truly empty.
  openNodeCount: number;
  // Detail data for the selected node. Fetched in App.tsx whenever
  // selectedNodeId changes.
  nodeDetail: NodeDetail | null;
  nodeDetailLoading: boolean;
  nodeDetailError: string | null;
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
  // Runner batch (#342): the selected node's persistent session, when one
  // is running/waiting/suspended -- SessionChat then takes the centre and
  // the node detail moves to the aside. Fetched by App.tsx alongside
  // nodeDetail; null when the node has no live session or nothing is
  // selected.
  openSession: SessionSummary | null;
  // Every thread open in this window, in a stable order (#429): each one
  // keeps a mounted chat so switching threads keeps its scroll position,
  // its streaming buffers and its composer draft, and costs no
  // re-subscribe. Includes `openSession`; App.tsx derives it from the
  // session store with lib/session-selectors.ts's selectMountedThreads.
  mountedSessions: readonly SessionSummary[];
  sessionsClient: SessionsClient;
  // The window's one record per thread (#466): SessionChat reads its own
  // row out of it by id and writes every change back into it, so nothing
  // here carries a session object for it to keep in step.
  sessionStore: SessionStore;
  onSessionStarted: (result: { session: SessionSummary; run: SessionRunRow | null }) => void;
  // Relace tab's "Otevřít chat" (#343), threaded through to DetailPane.
  onOpenChat: (nodeId: string, sessionId: string) => void;
  liveSessionStates: Readonly<Record<string, SessionStateMessage>>;
};

export default function WorkspaceView({
  selectedNodeId,
  onSelectNode,
  graph,
  onOpenNodeFromPicker,
  openNodeCount,
  nodeDetail,
  nodeDetailLoading,
  nodeDetailError,
  onMutate,
  editorFile,
  editor,
  editorFullscreen,
  editorMode,
  onEditorModeChange,
  onOpenFile,
  onCloseEditor,
  onExpandEditor,
  openSession,
  mountedSessions,
  sessionsClient,
  sessionStore,
  onSessionStarted,
  onOpenChat,
  liveSessionStates,
}: Props) {
  const [detailVisible, setDetailVisible] = useState<boolean>(() => {
    return localStorage.getItem(scopedKey("workspace.detailVisible")) !== "false";
  });
  const toggleDetail = () => {
    setDetailVisible((v) => {
      localStorage.setItem(scopedKey("workspace.detailVisible"), String(!v));
      return !v;
    });
  };

  // The editor occupies the detail surface only when its open file belongs to
  // the currently-selected node AND we're not in fullscreen. When fullscreen,
  // App renders EditorFullscreen instead and the pane must not mount a second
  // editor shell (that would double-render the shared instance's body).
  const showEditor =
    !editorFullscreen &&
    editorFile != null &&
    selectedNodeId != null &&
    editorFile.nodeId === selectedNodeId;

  // A running/waiting session renders as chat; a suspended one still does
  // (the composer just disables, with a Nahodit affordance); a draft does
  // too -- a thread opens empty (#374, rule 5), composer focused, nothing
  // to show yet. closed and archived fall through to the plain node
  // detail, since those are history, not something to keep steering.

  // The node surface: EditorPane when a file is open for this node, else
  // DetailPane. Centre-stage when the node has no thread, the right aside
  // when it has one (`collapsible` adds the aside's collapse chevron).
  const nodeSurface = (collapsible: boolean) =>
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
        onBack={() => {
          // No-op: workspace doesn't keep a back-stack like graph does.
        }}
        onMutate={onMutate}
        onOpenFile={onOpenFile}
        embedded
        onCollapse={collapsible ? toggleDetail : undefined}
        onSessionStarted={onSessionStarted}
        onOpenChat={onOpenChat}
        liveSessionStates={liveSessionStates}
      />
    );

  // Which pane is on screen. Null (nothing selected, or the selected node
  // has no thread) leaves every pane hidden and the node surface centre-
  // stage, without unmounting anything.
  const shownSessionId = shownChatSessionId(selectedNodeId, openSession);

  // One pane per open thread, each keyed on its session id, so a switch
  // is a visibility flip -- React keeps every keyed child mounted and
  // SessionChat's subscribe effect (keyed on session.id) never re-runs.
  const chats =
    mountedSessions.length > 0 ? (
      <Suspense fallback={null}>
        {mountedSessions.map((session) => {
          const visible = session.id === shownSessionId;
          return (
            <div
              key={session.id}
              className="absolute inset-0 flex flex-col"
              style={visible ? undefined : { visibility: "hidden", pointerEvents: "none" }}
              aria-hidden={visible ? undefined : true}
              inert={visible ? undefined : true}
            >
              <SessionChat
                sessionId={session.id}
                sessionStore={sessionStore}
                sessionsClient={sessionsClient}
                onOpenFile={session.node_id ? (relPath) => onOpenFile(session.node_id!, relPath) : undefined}
              />
            </div>
          );
        })}
      </Suspense>
    ) : null;

  return (
    <div className="flex h-full w-full overflow-hidden bg-[var(--color-bg)]">
      <main className="relative flex min-w-0 flex-1 flex-col">
        {/* Every open thread, mounted; the shown one fills the centre,
            the rest are hidden panes at the same geometry. */}
        {chats}

        {/* No thread shown: the node's detail / editor centre-stage, in a
            readable column. */}
        {selectedNodeId && !shownSessionId && (
          <div className="absolute inset-0 flex justify-center">
            <div className="flex h-full w-full max-w-[920px] flex-col border-x border-[var(--color-border)]">
              {nodeSurface(false)}
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

      {/* Right aside -- only when a thread occupies the centre. Without one
          the node surface IS the centre, so there is no aside. */}
      {selectedNodeId &&
        shownSessionId &&
        (detailVisible ? (
          <aside className="flex h-full w-[40vw] min-w-[440px] shrink-0 flex-col border-l border-[var(--color-border)]">
            {nodeSurface(true)}
          </aside>
        ) : (
          <Button
            variant="ghost"
            onClick={toggleDetail}
            title="Zobrazit detail uzlu"
            aria-label="Zobrazit detail uzlu"
            className="h-full w-6 shrink-0 rounded-none border-l border-[var(--color-border)] bg-[var(--color-surface)] px-0 text-muted-foreground hover:bg-[var(--color-surface-2)]"
          >
            <ChevronLeft />
          </Button>
        ))}
    </div>
  );
}
