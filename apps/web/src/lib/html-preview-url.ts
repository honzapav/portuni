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

// A document's own `<meta http-equiv="Content-Security-Policy">` would
// block the appended relay (`script-src 'none'`, or anything without
// 'unsafe-inline'), and Escape inside it would stop nothing again. The
// meta goes before the relay is added. That costs the preview nothing:
// what keeps a previewed page away from the app is the sandbox (opaque
// origin, no allow-same-origin), never the page's own policy, and without
// it the page runs under the policy every other preview runs under -- none
// on web, the protocol handler's permissive one on desktop. Rewriting the
// policy to admit just the relay (a hash in script-src) would keep the
// page's self-restriction, at the price of a CSP parser on both sides
// ('none', default-src fallback, 'strict-dynamic', several metas) for no
// gain in isolation. Same rule as `without_csp_meta` in lib.rs.
const META_TAG = /<meta\b[^>]*>/gi;
const CSP_HTTP_EQUIV = /(?<![\w-])http-equiv\s*=\s*["']?\s*content-security-policy\s*(?:["'\s/>]|$)/i;

export function withoutCspMeta(html: string): string {
  return html.replace(META_TAG, (tag) => (CSP_HTTP_EQUIV.test(tag) ? "" : tag));
}

export function withEscapeRelay(html: string): string {
  return withoutCspMeta(html) + ESCAPE_RELAY_SCRIPT;
}

// Whether a window message is an Escape relayed out of the preview the
// user is in. The parent cannot see the key press itself (and Escape gives
// no user activation to check), so it checks what it can see: the message
// has the relay's shape, and it comes from the frame that holds the focus
// -- `focusedFrame` is the content window of `document.activeElement` when
// that is an iframe, and the app document itself has lost the focus to it.
// A page that posts the message on its own (a timer, a load handler) is
// ignored while the user is anywhere else in the app: in the composer, on
// the transcript, in another window. What stays possible: while the user
// works inside the preview, its script can stop the running turn without
// an Escape -- the user's own click put the focus there, and stopping is
// all it can do.
export function isRelayedEscape(
  data: unknown,
  source: unknown,
  focusedFrame: unknown,
  documentHasFocus: boolean,
): boolean {
  if (typeof data !== "object" || data === null) return false;
  if ((data as { portuni?: unknown }).portuni !== "escape") return false;
  if (documentHasFocus) return false;
  return source !== null && source !== undefined && source === focusedFrame;
}
