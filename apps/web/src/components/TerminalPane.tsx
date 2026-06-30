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
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { isTauri, openExternal, clipboardFilePath } from "../lib/backend-url";
import { reportError } from "../lib/error-overlay";
import { THEMES, type Theme } from "../lib/theme";

type Props = {
  // Pre-allocated by the parent. Used as the PTY backend session id —
  // stable across re-renders so the PTY survives prop changes.
  sessionId: string;
  cwd: string;
  command: string;
  // Seatbelt profile text; pty_spawn wraps the shell in sandbox-exec
  // with it so every process in the terminal gets the node's disk scope.
  // Null spawns unsandboxed (legacy sessions only — new launches always
  // carry a profile).
  sandboxProfile: string | null;
  // True when the pane is the active tab. False for background panes
  // that are mounted but display:none — those skip resize-IPC since
  // their measurements would be wrong anyway.
  active: boolean;
  // App-level theme. xterm holds a snapshot of CSS-variable colors so
  // we re-apply them imperatively on theme flip — the Tailwind wrapper
  // around the canvas updates fine via CSS but the canvas itself does
  // not re-read variables.
  theme: Theme;
  // Called when the user closes the tab; parent removes from state +
  // invokes pty_kill. Component itself never calls pty_kill.
  onExit?: (code: number | null) => void;
  // Each emitted byte chunk fires this so App.tsx can update lastOutputAt
  // for the activity indicator. Keep the byte payload — App.tsx ignores
  // the bytes and only uses the timing.
  onOutput?: () => void;
};

// Build an xterm ITheme from the theme tokens, merged with the mode's
// 16-color ANSI palette. Called at mount and on every theme flip.
//
// Colors are read from THEMES[theme] (the same tokens that drive the CSS
// variables), NOT from getComputedStyle(document.documentElement). The DOM
// read used to lag a flip behind: this component's theme effect runs
// child-first, before App's effect sets <html data-theme>, so the computed
// --color-bg/--color-text were still the OLD theme's while the ANSI palette
// was the new one — the terminal looked inverted. Deriving everything from
// THEMES[theme] makes the snapshot independent of effect ordering.
function buildXtermTheme(theme: Theme): ITheme {
  const t = THEMES[theme];
  return {
    background: t.bg,
    foreground: t.text,
    cursor: t.accent,
    cursorAccent: t.bg,
    selectionBackground: "rgba(126, 200, 255, 0.25)",
    ...t.ansi,
  };
}

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

// POSIX single-quote a path so spaces/quotes/specials survive when written
// into the shell line. Wrap in '...' and escape embedded ' as '\''.
function shellQuote(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

export default function TerminalPane({
  sessionId,
  cwd,
  command,
  sandboxProfile,
  active,
  theme,
  onExit,
  onOutput,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
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

    const term = new Terminal({
      // Drop "Apple Color Emoji" from the fallback chain — when a glyph
      // is missing from JetBrains Mono / Menlo (●, ◯, ✓, ║, │), the
      // browser falls through to the next family. Apple Color Emoji is a
      // color-bitmap font with a different baseline and an emoji-width
      // glyf, which makes simple Unicode bullets float above the line
      // and wider than one cell — wrecking diff and bullet alignment.
      // Symbola provides monochrome text glyphs at monospace widths and
      // is a clean text-class fallback.
      fontFamily:
        '"JetBrains Mono", Menlo, Consolas, "DejaVu Sans Mono", "Symbola", monospace',
      fontSize: 13,
      lineHeight: 1.0,
      letterSpacing: 0,
      cursorBlink: true,
      theme: buildXtermTheme(theme),
      allowProposedApi: true,
      scrollback: 5000,
      // CRITICAL on macOS with non-US keyboard layouts. With
      // macOptionIsMeta=true, xterm treats Option+key as Meta+key (ESC
      // prefix), which steals OS-level layout composition: on a Czech
      // (and many EU) keyboard, @ = Option+V, > = Option+., & = Option+7,
      // etc. — those characters never make it to the PTY. We leave Meta
      // off here and re-introduce Option+B/F (word-nav) explicitly via
      // the customKeyEventHandler below, which only fires for the actual
      // navigation letters, not for printable punctuation.
      macOptionIsMeta: false,
      // Right-click highlights the word under the cursor, then Cmd+C copies.
      rightClickSelectsWord: true,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    // WebLinksAddon is loaded later, inside init(), with a Tauri-aware handler.
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
      // Now safe to expose the addon to the active-fit effect — before
      // term.open(), FitAddon.fit() throws because there's no DOM.
      fitRef.current = fit;
      // WebLinksAddon's default handler is window.open(), which is a no-op
      // inside the Tauri webview. Route through openExternal -- the native
      // open_external command with scheme allowlist + logging. The old
      // tauri-plugin-shell `open` was itself a silent no-op in the macOS
      // webview (same bug commit 1f927a1 fixed for app links), so links
      // clicked in the terminal did nothing. Regex matches the allowlist:
      // http(s) and mailto only.
      term.loadAddon(
        new WebLinksAddon(
          (event, uri) => {
            event.preventDefault();
            void openExternal(uri);
          },
          {
            urlRegex:
              /((https?|HTTPS?):\/\/|mailto:)[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/,
          },
        ),
      );
      // WebGL renderer — replaces the default DOM renderer with a
      // canvas/WebGL pipeline that does subpixel-accurate glyph
      // positioning. Wide glyphs (box-drawing │ ║, bullets ●, CJK,
      // emoji-text) line up cell-for-cell, so diff columns and ASCII
      // tables stay aligned. Falls back silently if the webview can't
      // get a WebGL context (e.g. headless / GPU disabled) — DOM
      // renderer keeps working in that case.
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        // WebGL unavailable — fall back to DOM renderer silently.
      }
      try {
        fit.fit();
      } catch {
        // container may be 0x0 at open time — ignore
      }

      const { invoke } = await import("@tauri-apps/api/core");
      const { listen } = await import("@tauri-apps/api/event");

      unlistenData = await listen<PtyDataPayload>("pty-data", (e) => {
        if (e.payload.session_id === id) {
          // Defensive: a malformed escape sequence from a full-screen TUI
          // agent can make xterm (or the WebGL renderer) throw. This
          // listener is async, so an uncaught throw here escapes to
          // window.onerror and historically white-screened the whole app.
          // Swallow it into the diagnostic overlay so one bad byte stream
          // can't take down the session — or the app.
          try {
            term.write(b64ToBytes(e.payload.data_b64));
          } catch (err) {
            reportError("xterm.write", err, `session=${id}`);
          }
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
          args: {
            session_id: id,
            cwd,
            command,
            cols: term.cols,
            rows: term.rows,
            sandbox_profile: sandboxProfile,
          },
        });
      } catch (err) {
        term.writeln(`\x1b[31mFailed to spawn pty: ${String(err)}\x1b[0m`);
        return;
      }

      // Manual Meta/Option handling. macOptionIsMeta is off (CZ-keyboard
      // friendliness — see the constructor option above), so we re-inject
      // the four navigation shortcuts that shell users actually rely on.
      // Match by event.code, not event.key — on non-US layouts Option+B
      // could resolve to a different printable, but the physical key
      // (KeyB) stays put. Letters keyed without Option still produce the
      // layout's char via xterm.onData; this handler only intercepts the
      // Option-modified combinations.
      //
      // Shift+Enter → ESC+CR (soft newline, Option+Enter equivalent) for
      // Claude Code and REPLs that distinguish newline from submit.
      //
      // xterm's customKeyEventHandler fires for keydown AND keypress AND
      // keyup. We must return false on ALL of them; otherwise xterm's
      // _keyPress sends a plain "\r" right after our "\x1b\r", and the
      // shell sees "\x1b\r\r" — ESC is dropped, the second CR submits.
      // The pty_write itself only runs on keydown so we don't double-send.
      const writePty = (data: string) =>
        invoke("pty_write", { args: { session_id: id, data } }).catch(() => {
          // pty may be gone already — ignore
        });
      term.attachCustomKeyEventHandler((event) => {
        // Shift+Enter — soft newline.
        if (
          event.key === "Enter" &&
          event.shiftKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey
        ) {
          if (event.type === "keydown") void writePty("\x1b\r");
          return false;
        }
        // Cmd (Meta) + Arrow — macOS line/document navigation. The webview
        // otherwise swallows these chords (Cmd+Left/Right would even trigger
        // history back/forward), so the shell's line editor never sees them.
        // Map Cmd+Left/Right onto readline's Ctrl-A / Ctrl-E (line start/end)
        // and Cmd+Up/Down onto scrollback top/bottom — the closest terminal
        // analogue of "document start/end". Only when Cmd is the sole
        // modifier, so Cmd+C / Cmd+V / Cmd+Shift+Arrow stay untouched.
        if (
          event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.shiftKey
        ) {
          let handled = true;
          switch (event.key) {
            case "ArrowLeft":
              if (event.type === "keydown") void writePty("\x01");
              break;
            case "ArrowRight":
              if (event.type === "keydown") void writePty("\x05");
              break;
            case "ArrowUp":
              if (event.type === "keydown") term.scrollToTop();
              break;
            case "ArrowDown":
              if (event.type === "keydown") term.scrollToBottom();
              break;
            default:
              handled = false;
          }
          if (handled) {
            event.preventDefault();
            return false;
          }
        }
        // Option (Alt) + navigation chord. Only intercept when Option is
        // the ONLY modifier so we don't fight system shortcuts like
        // Cmd+Option+anything.
        if (
          event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.shiftKey
        ) {
          let seq: string | null = null;
          switch (event.code) {
            case "KeyB":
              seq = "\x1bb";
              break;
            case "KeyF":
              seq = "\x1bf";
              break;
            case "KeyD":
              seq = "\x1bd";
              break;
            case "Backspace":
              // ESC + DEL — readline word-delete-back. Some shells also
              // accept Ctrl+W; this matches macOS Terminal's default.
              seq = "\x1b\x7f";
              break;
          }
          if (seq) {
            if (event.type === "keydown") void writePty(seq);
            return false;
          }
        }
        return true;
      });

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
      termRef.current = null;
    };
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // (B) Theme effect — re-apply colors whenever the user flips
  // dark/light at runtime. Reads the freshly-applied CSS variables off
  // <html data-theme="..."> and pokes them into xterm's options. Skips
  // the initial mount (the constructor already used buildXtermTheme())
  // but is intentionally cheap enough to run anyway.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = buildXtermTheme(theme);
  }, [theme]);

  // (D) Finder drag-and-drop. Drop a file onto the ACTIVE terminal to
  // insert its shell-quoted path at the cursor. Only the active pane
  // registers the listener, so the drop targets the session the user is
  // looking at. Tauri's native drag-drop event carries the real
  // filesystem paths (the webview's HTML5 drop does not on macOS), so we
  // use onDragDropEvent and write via the existing pty_write command.
  useEffect(() => {
    if (!isTauri() || !active) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      const { invoke } = await import("@tauri-apps/api/core");
      const un = await getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        const paths = event.payload.paths;
        if (!paths || paths.length === 0) return;
        const data = paths.map(shellQuote).join(" ") + " ";
        void invoke("pty_write", {
          args: { session_id: sessionId, data },
        }).catch(() => undefined);
      });
      if (cancelled) un();
      else unlisten = un;
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [active, sessionId]);

  // (E) Finder paste interceptor. When the user pastes a file copied from
  // Finder (Cmd+C on a file, then Cmd+V in the terminal), insert its
  // shell-quoted path instead of letting the webview paste a raw file
  // reference (which would be garbled or empty in xterm).
  //
  // Detection: check clipboardData.files.length and
  // clipboardData.types.includes("Files") synchronously. In the Tauri
  // macOS WKWebView these flags may not always be set for OS file references
  // (the webview exposes UTI types rather than "Files"). If neither flag
  // fires, we fall through to the async fallback: call clipboardFilePath()
  // regardless — if it returns a path the clipboard held a file and we write
  // the shell-quoted path on top of whatever xterm may have pasted; if it
  // returns null the clipboard had text and xterm already handled it cleanly.
  useEffect(() => {
    if (!isTauri() || !active) return;
    const container = containerRef.current;
    if (!container) return;

    const id = sessionId;

    const handlePaste = (e: ClipboardEvent) => {
      const hasFile =
        (e.clipboardData?.files?.length ?? 0) > 0 ||
        (e.clipboardData?.types ?? []).some((t) => t === "Files" || t.includes("file-url"));

      if (!hasFile) return;

      // A file is on the clipboard — block xterm and resolve the native path.
      e.preventDefault();
      e.stopPropagation();
      void (async () => {
        const path = await clipboardFilePath();
        if (!path) return;
        const data = shellQuote(path) + " ";
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("pty_write", { args: { session_id: id, data } }).catch(() => undefined);
      })();
    };

    container.addEventListener("paste", handlePaste, { capture: true });
    return () => {
      container.removeEventListener("paste", handlePaste, { capture: true });
    };
  }, [active, sessionId]);

  // (C) Active-fit effect — refits when a pane becomes the active tab.
  useEffect(() => {
    if (!active) return;
    // One animation frame to let the browser apply display:block on a
    // previously hidden pane before we measure cell sizes.
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
      <div
        ref={containerRef}
        className="h-full w-full overflow-hidden"
        // font-variant-emoji: text forces the browser to pick the text
        // (non-color) glyph variant for dual-encoded codepoints. Combined
        // with the Symbola fallback in the font stack, this keeps single
        // bullets (●, ◯, ✓), box-drawing chars (│, ║), and other diff
        // glyphs at one-cell width and on baseline — Apple Color Emoji
        // otherwise widens them and offsets text by half a row.
        style={{ fontVariantEmoji: "text" } as React.CSSProperties}
      />
    </div>
  );
}
