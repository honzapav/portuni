// Stylesheets, fonts and images for the web HTML preview.
//
// On web the preview is a srcDoc iframe (sandbox="allow-scripts", no
// allow-same-origin). A srcdoc document has no URL of its own, so its
// relative references (`<link href="fonts/x.css">`, the `@font-face url()`
// inside that CSS, `<img src="img/a.png">`) resolve against the app and never
// reach the document's folder: the preview showed fallback fonts and no
// images. The desktop serves them over portuni-html:// (#613); web has no
// such origin, and giving the frame one would mean allow-same-origin.
//
// So before the frame gets the document, the app reads each referenced file
// through the authenticated file API (GET /nodes/:id/file?as=preview-asset)
// and writes it into the document as a data: URL; a stylesheet is processed
// the same way first, so its own url() and @import references load too. The
// frame never talks to the API and keeps its opaque origin.
//
// What loads is what the desktop protocol serves: a file under the document's
// folder (not the folder itself, nothing above it -- `../`, an encoded
// `%2E%2E` or `%2F`, an absolute path) of an allowlisted type (stylesheet,
// web font, image; shared/preview-assets.ts). A refused reference is replaced
// with BLOCKED_URL, so it cannot fall through to a request against the app.
// External URLs (`https:`, `data:`, `//host/…`) and fragment refs
// (`url(#clip)`) stay as they are.
import { previewAssetMime } from "../../../server/shared/preview-assets";

export const BLOCKED_URL = "about:invalid#portuni-preview-blocked";

// Bounds on one document's inlining: total distinct files and how deep
// stylesheets may @import each other (also the cycle guard's backstop).
export const MAX_PREVIEW_ASSETS = 200;
const MAX_IMPORT_DEPTH = 4;

// Base the references resolve against. Never fetched: it only lets the URL
// parser do the browser's own resolution (`..`, `%2e%2e`, `\`, `//host`).
const RESOLVE_ORIGIN = "http://preview.invalid";

export type AssetRef =
  // Not a file of the document's folder: left as written.
  | { kind: "external" }
  // A file under the document's folder of an allowlisted type.
  | { kind: "asset"; path: string; mime: string }
  | { kind: "refused"; reason: string };

function dirOf(relPath: string): string {
  const cut = relPath.lastIndexOf("/");
  return cut < 0 ? "" : relPath.slice(0, cut);
}

const splitDir = (dir: string) => dir.split("/").filter((s) => s.length > 0);

// Where `ref`, written in a file in `fromDir`, points: a mirror-relative
// path under `docDir` (the previewed document's folder), an external URL,
// or a refusal. Both dirs are mirror-relative ("" = the mirror root), and
// `fromDir` is `docDir` or a folder under it.
//
// The document's folder is ONE percent-encoded segment of the base URL, as
// in the desktop's portuni-html:// URL: a `../` that climbs out of it, or an
// absolute `/path`, drops that segment and is refused, also from the mirror
// root (where a plain `/` base would clamp `../a.png` to `/a.png`).
export function resolveAssetRef(docDir: string, fromDir: string, ref: string): AssetRef {
  const trimmed = ref.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return { kind: "external" };
  const docSegs = splitDir(docDir);
  const fromSegs = splitDir(fromDir);
  if (docSegs.some((s, k) => fromSegs[k] !== s)) {
    return { kind: "refused", reason: "referrer outside the document folder" };
  }
  const base = `/${encodeURIComponent(`/${docSegs.join("/")}`)}/`;
  const fromUrl = `${RESOLVE_ORIGIN}${base}${fromSegs
    .slice(docSegs.length)
    .map((s) => `${encodeURIComponent(s)}/`)
    .join("")}`;
  let url: URL;
  try {
    url = new URL(trimmed, fromUrl);
  } catch {
    return { kind: "refused", reason: "unparsable reference" };
  }
  if (url.origin !== RESOLVE_ORIGIN) return { kind: "external" };
  if (url.pathname === base || !url.pathname.startsWith(base)) {
    return { kind: "refused", reason: "leaves the document folder" };
  }
  const segs: string[] = [...docSegs];
  for (const raw of url.pathname.slice(base.length).split("/")) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return { kind: "refused", reason: "malformed escape" };
    }
    if (seg === "" || seg === "." || seg === ".." || /[/\\\0]/.test(seg)) {
      return { kind: "refused", reason: "invalid path segment" };
    }
    segs.push(seg);
  }
  const path = segs.join("/");
  const mime = previewAssetMime(path);
  if (!mime) return { kind: "refused", reason: "not a preview asset type" };
  return { kind: "asset", path, mime };
}

// --- CSS ---------------------------------------------------------------

// `value` as a double-quoted CSS string.
function cssString(value: string): string {
  return `"${value.replace(/["\\]/g, "\\$&").replace(/\n/g, "\\a ")}"`;
}

// Calls `fn` for every url() and every `@import "…"` in `css` (comments and
// other strings skipped, per the CSS Syntax tokenizer's rules for them) and
// splices in what it returns as `url("…")`; null keeps the original text.
export function mapCssUrls(
  css: string,
  fn: (ref: string, isImport: boolean) => string | null,
): string {
  let out = "";
  let i = 0;
  const n = css.length;
  const isWs = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
  const isIdent = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_\-\\\u0080-￿]/.test(c);

  // A quoted string starting at `start` (the quote): its unescaped value
  // and the index just past it. An unterminated string runs to the end.
  const readString = (start: number): { value: string; end: number } => {
    const q = css[start];
    let j = start + 1;
    let value = "";
    while (j < n && css[j] !== q) {
      if (css[j] === "\\" && j + 1 < n) {
        const esc = readEscape(j);
        value += esc.value;
        j = esc.end;
        continue;
      }
      if (css[j] === "\n") break;
      value += css[j];
      j++;
    }
    return { value, end: j < n && css[j] === q ? j + 1 : j };
  };
  // A backslash escape at `start`: hex code point (+ one whitespace), an
  // escaped newline (dropped) or a literal character.
  const readEscape = (start: number): { value: string; end: number } => {
    const hex = /^[0-9A-Fa-f]{1,6}/.exec(css.slice(start + 1, start + 7));
    if (hex) {
      let end = start + 1 + hex[0].length;
      if (end < n && isWs(css[end])) end++;
      const cp = Number.parseInt(hex[0], 16);
      const ok = cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff);
      return { value: ok ? String.fromCodePoint(cp) : "�", end };
    }
    if (css[start + 1] === "\n") return { value: "", end: start + 2 };
    return { value: css[start + 1], end: start + 2 };
  };
  const skipWs = (j: number) => {
    while (j < n && isWs(css[j])) j++;
    return j;
  };
  const emit = (original: string, ref: string, isImport: boolean) => {
    const next = fn(ref, isImport);
    out += next === null ? original : `url(${cssString(next)})`;
  };

  while (i < n) {
    const c = css[i];
    if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      out += css.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      const s = readString(i);
      out += css.slice(i, s.end);
      i = s.end;
      continue;
    }
    if (c === "\\") {
      const esc = readEscape(i);
      out += css.slice(i, esc.end);
      i = esc.end;
      continue;
    }
    if (c === "@" && /^@import\b/i.test(css.slice(i, i + 8)) && !isIdent(css[i + 7])) {
      const j = skipWs(i + 7);
      if (css[j] === '"' || css[j] === "'") {
        out += css.slice(i, j);
        const s = readString(j);
        emit(css.slice(j, s.end), s.value, true);
        i = s.end;
        continue;
      }
      const u = /^url\(/i.test(css.slice(j, j + 4)) ? readUrl(j) : null;
      out += css.slice(i, j);
      if (u) {
        emit(css.slice(j, u.end), u.value, true);
        i = u.end;
      } else {
        i = j;
      }
      continue;
    }
    if ((c === "u" || c === "U") && /^url\(/i.test(css.slice(i, i + 4)) && !isIdent(css[i - 1])) {
      const u = readUrl(i);
      if (u) {
        emit(css.slice(i, u.end), u.value, false);
        i = u.end;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;

  // `url(` at `start`: a quoted argument, or an unquoted url token (which
  // ends at `)` and may not hold quotes, `(` or inner whitespace). Null when
  // it is neither (a bad url, left as written).
  function readUrl(start: number): { value: string; end: number } | null {
    let j = skipWs(start + 4);
    if (css[j] === '"' || css[j] === "'") {
      const s = readString(j);
      j = skipWs(s.end);
      return css[j] === ")" ? { value: s.value, end: j + 1 } : null;
    }
    let value = "";
    while (j < n && css[j] !== ")") {
      const ch = css[j];
      if (isWs(ch)) {
        const k = skipWs(j);
        if (css[k] !== ")") return null;
        j = k;
        break;
      }
      if (ch === '"' || ch === "'" || ch === "(") return null;
      if (ch === "\\") {
        const esc = readEscape(j);
        value += esc.value;
        j = esc.end;
        continue;
      }
      value += ch;
      j++;
    }
    return css[j] === ")" ? { value, end: j + 1 } : null;
  }
}

// --- srcset ------------------------------------------------------------

// The candidates of an img/source srcset: URL plus the descriptor text
// after it (HTML's "parse a srcset attribute", without validating the
// descriptors -- they are written back as they came).
export function parseSrcset(srcset: string): { url: string; descriptor: string }[] {
  const out: { url: string; descriptor: string }[] = [];
  let i = 0;
  const n = srcset.length;
  const isWs = (c: string) => /[ \t\n\r\f]/.test(c);
  while (i < n) {
    while (i < n && (isWs(srcset[i]) || srcset[i] === ",")) i++;
    if (i >= n) break;
    let j = i;
    while (j < n && !isWs(srcset[j])) j++;
    let url = srcset.slice(i, j);
    i = j;
    let descriptor = "";
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
    } else {
      let depth = 0;
      while (i < n) {
        const ch = srcset[i];
        if (ch === "(") depth++;
        else if (ch === ")") depth = Math.max(0, depth - 1);
        else if (ch === "," && depth === 0) break;
        descriptor += ch;
        i++;
      }
      descriptor = descriptor.trim();
    }
    if (url) out.push({ url, descriptor });
  }
  return out;
}

// --- Inlining ----------------------------------------------------------

// Reads a file of the document's node as base64 (the API call; injected so
// the pipeline is testable without a server).
export type FetchPreviewAsset = (relPath: string) => Promise<string>;

// A place in the document that holds references: an attribute holding one
// URL, a srcset attribute, or CSS text (a <style> element, a style
// attribute). `set(null)` drops a single-URL attribute.
export type AssetSlot =
  | { kind: "url"; value: string; set: (value: string | null) => void }
  | { kind: "srcset"; value: string; set: (value: string) => void }
  | { kind: "css"; value: string; set: (value: string) => void };

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function base64ToText(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

class Inliner {
  private readonly cache = new Map<string, Promise<string | null>>();
  changed = false;

  constructor(
    private readonly docDir: string,
    private readonly fetchAsset: FetchPreviewAsset,
  ) {}

  // The data: URL for `ref` written in a file in `fromDir`; null keeps the
  // reference as written (external), BLOCKED_URL replaces a refused or
  // unreadable one.
  async url(ref: string, fromDir: string, imports: readonly string[]): Promise<string | null> {
    const r = resolveAssetRef(this.docDir, fromDir, ref);
    if (r.kind === "external") return null;
    this.changed = true;
    if (r.kind === "refused") return BLOCKED_URL;
    // A stylesheet already being inlined further up the @import chain: the
    // cycle stops here.
    if (imports.includes(r.path) || imports.length > MAX_IMPORT_DEPTH) return BLOCKED_URL;
    let pending = this.cache.get(r.path);
    if (!pending) {
      if (this.cache.size >= MAX_PREVIEW_ASSETS) return BLOCKED_URL;
      pending = this.load(r.path, r.mime, imports).catch(() => null);
      this.cache.set(r.path, pending);
    }
    return (await pending) ?? BLOCKED_URL;
  }

  private async load(path: string, mime: string, imports: readonly string[]): Promise<string> {
    const b64 = await this.fetchAsset(path);
    if (mime !== "text/css") return `data:${mime};base64,${b64}`;
    const css = await this.css(base64ToText(b64), dirOf(path), [...imports, path]);
    return `data:text/css;charset=utf-8;base64,${bytesToBase64(new TextEncoder().encode(css.text))}`;
  }

  // `css` written in a file in `fromDir`, with every url() and @import
  // inlined; `changed` says whether any reference was rewritten.
  async css(
    css: string,
    fromDir: string,
    imports: readonly string[],
  ): Promise<{ text: string; changed: boolean }> {
    const refs = new Set<string>();
    mapCssUrls(css, (ref) => {
      refs.add(ref);
      return null;
    });
    const resolved = new Map<string, string | null>();
    await Promise.all(
      [...refs].map(async (ref) => {
        resolved.set(ref, await this.url(ref, fromDir, imports));
      }),
    );
    const changed = [...resolved.values()].some((v) => v !== null);
    return { text: changed ? mapCssUrls(css, (ref) => resolved.get(ref) ?? null) : css, changed };
  }
}

// Inlines every reference the slots hold, relative to the document at
// `docRelPath` (mirror-relative). Returns whether any slot changed, so the
// caller can keep the original markup when nothing did.
export async function inlinePreviewAssets(
  slots: readonly AssetSlot[],
  docRelPath: string,
  fetchAsset: FetchPreviewAsset,
): Promise<boolean> {
  const docDir = dirOf(docRelPath);
  const inliner = new Inliner(docDir, fetchAsset);
  await Promise.all(
    slots.map(async (slot) => {
      if (slot.kind === "url") {
        const next = await inliner.url(slot.value, docDir, []);
        if (next === BLOCKED_URL) slot.set(null);
        else if (next !== null) slot.set(next);
      } else if (slot.kind === "srcset") {
        const candidates = parseSrcset(slot.value);
        const urls = await Promise.all(candidates.map((c) => inliner.url(c.url, docDir, [])));
        if (urls.every((u) => u === null)) return;
        const kept = candidates
          .map((c, k) => ({ url: urls[k] ?? c.url, descriptor: c.descriptor }))
          .filter((c) => c.url !== BLOCKED_URL);
        slot.set(kept.map((c) => (c.descriptor ? `${c.url} ${c.descriptor}` : c.url)).join(", "));
      } else {
        const next = await inliner.css(slot.value, docDir, []);
        if (next.changed) slot.set(next.text);
      }
    }),
  );
  return inliner.changed;
}

// --- DOM ---------------------------------------------------------------

// The slots of a parsed document: stylesheet and icon links, images
// (src and srcset, also inside <picture>), video posters, SVG <image>,
// <style> blocks and style attributes. Scripts, iframes and links are not
// assets and stay as written.
export function collectAssetSlots(doc: Document): AssetSlot[] {
  const slots: AssetSlot[] = [];
  const attr = (sel: string, name: string, kind: "url" | "srcset") => {
    for (const el of Array.from(doc.querySelectorAll(sel))) {
      const value = el.getAttribute(name);
      if (value === null) continue;
      slots.push({
        kind,
        value,
        set: (v: string | null) => (v === null ? el.removeAttribute(name) : el.setAttribute(name, v)),
      } as AssetSlot);
    }
  };
  attr('link[href][rel~="stylesheet" i]', "href", "url");
  attr('link[href][rel~="icon" i]', "href", "url");
  attr("img[src], source[src], input[type='image' i][src]", "src", "url");
  attr("img[srcset], source[srcset]", "srcset", "srcset");
  attr("video[poster]", "poster", "url");
  attr("image[href]", "href", "url");
  for (const el of Array.from(doc.querySelectorAll("image"))) {
    const value = el.getAttributeNS("http://www.w3.org/1999/xlink", "href");
    if (value === null) continue;
    slots.push({
      kind: "url",
      value,
      set: (v) =>
        v === null
          ? el.removeAttributeNS("http://www.w3.org/1999/xlink", "href")
          : el.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", v),
    });
  }
  for (const el of Array.from(doc.querySelectorAll("style"))) {
    slots.push({ kind: "css", value: el.textContent ?? "", set: (v) => (el.textContent = v) });
  }
  for (const el of Array.from(doc.querySelectorAll("[style]"))) {
    slots.push({
      kind: "css",
      value: el.getAttribute("style") ?? "",
      set: (v) => el.setAttribute("style", v),
    });
  }
  return slots;
}

function serializeDoctype(doc: Document): string {
  const dt = doc.doctype;
  if (!dt) return "";
  if (dt.publicId) return `<!DOCTYPE ${dt.name} PUBLIC "${dt.publicId}"${dt.systemId ? ` "${dt.systemId}"` : ""}>\n`;
  if (dt.systemId) return `<!DOCTYPE ${dt.name} SYSTEM "${dt.systemId}">\n`;
  return `<!DOCTYPE ${dt.name}>\n`;
}

// The srcDoc for the web preview of the HTML at `docRelPath`: its relative
// stylesheets, fonts and images inlined as data: URLs. Markup unchanged when
// nothing in it pointed into the document's folder.
export async function buildPreviewSrcDoc(
  html: string,
  docRelPath: string,
  fetchAsset: FetchPreviewAsset,
): Promise<string> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const changed = await inlinePreviewAssets(collectAssetSlots(doc), docRelPath, fetchAsset);
  if (!changed) return html;
  return serializeDoctype(doc) + doc.documentElement.outerHTML;
}
