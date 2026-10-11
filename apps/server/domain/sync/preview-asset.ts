// Byte read of a stylesheet, font or image an HTML preview pulls in from its
// document's folder (GET /nodes/:id/file?as=preview-asset). The text read
// (readFileContent) refuses binary files and the base64 read
// (readFileBytesRemote) only reaches the remote, so a font that sits only in
// the mirror had no read at all. Mirror-local half here; the remote half is
// readFileBytesRemote, picked by the router like every other file read.

import { readFile } from "node:fs/promises";
import { getMirrorPath } from "./mirror-registry.js";
import { FileContentError, fileNotFoundError, resolveMirrorAbs } from "./file-content.js";
import { sha256Buffer } from "./hash.js";
import { previewAssetMime } from "../../shared/preview-assets.js";

// The allowlist check every preview-asset read starts with: the type the
// asset is served as, or INVALID_PATH for a script, a data file or anything
// else outside the list.
export function requirePreviewAssetMime(relPath: string): string {
  const mime = previewAssetMime(relPath);
  if (!mime) {
    throw new FileContentError(`not a preview asset type: ${relPath}`, "INVALID_PATH", undefined, {
      path: relPath,
    });
  }
  return mime;
}

export async function readPreviewAssetLocal(a: {
  userId: string;
  nodeId: string;
  relPath: string;
}): Promise<{ bytes: Buffer; version: string; mime_type: string }> {
  const mime = requirePreviewAssetMime(a.relPath);
  const mirrorRoot = await getMirrorPath(a.userId, a.nodeId);
  if (!mirrorRoot) throw new FileContentError("node has no local mirror", "NO_MIRROR");
  const abs = resolveMirrorAbs(mirrorRoot, a.relPath);
  let bytes: Buffer;
  try {
    bytes = await readFile(abs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // A folder under the asset's name reads as missing, not as a 500.
    if (code === "ENOENT" || code === "EISDIR") throw fileNotFoundError(a.relPath);
    throw e;
  }
  return { bytes, version: sha256Buffer(bytes), mime_type: mime };
}
