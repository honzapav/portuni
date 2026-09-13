// The desktop HTML preview is an iframe pointed at portuni-html://<path>.
// Reported from the app: after an agent rewrote an .html file on disk, the
// "Soubor se na disku změnil" banner appeared, but "Načíst aktuální verzi"
// left the old document on screen -- the reload re-fetched the JSON content,
// yet the iframe's src was the same string as before, so it never navigated.
// The URL is now keyed on the file version so a reload changes it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { protocolUrl } from "../apps/web/src/lib/html-preview-url.js";

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
