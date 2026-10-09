// URL the desktop HTML preview iframe loads over the portuni-html:// custom
// protocol. The absolute path is percent-encoded as the URL path; the Rust
// handler decodes + scope-checks it and reads the file from disk.
//
// The loaded file's version (sha256 from the file API) rides along as a
// query param. The handler ignores the query (it only reads the path), but
// an iframe only navigates when its `src` changes: with a bare path URL,
// "Načíst aktuální verzi" after an on-disk edit re-fetched the JSON content
// and left the iframe -- the thing actually on screen on desktop -- showing
// the old document. Keying the URL on the version turns every reload into a
// fresh request to the handler, which reads the current bytes.
export function protocolUrl(absPath: string, version: string | null): string {
  const base = `portuni-html://localhost/${encodeURIComponent(absPath)}`;
  return version === null ? base : `${base}?v=${encodeURIComponent(version)}`;
}

// The preview frame is sandboxed in an opaque origin, so its key events
// never reach the app window: with focus inside a preview, the window
// Escape that stops the agent's turn (SessionChat) heard nothing. Every
// document the preview shows ends with this script, which hands that
// Escape up as a message -- under the same rules as the app's own listener
// (a key the page handled, an IME composition and a form field keep their
// Escape). The web build appends it to `srcDoc`; the desktop protocol
// handler appends the same text (`ESCAPE_RELAY_SCRIPT` in
// apps/desktop/src/lib.rs). After `</html>` it still runs -- the parser
// puts it in the body -- and, unlike a prefix, never knocks the page out
// of standards mode.
export const ESCAPE_RELAY_SCRIPT =
  '<script>addEventListener("keydown",function(e){var t=e.target&&e.target.tagName;if(e.key!=="Escape"||e.defaultPrevented||e.isComposing||t==="INPUT"||t==="TEXTAREA"||t==="SELECT")return;parent.postMessage({portuni:"escape"},"*")});</script>';

export function withEscapeRelay(html: string): string {
  return html + ESCAPE_RELAY_SCRIPT;
}

// Whether a window message is the relayed Escape: the right shape, sent by
// one of this document's own frames (`frames`: their content windows), not
// by some other window that holds a reference to us. A page in the preview
// can post it without a key press; all it can do is stop the turn, which
// the stop button does too.
export function isRelayedEscape(
  data: unknown,
  source: unknown,
  frames: readonly unknown[],
): boolean {
  if (typeof data !== "object" || data === null) return false;
  if ((data as { portuni?: unknown }).portuni !== "escape") return false;
  return source !== null && frames.includes(source);
}
