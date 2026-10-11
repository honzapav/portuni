// The web HTML preview is a srcDoc iframe with no URL of its own, so a
// document's relative stylesheets, fonts and images never loaded there
// (reported for a diagram using `fonts/fonts-local.css` with relative
// @font-face url()s; desktop got its fix in #613). The web now reads them
// through the file API and inlines them as data: URLs. These tests pin what
// loads (files under the document's folder, allowlisted types) and what is
// refused (anything out of the folder, scripts and other types), using the
// same cases as the desktop protocol's resolve_preview_request tests.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BLOCKED_URL,
  inlinePreviewAssets,
  mapCssUrls,
  parseSrcset,
  resolveAssetRef,
  type AssetSlot,
} from "../apps/web/src/lib/html-preview-assets.js";
import { previewAssetMime } from "../apps/server/shared/preview-assets.js";

const DOC = "wip/diagram-strategie-system/diagram.html";
const DIR = "wip/diagram-strategie-system";

describe("previewAssetMime", () => {
  const cases: [string, string | null][] = [
    ["a.css", "text/css"],
    ["fonts/SpaceGrotesk.woff2", "font/woff2"],
    ["a.WOFF", "font/woff"],
    ["a.ttf", "font/ttf"],
    ["a.otf", "font/otf"],
    ["img/logo final.PNG", "image/png"],
    ["a.jpg", "image/jpeg"],
    ["a.jpeg", "image/jpeg"],
    ["a.gif", "image/gif"],
    ["a.svg", "image/svg+xml"],
    ["a.webp", "image/webp"],
    ["a.avif", "image/avif"],
    ["favicon.ico", "image/x-icon"],
    ["app.js", null],
    ["app.mjs", null],
    ["page.html", null],
    ["notes.md", null],
    ["data.json", null],
    [".env", null],
    ["fonts/.css", null],
    ["noext", null],
  ];
  for (const [path, mime] of cases) {
    it(`${path} -> ${mime}`, () => assert.equal(previewAssetMime(path), mime));
  }
});

describe("resolveAssetRef", () => {
  const asset = (path: string, mime: string) => ({ kind: "asset", path, mime });
  const loads: [string, ReturnType<typeof asset>][] = [
    ["fonts/fonts-local.css", asset(`${DIR}/fonts/fonts-local.css`, "text/css")],
    ["./img/a.png", asset(`${DIR}/img/a.png`, "image/png")],
    ["img/logo%20final.PNG", asset(`${DIR}/img/logo final.PNG`, "image/png")],
    ["img/logo final.PNG", asset(`${DIR}/img/logo final.PNG`, "image/png")],
    ["fonts/../img/a.svg", asset(`${DIR}/img/a.svg`, "image/svg+xml")],
    ["img/a.png?v=2#x", asset(`${DIR}/img/a.png`, "image/png")],
    ["  img/a.png  ", asset(`${DIR}/img/a.png`, "image/png")],
  ];
  for (const [ref, want] of loads) {
    it(`loads ${JSON.stringify(ref)}`, () => assert.deepEqual(resolveAssetRef(DIR, DIR, ref), want));
  }

  const refused = [
    "../secret.png",
    "../../other/a.png",
    "fonts/../../other.woff2",
    "%2E%2E/other.png",
    ".%2e/other.png",
    "fonts/..%2F..%2Fother.png",
    "%2Fws%2Fother%2Fa.png",
    "..\\other.png",
    "/secret.png",
    "/wip/diagram-strategie-system/img/a.png",
    "./",
    ".",
    "app.js",
    "img/x.html",
    ".env",
    "notes.md",
    "img/a%00.png",
  ];
  for (const ref of refused) {
    it(`refuses ${JSON.stringify(ref)}`, () => assert.equal(resolveAssetRef(DIR, DIR, ref).kind, "refused"));
  }

  const external = [
    "https://fonts.example.com/a.woff2",
    "http://x/a.png",
    "//cdn.example.com/a.png",
    "data:image/png;base64,AAAA",
    "#clip",
    "",
    "   ",
  ];
  for (const ref of external) {
    it(`leaves ${JSON.stringify(ref)} as written`, () =>
      assert.equal(resolveAssetRef(DIR, DIR, ref).kind, "external"));
  }

  it("resolves a stylesheet's reference against the stylesheet's folder, bounded by the document's", () => {
    assert.deepEqual(
      resolveAssetRef(DIR, `${DIR}/fonts`, "SpaceGrotesk.woff2"),
      asset(`${DIR}/fonts/SpaceGrotesk.woff2`, "font/woff2"),
    );
    assert.deepEqual(resolveAssetRef(DIR, `${DIR}/fonts`, "../img/a.png"), asset(`${DIR}/img/a.png`, "image/png"));
    assert.equal(resolveAssetRef(DIR, `${DIR}/fonts`, "../../a.png").kind, "refused");
  });

  it("a document at the mirror root may load from the whole mirror, not above it", () => {
    assert.deepEqual(resolveAssetRef("", "", "wip/a.png"), asset("wip/a.png", "image/png"));
    assert.equal(resolveAssetRef("", "", "../a.png").kind, "refused");
  });

  it("does not treat a sibling folder sharing the prefix as inside", () => {
    assert.equal(resolveAssetRef("wip/a", "wip/a", "../ab/x.png").kind, "refused");
  });
});

describe("mapCssUrls", () => {
  // What each url() / @import holds, per the CSS Syntax tokenizer.
  const refs = (css: string) => {
    const out: [string, boolean][] = [];
    mapCssUrls(css, (ref, isImport) => {
      out.push([ref, isImport]);
      return null;
    });
    return out;
  };
  const cases: [string, [string, boolean][]][] = [
    ["a{background:url(img/a.png)}", [["img/a.png", false]]],
    ["a{background:url( img/a.png )}", [["img/a.png", false]]],
    ['a{background:url("img/a b.png")}', [["img/a b.png", false]]],
    ["a{background:url( 'img/a.png' )}", [["img/a.png", false]]],
    ["a{background:URL(img/a.png)}", [["img/a.png", false]]],
    ["a{background:url(img/a\\).png)}", [["img/a).png", false]]],
    ["a{background:url(img/\\61.png)}", [["img/a.png", false]]],
    [
      '@font-face{font-family:X;src:local("X"),url(SpaceGrotesk.woff2) format("woff2"),url("x.woff") format("woff")}',
      [
        ["SpaceGrotesk.woff2", false],
        ["x.woff", false],
      ],
    ],
    ['@import "base.css";', [["base.css", true]]],
    ["@import 'base.css' screen;", [["base.css", true]]],
    ["@import url(base.css);", [["base.css", true]]],
    ['@IMPORT url("base.css");', [["base.css", true]]],
    ["/* url(no.png) */a{b:url(yes.png)}", [["yes.png", false]]],
    ['a{content:"url(no.png)"}', []],
    ["a{content:'it\\'s url(no.png)'}", []],
    ["a{x:myurl(no.png)}", []],
    ["a{x:url(bad url.png)}", []],
    ["a{x:url(bad\"q.png)}", []],
    ["a{filter:url(#f)}", [["#f", false]]],
  ];
  for (const [css, want] of cases) {
    it(JSON.stringify(css), () => assert.deepEqual(refs(css), want));
  }

  it("splices replacements in as quoted url()s and keeps everything else byte for byte", () => {
    const css = '@import "a.css";\n/* c */ b{background:url( x.png ) no-repeat; content:"url(y)"}';
    const out = mapCssUrls(css, (ref) => (ref === "x.png" ? 'data:a"b\\c' : ref === "a.css" ? "data:t" : null));
    assert.equal(
      out,
      '@import url("data:t");\n/* c */ b{background:url("data:a\\"b\\\\c") no-repeat; content:"url(y)"}',
    );
  });
});

describe("parseSrcset", () => {
  const cases: [string, { url: string; descriptor: string }[]][] = [
    ["a.png", [{ url: "a.png", descriptor: "" }]],
    [
      "a.png 1x, b.png 2x",
      [
        { url: "a.png", descriptor: "1x" },
        { url: "b.png", descriptor: "2x" },
      ],
    ],
    [
      "a.png 480w,b.png 800w",
      [
        { url: "a.png", descriptor: "480w" },
        { url: "b.png", descriptor: "800w" },
      ],
    ],
    [
      "a.png, b.png 2x",
      [
        { url: "a.png", descriptor: "" },
        { url: "b.png", descriptor: "2x" },
      ],
    ],
    [
      "data:image/png;base64,AA,BB 1x, c.png 2x",
      [
        { url: "data:image/png;base64,AA,BB", descriptor: "1x" },
        { url: "c.png", descriptor: "2x" },
      ],
    ],
  ];
  for (const [srcset, want] of cases) {
    it(JSON.stringify(srcset), () => assert.deepEqual(parseSrcset(srcset), want));
  }
});

describe("inlinePreviewAssets", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  const fromB64 = (s: string) => Buffer.from(s, "base64").toString("utf8");
  const dataPayload = (url: string) => fromB64(url.slice(url.indexOf(",") + 1));

  // A fake mirror, keyed by mirror-relative path; records every read.
  function mirror(files: Record<string, string>) {
    const reads: string[] = [];
    const fetchAsset = async (path: string) => {
      reads.push(path);
      if (!(path in files)) throw new Error(`404 ${path}`);
      return b64(files[path]);
    };
    return { reads, fetchAsset };
  }

  function slot(kind: AssetSlot["kind"], value: string) {
    const s = { kind, value, result: undefined as string | null | undefined };
    return Object.assign(s, {
      set: (v: string | null) => {
        s.result = v;
      },
    }) as AssetSlot & { result: string | null | undefined };
  }

  it("loads a relative stylesheet, the font its @font-face names and an image", async () => {
    const m = mirror({
      [`${DIR}/fonts/fonts-local.css`]:
        "@font-face{font-family:'Space Grotesk';src:url(SpaceGrotesk.woff2) format('woff2')}",
      [`${DIR}/fonts/SpaceGrotesk.woff2`]: "WOFF2BYTES",
      [`${DIR}/img/a.png`]: "PNGBYTES",
    });
    const link = slot("url", "fonts/fonts-local.css");
    const img = slot("url", "img/a.png");
    const changed = await inlinePreviewAssets([link, img], DOC, m.fetchAsset);

    assert.equal(changed, true);
    assert.equal(img.result, `data:image/png;base64,${b64("PNGBYTES")}`);
    assert.ok(link.result?.startsWith("data:text/css;charset=utf-8;base64,"));
    assert.equal(
      dataPayload(link.result as string),
      `@font-face{font-family:'Space Grotesk';src:url("data:font/woff2;base64,${b64("WOFF2BYTES")}") format('woff2')}`,
    );
  });

  it("inlines url()s in <style> blocks and style attributes, and srcset candidates", async () => {
    const m = mirror({ [`${DIR}/img/a.png`]: "A", [`${DIR}/img/b.png`]: "B" });
    const style = slot("css", "body{background:url(img/a.png)}");
    const attr = slot("css", "background-image:url('img/b.png')");
    const srcset = slot("srcset", "img/a.png 1x, https://x/c.png 2x, ../out.png 3x");
    await inlinePreviewAssets([style, attr, srcset], DOC, m.fetchAsset);

    assert.equal(style.result, `body{background:url("data:image/png;base64,${b64("A")}")}`);
    assert.equal(attr.result, `background-image:url("data:image/png;base64,${b64("B")}")`);
    assert.equal(srcset.result, `data:image/png;base64,${b64("A")} 1x, https://x/c.png 2x`);
  });

  it("follows @import, with its references relative to the imported file", async () => {
    const m = mirror({
      [`${DIR}/css/main.css`]: '@import "parts/fonts.css"; body{color:red}',
      [`${DIR}/css/parts/fonts.css`]: "@font-face{src:url(../../fonts/x.woff2)}",
      [`${DIR}/fonts/x.woff2`]: "X",
    });
    const link = slot("url", "css/main.css");
    await inlinePreviewAssets([link], DOC, m.fetchAsset);
    const main = dataPayload(link.result as string);
    const imported = /^@import url\("([^"]+)"\)/.exec(main);
    assert.ok(imported, main);
    assert.equal(dataPayload(imported[1]), `@font-face{src:url("data:font/woff2;base64,${b64("X")}")}`);
  });

  it("refuses a path out of the document folder and a disallowed type without reading them", async () => {
    const m = mirror({ "wip/secret.png": "S", [`${DIR}/app.js`]: "alert(1)" });
    const up = slot("url", "../secret.png");
    const abs = slot("url", "/wip/secret.png");
    const enc = slot("url", "%2E%2E/secret.png");
    const script = slot("url", "app.js");
    const css = slot("css", "a{background:url(../secret.png)}");
    await inlinePreviewAssets([up, abs, enc, script, css], DOC, m.fetchAsset);

    assert.deepEqual(m.reads, []);
    assert.equal(up.result, null);
    assert.equal(abs.result, null);
    assert.equal(enc.result, null);
    assert.equal(script.result, null);
    assert.equal(css.result, `a{background:url("${BLOCKED_URL}")}`);
  });

  it("refuses a stylesheet's reference that climbs out of the document folder", async () => {
    const m = mirror({ [`${DIR}/fonts/f.css`]: "@font-face{src:url(../../secret.woff2)}" });
    const link = slot("url", "fonts/f.css");
    await inlinePreviewAssets([link], DOC, m.fetchAsset);
    assert.deepEqual(m.reads, [`${DIR}/fonts/f.css`]);
    assert.equal(dataPayload(link.result as string), `@font-face{src:url("${BLOCKED_URL}")}`);
  });

  it("leaves external references alone and reports no change", async () => {
    const m = mirror({});
    const link = slot("url", "https://fonts.googleapis.com/css2?family=Cabin");
    const style = slot("css", "a{filter:url(#f);background:url(data:image/png;base64,AA)}");
    const changed = await inlinePreviewAssets([link, style], DOC, m.fetchAsset);
    assert.equal(changed, false);
    assert.equal(link.result, undefined);
    assert.equal(style.result, undefined);
    assert.deepEqual(m.reads, []);
  });

  it("blocks a missing file, reads each file once and stops an @import cycle", async () => {
    const m = mirror({
      [`${DIR}/a.css`]: '@import "b.css"; x{background:url(img.png)}',
      [`${DIR}/b.css`]: '@import "a.css";',
      [`${DIR}/img.png`]: "I",
    });
    const a = slot("url", "a.css");
    const img = slot("url", "img.png");
    const missing = slot("url", "nope.png");
    await inlinePreviewAssets([a, img, missing], DOC, m.fetchAsset);

    assert.equal(missing.result, null);
    assert.deepEqual([...m.reads].sort(), [`${DIR}/a.css`, `${DIR}/b.css`, `${DIR}/img.png`, `${DIR}/nope.png`]);
    const b = /^@import url\("([^"]+)"\)/.exec(dataPayload(a.result as string));
    assert.ok(b);
    assert.equal(dataPayload(b[1]), `@import url("${BLOCKED_URL}");`);
  });
});
