// URL the desktop HTML preview iframe loads over the portuni-html:// custom
// protocol: portuni-html://localhost/<document dir>/<file name>, each part
// percent-encoded as ONE path segment. The Rust handler decodes them,
// scope-checks against the window's mirror and reads the file from disk.
//
// The folder is its own segment so the document's relative references
// resolve under it: `fonts/fonts-local.css`, an `@font-face url()` inside
// that CSS and `<img src="img/a.png">` become further segments the handler
// serves from the document's folder. With the whole path as a single
// segment they resolved to portuni-html://localhost/fonts/..., which the
// handler could not place, and the preview fell back to default fonts and
// broken images. A `../` reference drops the folder segment and is refused.
//
// The loaded file's version (sha256 from the file API) rides along as a
// query param. The handler ignores the query (it only reads the path), but
// an iframe only navigates when its `src` changes: with a bare path URL,
// "Načíst aktuální verzi" after an on-disk edit re-fetched the JSON content
// and left the iframe -- the thing actually on screen on desktop -- showing
// the old document. Keying the URL on the version turns every reload into a
// fresh request to the handler, which reads the current bytes.
export function protocolUrl(absPath: string, version: string | null): string {
  const cut = absPath.lastIndexOf("/");
  const dir = cut > 0 ? absPath.slice(0, cut) : "/";
  const file = absPath.slice(cut + 1);
  const base = `portuni-html://localhost/${encodeURIComponent(dir)}/${encodeURIComponent(file)}`;
  return version === null ? base : `${base}?v=${encodeURIComponent(version)}`;
}
