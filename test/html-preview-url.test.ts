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

  it("takes the message only from one of the document's own frames", () => {
    const frame = {};
    assert.equal(isRelayedEscape({ portuni: "escape" }, frame, [frame]), true);
    assert.equal(isRelayedEscape({ portuni: "escape" }, {}, [frame]), false);
    assert.equal(isRelayedEscape({ portuni: "escape" }, null, [null]), false);
    assert.equal(isRelayedEscape({ portuni: "other" }, frame, [frame]), false);
    assert.equal(isRelayedEscape("escape", frame, [frame]), false);
    assert.equal(isRelayedEscape(null, frame, [frame]), false);
  });
});
