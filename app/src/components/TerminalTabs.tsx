// Middle column. Mounts one TerminalPane per *every* live session —
// across all nodes — and toggles display:none on the ones that aren't
// the visible (selectedNode + activeSession) pair. The per-node session
// strip used to live at the top of this column; it has moved into
// WorkspaceNodeList (left column) so the middle column is a pure
// terminal canvas with no chrome.
//
// Why mount across nodes too: switching the left-pane node used to drop
// the previous node's panes out of the React tree, which fired
// xterm.dispose() and lost the scrollback. The PTY survives on the
// backend (pty.rs keeps it alive across duplicate spawns) so the next
// remount only ever saw new output — the user saw the terminal "go
// blank" when bouncing between nodes. Keeping every pane mounted means
// the xterm buffer survives node switches too.
import TerminalPane from "./TerminalPane";
import type { TerminalSession } from "../lib/sessions";
import type { Theme } from "../lib/theme";

type Props = {
  // ALL live sessions, not just for the selected node. Filtering happens
  // inside this component so non-visible panes can still be mounted.
  sessions: TerminalSession[];
  selectedNodeId: string | null;
  activeSessionIdByNode: Record<string, string>;
  onCloseSession: (id: string) => void;
  theme: Theme;
};

export default function TerminalTabs({
  sessions,
  selectedNodeId,
  activeSessionIdByNode,
  onCloseSession,
  theme,
}: Props) {
  const sessionsForNode = selectedNodeId
    ? sessions.filter((s) => s.nodeId === selectedNodeId)
    : [];
  const activeSessionId = selectedNodeId
    ? (activeSessionIdByNode[selectedNodeId] ?? null)
    : null;

  return (
    <div className="relative h-full min-h-0">
      {/*
        All sessions are mounted at once. Visibility is decided by
        (selectedNodeId, activeSessionId) — anything else gets
        display:none. TerminalPane's own active-fit effect refits xterm
        whenever its `active` prop flips true, so coming back from a
        hidden tab redraws at the current container size.
      */}
      {sessions.map((s) => {
        const visible =
          s.nodeId === selectedNodeId && s.id === activeSessionId;
        return (
          <div
            key={s.id}
            className="absolute inset-0"
            style={{ display: visible ? "block" : "none" }}
          >
            <TerminalPane
              sessionId={s.id}
              cwd={s.cwd}
              command={s.command}
              active={visible}
              theme={theme}
              onExit={() => onCloseSession(s.id)}
            />
          </div>
        );
      })}
      {selectedNodeId && sessionsForNode.length === 0 ? (
        <div className="flex h-full items-center justify-center text-[13px] text-[var(--color-text-dim)]">
          Žádné sessions pro tento uzel.
        </div>
      ) : null}
      {!selectedNodeId ? (
        <div className="flex h-full items-center justify-center text-[13px] text-[var(--color-text-dim)]">
          Vyber uzel vlevo nebo otevři terminál z detailu.
        </div>
      ) : null}
    </div>
  );
}
