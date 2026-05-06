// Embedded xterm.js pane wired to the Rust pty backend (src-tauri/src/pty.rs).
//
// Lifecycle:
//   1. mount: open xterm, generate session id, invoke `pty_spawn` with
//      cwd + optional pre-command + initial cols/rows.
//   2. live: subscribe to `pty-data` events, forward to xterm.write;
//      forward xterm.onData to `pty_write`; forward resize observer
//      to `pty_resize`.
//   3. unmount or session id change: invoke `pty_kill` so the shell
//      process exits cleanly.
//
// Browser-mode fallback: if not running in Tauri (Vite dev), the
// component renders a placeholder explaining that the embedded
// terminal requires the desktop app. PTY is OS-level, so there's no
// reasonable web fallback.

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { isTauri } from "../lib/backend-url";

type Props = {
  // Used to scope the session id and re-spawn when the user switches
  // between nodes.
  nodeId: string;
  cwd: string;
  // Optional one-shot command to inject after the shell prompt appears
  // (e.g. `claude '<prompt>'`). Empty = bare interactive shell.
  command: string;
  onExit?: () => void;
};

type PtyDataPayload = { session_id: string; data: string };
type PtyExitPayload = { session_id: string; code: number | null };

export default function TerminalPane({ nodeId, cwd, command, onExit }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Stable ref so the cleanup closure sees the latest session id without
  // turning it into a state-induced re-render.
  const sessionIdRef = useRef<string>("");

  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    const container = containerRef.current;
    if (!container) return;

    // Unique per-mount session id. Switching nodes unmounts the prior
    // TerminalPane, which kills the prior session before spawning the
    // new one — so collisions can't happen even within the same second.
    const sessionId = `term_${nodeId}_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    sessionIdRef.current = sessionId;

    const term = new Terminal({
      fontFamily:
        '"JetBrains Mono", "SF Mono", Menlo, Consolas, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      // Match the surrounding Portuni dark/light theme via CSS vars.
      // xterm doesn't pick up CSS vars itself, but the body bg shows
      // through transparent regions; explicit theme keeps text legible.
      theme: {
        background: "#0b0d12",
        foreground: "#e6e7ea",
        cursor: "#7ec8ff",
        cursorAccent: "#0b0d12",
        selectionBackground: "rgba(126, 200, 255, 0.25)",
      },
      allowProposedApi: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(container);
    fit.fit();

    let unlistenData: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    let killed = false;

    const setup = async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const { listen } = await import("@tauri-apps/api/event");

      unlistenData = await listen<PtyDataPayload>("pty-data", (e) => {
        if (e.payload.session_id === sessionId) {
          term.write(e.payload.data);
        }
      });
      unlistenExit = await listen<PtyExitPayload>("pty-exit", (e) => {
        if (e.payload.session_id === sessionId) {
          term.writeln("");
          term.writeln(
            `\x1b[90m[session ended${
              e.payload.code != null ? ` (code ${e.payload.code})` : ""
            }]\x1b[0m`,
          );
          onExit?.();
        }
      });

      try {
        await invoke("pty_spawn", {
          args: {
            session_id: sessionId,
            cwd,
            command,
            cols: term.cols,
            rows: term.rows,
          },
        });
      } catch (err) {
        term.writeln(`\x1b[31mFailed to spawn pty: ${String(err)}\x1b[0m`);
        return;
      }

      // Forward keystrokes to the pty.
      term.onData((data) => {
        void invoke("pty_write", {
          args: { session_id: sessionId, data },
        }).catch((err) => {
          // Pty likely already gone; surface a hint then stop trying.
          if (!killed) {
            term.writeln(
              `\n\x1b[33m[pty write failed: ${String(err)}]\x1b[0m`,
            );
          }
        });
      });

      // Forward resize on container changes (split drag, window resize).
      const ro = new ResizeObserver(() => {
        try {
          fit.fit();
          void invoke("pty_resize", {
            args: { session_id: sessionId, cols: term.cols, rows: term.rows },
          });
        } catch (err) {
          // ignore — fit can throw if the container is briefly 0×0
          // during layout, and the next observation will succeed.
          void err;
        }
      });
      ro.observe(container);
      // Stash the observer disposer on the term so cleanup below can
      // reach it without holding another ref.
      (term as unknown as { __ro?: ResizeObserver }).__ro = ro;
    };

    void setup();

    return () => {
      killed = true;
      const ro = (term as unknown as { __ro?: ResizeObserver }).__ro;
      ro?.disconnect();
      unlistenData?.();
      unlistenExit?.();
      void (async () => {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("pty_kill", { args: { session_id: sessionId } });
        } catch {
          // session may already be gone — fine.
        }
      })();
      term.dispose();
    };
  }, [nodeId, cwd, command, onExit]);

  if (!isTauri()) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-[13px] text-[var(--color-text-dim)]">
        Vestavěný terminál je dostupný jen v desktop verzi Portuni.
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-hidden bg-[#0b0d12]"
    />
  );
}
