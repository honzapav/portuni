// Files an HTML preview may pull in by relative path from the document's
// folder: stylesheets, web fonts and images. Same list as the desktop's
// portuni-html:// protocol (preview_asset_mime in apps/desktop/src/lib.rs);
// anything else -- scripts, data, .env, markdown -- the preview refuses.
//
// Shared by the server (GET /nodes/:id/file?as=preview-asset refuses other
// types) and the web preview (which inlines what it loads as data: URLs, so
// the content type here is the one the frame sees).
const PREVIEW_ASSET_MIME: Readonly<Record<string, string>> = {
  css: "text/css",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
};

// Content type of a preview asset by its extension, or null when the
// preview must not load the file.
export function previewAssetMime(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return PREVIEW_ASSET_MIME[name.slice(dot + 1).toLowerCase()] ?? null;
}
