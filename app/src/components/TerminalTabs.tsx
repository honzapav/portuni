// Middle column. Renders one tab per session for the currently selected
// node, plus a "+" button (re-using the parent's "open" callback). Every
// pane is mounted; only the active one is visible. Background panes
// keep their PTY alive and their xterm scrollback intact.
import { X, Plus } from "lucide-react";
import TerminalPane from "./TerminalPane";
import { isSessionActive, type TerminalSession } from "../lib/sessions";

type Props = {
  sessionsForNode: TerminalSession[];   // already filtered to one node
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onCloseSession: (id: string) => void;
  onNewSession: () => void;
  now: number;
};

export default function TerminalTabs({
  sessionsForNode,
  activeSessionId,
  onSelectSession,
  onCloseSession,
  onNewSession,
  now,
}: Props) {
  if (sessionsForNode.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-[var(--color-text-dim)]">
        Žádné sessions pro tento uzel.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-2">
        {sessionsForNode.map((s, idx) => {
          const active = isSessionActive(now, s.lastOutputAt);
          const selected = s.id === activeSessionId;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onSelectSession(s.id)}
              className={`flex items-center gap-1.5 rounded-t-md px-3 py-1.5 text-[12.5px] transition-colors ${
                selected
                  ? "bg-[var(--color-bg)] text-[var(--color-text)]"
                  : "text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
              }`}
            >
              <span
                role="img"
                aria-label={active ? "active" : "idle"}
                className={`inline-block h-1.5 w-1.5 rounded-full ${active ? "bg-emerald-500" : "bg-amber-500/70"}`}
              />
              <span className="font-mono">#{idx + 1}</span>
              {/* biome-ignore lint/a11y/useSemanticElements: nested <button> inside <button> is invalid HTML; role+tabIndex pattern is the correct workaround */}
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  // window.confirm() is not implemented in the Tauri
                  // webview on macOS — calling it silently no-ops, so the
                  // user clicks X and nothing happens. Closing on a single
                  // explicit X click is the simplest reliable fix; the
                  // session is recoverable by re-opening from the node.
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
                className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded text-[var(--color-text-dim)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
                title="Zavřít session"
                aria-label="Zavřít session"
              >
                <X size={11} />
              </span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={onNewSession}
          className="ml-1 flex items-center gap-1 rounded-md px-2 py-1 text-[12.5px] text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
          title="Nová session pro tento uzel"
        >
          <Plus size={12} />
          Nová
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        {sessionsForNode.map((s) => {
          const active = s.id === activeSessionId;
          return (
            <div
              key={s.id}
              className="absolute inset-0"
              style={{ display: active ? "block" : "none" }}
            >
              <TerminalPane
                sessionId={s.id}
                cwd={s.cwd}
                command={s.command}
                active={active}
                onExit={() => onCloseSession(s.id)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
