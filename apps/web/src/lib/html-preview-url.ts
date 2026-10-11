import { type DefaultTreeAdapterMap, parse } from "parse5";

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
// 'unsafe-inline'), and Escape inside it would stop nothing again. That
// meta goes before the relay is added. It costs the preview nothing: what
// keeps a previewed page away from the app is the sandbox (opaque origin,
// no allow-same-origin), never the page's own policy, and without it the
// page runs under the policy every other preview runs under -- none on
// web, the protocol handler's permissive one on desktop. Rewriting the
// policy to admit just the relay (a hash in script-src) would keep the
// page's self-restriction, at the price of a CSP parser on both sides for
// no gain in isolation.
//
// Only the meta a browser applies goes: a real <meta> element, child of
// the document's <head> (the HTML standard ignores one anywhere else),
// with that http-equiv and a content. The same text in a script, a
// comment, an attribute or a <textarea>, or a meta in the body, stays.
// A real HTML parser (parse5, with source offsets) finds it, and only its
// own characters are cut out of the original text -- the rest of the
// document stays as it was, byte for byte. Same rule as `without_csp_meta`
// in apps/desktop/src/lib.rs.
export function withoutCspMeta(html: string): string {
  const head = findHead(parse(html, { sourceCodeLocationInfo: true }));
  if (!head) return html;
  let out = html;
  // From the end, so earlier offsets stay valid.
  for (const node of [...head.childNodes].reverse()) {
    if (!isAppliedCspMeta(node)) continue;
    const loc = node.sourceCodeLocation;
    if (!loc) continue;
    out = out.slice(0, loc.startOffset) + out.slice(loc.endOffset);
  }
  return out;
}

type Parse5Node = DefaultTreeAdapterMap["node"];
type Parse5Element = DefaultTreeAdapterMap["element"];

function findHead(doc: DefaultTreeAdapterMap["document"]): Parse5Element | null {
  const html = doc.childNodes.find((n): n is Parse5Element => n.nodeName === "html");
  return html?.childNodes.find((n): n is Parse5Element => n.nodeName === "head") ?? null;
}

function isAppliedCspMeta(node: Parse5Node): node is Parse5Element {
  if (node.nodeName !== "meta" || !("attrs" in node)) return false;
  const attr = (name: string) => node.attrs.find((a) => a.name === name)?.value;
  return attr("http-equiv")?.toLowerCase() === "content-security-policy" && attr("content") !== undefined;
}

export function withEscapeRelay(html: string): string {
  return withoutCspMeta(html) + ESCAPE_RELAY_SCRIPT;
}

// Whether a window message is an Escape relayed out of the preview the
// user is in. The parent cannot see the key press itself (and Escape gives
// no user activation to check), so it checks what it can see: the message
// has the relay's shape, and it comes from the frame that holds the focus
// -- `focusedFrame` is the content window of `document.activeElement` when
// that is an iframe. (`document.hasFocus()` cannot help: the standard has
// it true while the focus is inside a nested frame, too.) A page that
// posts the message on its own (a timer, a load handler) is ignored while
// the user works anywhere else in the app -- the composer, the transcript,
// a button. What stays possible: while the preview holds the focus, its
// script can stop the running turn without an Escape -- the user's own
// click put the focus there, and stopping is all it can do.
export function isRelayedEscape(data: unknown, source: unknown, focusedFrame: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  if ((data as { portuni?: unknown }).portuni !== "escape") return false;
  return source !== null && source !== undefined && source === focusedFrame;
}
