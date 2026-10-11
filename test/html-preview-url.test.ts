// The desktop HTML preview is an iframe pointed at portuni-html://<path>.
// Reported from the app: after an agent rewrote an .html file on disk, the
// "Soubor se na disku změnil" banner appeared, but "Načíst aktuální verzi"
// left the old document on screen -- the reload re-fetched the JSON content,
// yet the iframe's src was the same string as before, so it never navigated.
// The URL is now keyed on the file version so a reload changes it.
//
// Reported later: a diagram loading its fonts from `fonts/fonts-local.css`
// (@font-face with a relative url()) and images by relative path showed the
// fallback font and no images. The whole path was one URL segment, so the
// relative references resolved outside the document's folder. The folder is
// now its own segment; the Rust handler (resolve_preview_request) serves
// what resolves under it and refuses the rest.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { protocolUrl } from "../apps/web/src/lib/html-preview-url.js";

describe("protocolUrl", () => {
  const dir = "/Users/x/Portuni/Konektor/wip";
  const path = `${dir}/obchodní model.html`;
  const folderSegment = `/${encodeURIComponent(dir)}/`;

  it("encodes the document folder and the file name as one segment each", () => {
    assert.equal(
      protocolUrl(path, null),
      `portuni-html://localhost/${encodeURIComponent(dir)}/${encodeURIComponent("obchodní model.html")}`,
    );
  });

  it("changes when the file version changes, so the iframe reloads", () => {
    const before = protocolUrl(path, "aaa111");
    const after = protocolUrl(path, "bbb222");
    assert.notEqual(before, after);
    assert.equal(before, protocolUrl(path, "aaa111"));
  });

  it("keeps the path intact -- the version is a query, not part of the path", () => {
    const url = new URL(protocolUrl(path, "abc/def?x"));
    const [folder, file] = url.pathname.slice(1).split("/");
    assert.equal(`${decodeURIComponent(folder)}/${decodeURIComponent(file)}`, path);
    assert.equal(url.searchParams.get("v"), "abc/def?x");
  });

  it("resolves relative CSS, fonts and images inside the document folder", () => {
    const doc = protocolUrl(path, "v1");
    const css = new URL("fonts/fonts-local.css", doc);
    assert.equal(css.pathname, `${folderSegment}fonts/fonts-local.css`);
    // A url() in that stylesheet resolves against the stylesheet's URL.
    assert.equal(
      new URL("SpaceGrotesk.woff2", css).pathname,
      `${folderSegment}fonts/SpaceGrotesk.woff2`,
    );
    assert.equal(new URL("./img/a.png", doc).pathname, `${folderSegment}img/a.png`);
    assert.equal(new URL("fonts/../img/a.png", doc).pathname, `${folderSegment}img/a.png`);
  });

  it("a reference climbing out with ../ loses the folder segment (the handler refuses it)", () => {
    const doc = protocolUrl(path, null);
    assert.equal(new URL("../secret.png", doc).pathname, "/secret.png");
    assert.equal(new URL("../../etc/passwd", doc).pathname, "/etc/passwd");
  });

  it("handles a file directly under the filesystem root", () => {
    assert.equal(
      protocolUrl("/a.html", null),
      `portuni-html://localhost/${encodeURIComponent("/")}/a.html`,
    );
  });
});
