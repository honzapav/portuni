// The desktop HTML preview is an iframe pointed at portuni-html://<path>.
// Reported from the app: after an agent rewrote an .html file on disk, the
// "Soubor se na disku změnil" banner appeared, but "Načíst aktuální verzi"
// left the old document on screen -- the reload re-fetched the JSON content,
// yet the iframe's src was the same string as before, so it never navigated.
// The URL is now keyed on the file version so a reload changes it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ESCAPE_RELAY_SCRIPT,
  isRelayedEscape,
  protocolUrl,
  withEscapeRelay,
  withoutCspMeta,
} from "../apps/web/src/lib/html-preview-url.js";

describe("protocolUrl", () => {
  const path = "/Users/x/Portuni/Konektor/wip/obchodní model.html";

  it("encodes the absolute path as the URL path", () => {
    assert.equal(
      protocolUrl(path, null),
      `portuni-html://localhost/${encodeURIComponent(path)}`,
    );
  });

  it("changes when the file version changes, so the iframe reloads", () => {
    const before = protocolUrl(path, "aaa111");
    const after = protocolUrl(path, "bbb222");
    assert.notEqual(before, after);
    assert.equal(before, protocolUrl(path, "aaa111"));
  });

  it("keeps the path segment intact -- the version is a query, not part of the path", () => {
    const url = new URL(protocolUrl(path, "abc/def?x"));
    assert.equal(decodeURIComponent(url.pathname.slice(1)), path);
    assert.equal(url.searchParams.get("v"), "abc/def?x");
  });
});

// Codex review of #606: Esc stops the agent's turn from anywhere in the app
// -- except from inside an HTML preview, whose sandboxed frame keeps its key
// events to itself. Every previewed document now ends with a script that
// hands that Escape up as a message.
describe("Escape relay out of the HTML preview", () => {
  const page = "<!doctype html><html><body><button>Focus</button></body></html>";

  it("is appended after the document, never before its doctype", () => {
    const served = withEscapeRelay(page);
    assert.ok(served.startsWith(page));
    assert.ok(served.endsWith(ESCAPE_RELAY_SCRIPT));
  });

  it("is the same script the desktop protocol handler appends", () => {
    const rust = readFileSync(new URL("../apps/desktop/src/lib.rs", import.meta.url), "utf8");
    assert.ok(rust.includes(`const ESCAPE_RELAY_SCRIPT: &str = r#"${ESCAPE_RELAY_SCRIPT}"#;`));
  });

  // The script itself, run against a stub window: the keys it forwards and
  // the ones it leaves to the page.
  const relayed = (key: { key: string; defaultPrevented?: boolean; isComposing?: boolean; tagName?: string }) => {
    let listener: ((e: unknown) => void) | undefined;
    const posted: unknown[] = [];
    const body = ESCAPE_RELAY_SCRIPT.replace(/^<script>/, "").replace(/<\/script>$/, "");
    new Function("addEventListener", "parent", body)(
      (type: string, fn: (e: unknown) => void) => {
        if (type === "keydown") listener = fn;
      },
      { postMessage: (data: unknown, origin: string) => posted.push([data, origin]) },
    );
    listener?.({
      key: key.key,
      defaultPrevented: key.defaultPrevented ?? false,
      isComposing: key.isComposing ?? false,
      target: { tagName: key.tagName ?? "BUTTON" },
    });
    return posted;
  };

  it("posts an Escape pressed on the page to the app", () => {
    assert.deepEqual(relayed({ key: "Escape" }), [[{ portuni: "escape" }, "*"]]);
  });

  it("leaves other keys, handled Escapes, IME and form fields to the page", () => {
    assert.deepEqual(relayed({ key: "Enter" }), []);
    assert.deepEqual(relayed({ key: "Escape", defaultPrevented: true }), []);
    assert.deepEqual(relayed({ key: "Escape", isComposing: true }), []);
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) assert.deepEqual(relayed({ key: "Escape", tagName }), []);
  });

  it("takes the message only from the frame that holds the focus", () => {
    const frame = {};
    assert.equal(isRelayedEscape({ portuni: "escape" }, frame, frame), true);
    assert.equal(isRelayedEscape({ portuni: "escape" }, {}, frame), false);
    assert.equal(isRelayedEscape({ portuni: "escape" }, null, null), false);
    assert.equal(isRelayedEscape({ portuni: "other" }, frame, frame), false);
    assert.equal(isRelayedEscape("escape", frame, frame), false);
    assert.equal(isRelayedEscape(null, frame, frame), false);
  });

  // Codex review of #606, round 3, blocking: the round-2 check also asked
  // for !document.hasFocus(), which the standard keeps true while the focus
  // is inside a nested frame -- so Escape in the preview stopped nothing.
  it("stops the turn on an Escape with the focus in the preview", () => {
    const preview = {};
    // document.activeElement is the preview's iframe; the message comes
    // from its contentWindow.
    assert.equal(isRelayedEscape({ portuni: "escape" }, preview, preview), true);
  });

  // Codex review of #606, round 2, blocking: a preview page could stop
  // every turn on its own -- setInterval(() => parent.postMessage({portuni:
  // "escape"}, "*"), 100) passed a check that only asked whether the sender
  // was one of the document's frames.
  it("ignores a page that posts the message while the focus is elsewhere", () => {
    const preview = {};
    const tick = { portuni: "escape" };
    // The focus is in the composer: document.activeElement is no iframe.
    assert.equal(isRelayedEscape(tick, preview, null), false);
    // The focus is in a different frame than the one posting.
    assert.equal(isRelayedEscape(tick, preview, {}), false);
  });

  // Codex review of #606, round 2, major: a document with its own CSP meta
  // (script-src 'none') blocked the appended relay, so Escape inside it
  // stopped nothing again. The meta goes before the relay is added.
  it("drops the document's own CSP meta, so the relay can run", () => {
    const strict =
      '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="script-src \'none\'"></head><body><button>Focus</button></body></html>';
    assert.equal(
      withEscapeRelay(strict),
      `<!doctype html><html><head></head><body><button>Focus</button></body></html>${ESCAPE_RELAY_SCRIPT}`,
    );
  });

  it("drops a CSP meta in the head however the head comes to be", () => {
    const csp = '<META HTTP-EQUIV=content-security-policy CONTENT="default-src \'self\'">';
    // No <head> tag: the parser opens one for the meta.
    assert.equal(withoutCspMeta(`${csp}<p>x</p>`), "<p>x</p>");
    // After </head>, before <body>: the parser puts it back in the head.
    assert.equal(withoutCspMeta(`<head></head>\n${csp}<body></body>`), "<head></head>\n<body></body>");
    // Several, with other metas and text around them.
    assert.equal(
      withoutCspMeta(`<head><meta charset="utf-8">${csp}<title>x</title>${csp}</head>`),
      '<head><meta charset="utf-8"><title>x</title></head>',
    );
  });

  // Codex review of #606, round 3, blocking: the round-2 regex cut the meta
  // text out of anything, a script included -- `const example = '<meta
  // ...>'` became `const example = ''` and the page threw. Only a meta the
  // browser applies goes; every other character stays.
  it("leaves the CSP meta text alone wherever a browser would not apply it", () => {
    const csp = '<meta http-equiv="Content-Security-Policy" content="default-src none">';
    const untouched = [
      // The exact reproduction from the review.
      `<script>const example = '${csp}'; if (!example) throw new Error("missing template");</script>`,
      `<head><script>const example = '${csp}';</script></head>`,
      `<head><!-- ${csp} --></head>`,
      `<html><head></head><body>${csp}</body></html>`,
      `<p>x</p>${csp}`,
      `<body><textarea>${csp}</textarea></body>`,
      `<head><title>${csp}</title></head>`,
      `<head><template>${csp}</template></head>`,
      `<head><meta name="description" content='${csp}'></head>`,
      '<head><meta http-equiv="Content-Security-Policy-Report-Only" content="script-src \'none\'"></head>',
      '<head><meta http-equiv="Content-Security-Policy"></head>',
      '<head><meta charset="utf-8"><meta http-equiv="refresh" content="5"></head>',
    ];
    for (const html of untouched) assert.equal(withoutCspMeta(html), html, html);
  });
});
