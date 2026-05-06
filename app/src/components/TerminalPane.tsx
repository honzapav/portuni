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
import { Unicode11Addon } from "@xterm/addon-unicode11";
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

export default function TerminalPane({ nodeId, cwd, command, onExit }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Stable ref so the cleanup closure sees the latest session id without
  // turning it into a state-induced re-render.
  const sessionIdRef = useRef<string>("");
  // Capture onExit in a ref so render-time inline closures from the
  // parent don't retrigger the spawn effect (which kills + re-spawns
  // the session on every prop reference change).
  const onExitRef = useRef(onExit);
  useEffect(() => {
    onExitRef.current = onExit;
  }, [onExit]);

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

    // Read computed CSS vars from the surrounding pane so the terminal
    // background matches Portuni's theme. Falls back to dark hexes if
    // the vars aren't set (e.g. in plain browser preview).
    const css = getComputedStyle(document.documentElement);
    const bg = css.getPropertyValue("--color-bg").trim() || "#0e1015";
    const fg = css.getPropertyValue("--color-text").trim() || "#e6e7ea";
    const accent = css.getPropertyValue("--color-accent").trim() || "#7ec8ff";

    // Font chain priorities, in order:
    //   - "JetBrains Mono NL" / "JetBrains Mono" — bundled webfont
    //     (loaded via @font-face in index.css). NL is the no-ligatures
    //     variant which avoids xterm.js' known ligature artifacts.
    //   - Menlo / Consolas / DejaVu Sans Mono — system fallbacks per OS
    //     so the terminal still renders if the bundled font fails to
    //     load.
    //   - "Apple Color Emoji" / "Symbola" — emoji + symbol coverage
    //     for the unicode glyphs Claude Code's TUI emits (✻ ✦ ⏵ →).
    //     Without this, those codepoints fall back to a proportional
    //     system font, the glyph renders wider than a cell, and the
    //     next character overlaps it — visually identical to the
    //     "strikethrough/duplicate" artifacts the user has been seeing.
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
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    // Unicode 11 width data — xterm defaults to Unicode 6 widths from
    // 1991, but Claude Code (and any modern TUI) emits codepoints
    // assigned width by Unicode 9-15. With the v6 table loaded and
    // activated, xterm now agrees with the app on whether a glyph
    // takes 1 or 2 cells, so the cursor doesn't drift after each
    // emoji and previously-rendered cells aren't half-overwritten by
    // the next frame — the duplicate-row symptom.
    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = "11";

    let cancelled = false;
    let killed = false;
    let unlistenData: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let pendingResizeTimer: number | null = null;

    const init = async () => {
      // Wait for the document's font set to settle before opening so
      // the GPU glyph atlas is built with the final, correct font
      // metrics. Without this, xterm measures with whatever the
      // browser currently has loaded, swaps in the real font moments
      // later, and every cached glyph ends up drawn at the wrong
      // baseline — the visible "strikethrough" artifact.
      await document.fonts.ready;
      if (cancelled) return;

      term.open(container);

      // Stay on the built-in DOM renderer.
      //
      // WebGL was the obvious choice for "fast TUI" but in practice it
      // kept drawing underlines through the middle of cells (claude
      // code's `\x1b[4m` lines came out looking like strikethroughs),
      // and unknown glyphs rendered as hex-code tofu instead of using
      // browser font fallback. The DOM renderer hands underline to
      // CSS `text-decoration` (correct baseline by definition) and
      // routes glyph fallback through the browser's own font picker,
      // which knows about Apple Color Emoji on macOS without us
      // configuring it.
      //
      // Throughput on the DOM renderer is plenty for an interactive
      // claude code session — perf only matters for log floods, which
      // this pane doesn't see.
      try {
        fit.fit();
      } catch (e) {
        void e;
      }

      const { invoke } = await import("@tauri-apps/api/core");
      const { listen } = await import("@tauri-apps/api/event");

      unlistenData = await listen<PtyDataPayload>("pty-data", (e) => {
        if (e.payload.session_id === sessionId) {
          // Feed raw bytes; xterm decodes UTF-8 across calls so
          // boundary-split multibyte codepoints don't get mangled.
          term.write(b64ToBytes(e.payload.data_b64));
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
          onExitRef.current?.();
        }
      });

      if (cancelled) return;

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
      // Two layers of protection here:
      //   1. Debounce — the observer can fire many times during a drag
      //      or animation. Coalesce them onto a single trailing call so
      //      the PTY only sees the final geometry.
      //   2. Dedupe — even if cell-pixel size changes, cols/rows often
      //      don't. Skip the IPC if neither dimension actually changed.
      // Without these, claude code (and any Ink TUI) gets a flood of
      // SIGWINCH-equivalent resize signals and re-paints repeatedly,
      // leaving stale duplicate rows on screen.
      let lastCols = term.cols;
      let lastRows = term.rows;
      resizeObserver = new ResizeObserver(() => {
        if (pendingResizeTimer != null) {
          window.clearTimeout(pendingResizeTimer);
        }
        pendingResizeTimer = window.setTimeout(() => {
          pendingResizeTimer = null;
          try {
            fit.fit();
          } catch (err) {
            // fit can throw if the container is briefly 0×0 during
            // layout; the next observation will succeed.
            void err;
            return;
          }
          if (term.cols === lastCols && term.rows === lastRows) {
            return;
          }
          lastCols = term.cols;
          lastRows = term.rows;
          void invoke("pty_resize", {
            args: { session_id: sessionId, cols: term.cols, rows: term.rows },
          });
        }, 80);
      });
      resizeObserver.observe(container);
    };

    void init().catch((err) => {
      // init runs async; an unhandled rejection from imports or
      // listeners would otherwise surface as a uncaught error in the
      // surrounding React tree on the next tick. Swallow it here and
      // surface it inside the terminal instead.
      try {
        term.writeln(`\x1b[31m[terminal init failed: ${String(err)}]\x1b[0m`);
      } catch {
        /* term might already be disposed */
      }
    });

    return () => {
      // Every unmount path must be defensive. React 18 propagates
      // exceptions thrown in effect cleanup all the way up; without an
      // ErrorBoundary that means the whole app remounts with empty
      // state — the symptom of "closing the terminal hides the entire
      // UI." Wrap each disposer in try/catch so one failure can't take
      // the rest with it.
      cancelled = true;
      killed = true;
      if (pendingResizeTimer != null) {
        window.clearTimeout(pendingResizeTimer);
        pendingResizeTimer = null;
      }
      try {
        resizeObserver?.disconnect();
      } catch (e) {
        void e;
      }
      try {
        unlistenData?.();
      } catch (e) {
        void e;
      }
      try {
        unlistenExit?.();
      } catch (e) {
        void e;
      }
      // Fire-and-forget; pty_kill IPC must not block the cleanup tick.
      void (async () => {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("pty_kill", { args: { session_id: sessionId } });
        } catch {
          // session may already be gone — fine.
        }
      })();
      try {
        term.dispose();
      } catch (e) {
        void e;
      }
    };
  }, [nodeId, cwd, command]);

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
