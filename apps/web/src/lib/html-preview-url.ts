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
