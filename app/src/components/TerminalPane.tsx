// Embedded xterm.js pane wired to the Rust pty backend (src-tauri/src/pty.rs).
//
// Lifecycle:
//   - The parent pre-allocates a sessionId and owns the PTY lifetime.
//   - Mount: open xterm, subscribe to pty-data/pty-exit events, invoke
//     `pty_spawn` with cwd + optional command + initial cols/rows.
//   - Live: pty-data -> xterm.write; xterm.onData -> pty_write; resize
//     observer -> pty_resize (skipped for hidden/display:none panes).
//   - Unmount: dispose xterm + listeners only. pty_kill is NOT called
//     here — the parent owns the PTY lifecycle so remount / tab-switch
//     doesn't tear down the session.
//
// Browser-mode fallback: if not running in Tauri (Vite dev), the
// component renders a placeholder explaining that the embedded
// terminal requires the desktop app.

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import { isTauri } from "../lib/backend-url";

type Props = {
  // Pre-allocated by the parent. Used as the PTY backend session id —
  // stable across re-renders so the PTY survives prop changes.
  sessionId: string;
  cwd: string;
  command: string;
  // True when the pane is the active tab. False for background panes
  // that are mounted but display:none — those skip resize-IPC since
  // their measurements would be wrong anyway.
  active: boolean;
  // Called when the user closes the tab; parent removes from state +
  // invokes pty_kill. Component itself never calls pty_kill.
  onExit?: (code: number | null) => void;
  // Each emitted byte chunk fires this so App.tsx can update lastOutputAt
  // for the activity indicator. Keep the byte payload — App.tsx ignores
  // the bytes and only uses the timing.
  onOutput?: () => void;
};

type PtyDataPayload = { session_id: string; data_b64: string };
type PtyExitPayload = { session_id: string; code: number | null };

// Decode a base64 string into a Uint8Array. atob is built into
// every browser/webview; doing this inline avoids pulling in a
// base64 library just for the PTY path. Hot path — keep tight.
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export default function TerminalPane({
  sessionId,
  cwd,
  command,
  active,
  onExit,
  onOutput,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onExitRef = useRef(onExit);
  const onOutputRef = useRef(onOutput);
  useEffect(() => {
    onExitRef.current = onExit;
  }, [onExit]);
  useEffect(() => {
    onOutputRef.current = onOutput;
  }, [onOutput]);

  // (A) Spawn/listen effect. Deps: [sessionId] only.
  // cwd/command/active are intentionally not deps — they only matter at
  // spawn time or for the second effect.
  useEffect(() => {
    if (!isTauri()) return;
    const container = containerRef.current;
    if (!container) return;

    const id = sessionId;

    const css = getComputedStyle(document.documentElement);
    const bg = css.getPropertyValue("--color-bg").trim() || "#0e1015";
    const fg = css.getPropertyValue("--color-text").trim() || "#e6e7ea";
    const accent = css.getPropertyValue("--color-accent").trim() || "#7ec8ff";

    const term = new Terminal({
      fontFamily:
        '"JetBrains Mono", Menlo, Consolas, "DejaVu Sans Mono", "Apple Color Emoji", "Symbola", monospace',
      fontSize: 13,
      lineHeight: 1.0,
      letterSpacing: 0,
      cursorBlink: true,
      theme: {
        background: bg,
        foreground: fg,
        cursor: accent,
        cursorAccent: bg,
        selectionBackground: "rgba(126, 200, 255, 0.25)",
      },
      allowProposedApi: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = "11";

    let cancelled = false;
    let unlistenData: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let pendingResizeTimer: number | null = null;

    const init = async () => {
      await document.fonts.ready;
      if (cancelled) return;
      term.open(container);
      try {
        fit.fit();
      } catch (e) {
        void e;
      }

      const { invoke } = await import("@tauri-apps/api/core");
      const { listen } = await import("@tauri-apps/api/event");

      unlistenData = await listen<PtyDataPayload>("pty-data", (e) => {
        if (e.payload.session_id === id) {
          term.write(b64ToBytes(e.payload.data_b64));
          onOutputRef.current?.();
        }
      });
      unlistenExit = await listen<PtyExitPayload>("pty-exit", (e) => {
        if (e.payload.session_id === id) {
          term.writeln("");
          term.writeln(
            `\x1b[90m[session ended${
              e.payload.code != null ? ` (code ${e.payload.code})` : ""
            }]\x1b[0m`,
          );
          onExitRef.current?.(e.payload.code);
        }
      });

      if (cancelled) return;
      try {
        await invoke("pty_spawn", {
          args: { session_id: id, cwd, command, cols: term.cols, rows: term.rows },
        });
      } catch (err) {
        term.writeln(`\x1b[31mFailed to spawn pty: ${String(err)}\x1b[0m`);
        return;
      }

      term.onData((data) => {
        void invoke("pty_write", { args: { session_id: id, data } }).catch(() => {
          // pty may be gone already — ignore
        });
      });

      let lastCols = term.cols;
      let lastRows = term.rows;
      resizeObserver = new ResizeObserver(() => {
        // Skip resize-IPC for hidden panes. offsetParent === null is the
        // canonical "I'm in a display:none subtree" check; using it means
        // hidden tabs don't fire spurious SIGWINCH at the agent.
        if (container.offsetParent === null) return;
        if (pendingResizeTimer != null) window.clearTimeout(pendingResizeTimer);
        pendingResizeTimer = window.setTimeout(() => {
          pendingResizeTimer = null;
          try {
            fit.fit();
          } catch {
            return;
          }
          if (term.cols === lastCols && term.rows === lastRows) return;
          lastCols = term.cols;
          lastRows = term.rows;
          void invoke("pty_resize", {
            args: { session_id: id, cols: term.cols, rows: term.rows },
          });
        }, 80);
      });
      resizeObserver.observe(container);
    };

    void init().catch((err) => {
      try {
        term.writeln(`\x1b[31m[terminal init failed: ${String(err)}]\x1b[0m`);
      } catch {
        // term may already be disposed — ignore
      }
    });

    return () => {
      // CRUCIAL: do NOT call pty_kill here. Parent owns lifecycle so a
      // re-render or tab switch (which can remount us) doesn't tear down
      // the PTY. Only dispose xterm + listeners.
      cancelled = true;
      if (pendingResizeTimer != null) window.clearTimeout(pendingResizeTimer);
      try {
        resizeObserver?.disconnect();
      } catch {
        // defensive — ignore
      }
      try {
        unlistenData?.();
      } catch {
        // defensive — ignore
      }
      try {
        unlistenExit?.();
      } catch {
        // defensive — ignore
      }
      try {
        term.dispose();
      } catch {
        // defensive — ignore
      }
      fitRef.current = null;
    };
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // (B) Active-fit effect — refits when a pane becomes the active tab.
  useEffect(() => {
    if (!active) return;
    const id = window.setTimeout(() => {
      try {
        fitRef.current?.fit();
      } catch {
        // fit may throw if container is 0x0 — ignore
      }
    }, 16);
    return () => window.clearTimeout(id);
  }, [active]);

  if (!isTauri()) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-[13px] text-[var(--color-text-dim)]">
        Vestavěný terminál je dostupný jen v desktop verzi Portuni.
      </div>
    );
  }

  return (
    <div className="h-full w-full bg-[var(--color-bg)] p-5">
      <div ref={containerRef} className="h-full w-full overflow-hidden" />
    </div>
  );
}
