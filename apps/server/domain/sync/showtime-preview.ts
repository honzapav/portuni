// Preview of a Showtime deck. A `.showtime` file is a zip (Markdown, theme,
// assets, comments, history) that only Showtime can render, so Showtime writes
// the rendered deck into the bundle at every save as `preview.html` -- one
// self-contained document, theme and assets inlined. Portuni never renders
// Marp itself: it pulls that one entry out of the zip and serves it the way
// it serves any HTML file. A bundle saved by a Showtime older than that
// carries no preview and reads as NO_PREVIEW, never as garbage text.
//
// The zip reader here is deliberately minimal: central directory, stored or
// deflated entries, no zip64 (a deck bundle is kilobytes, not gigabytes) --
// enough to avoid a dependency for one entry lookup.

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { Client } from "@libsql/client";
import { FileContentError, resolveMirrorAbs } from "./file-content.js";
import { readFileBytesRemote } from "./file-content-remote.js";
import { sha256Buffer } from "./hash.js";
import { getMirrorPath } from "./mirror-registry.js";

export const SHOWTIME_EXTENSION = ".showtime";
export const SHOWTIME_PREVIEW_ENTRY = "preview.html";

export function isShowtimePath(relPath: string): boolean {
  return relPath.toLowerCase().endsWith(SHOWTIME_EXTENSION);
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const EOCD_MIN = 22;
// EOCD may be followed by a comment of up to 65535 bytes.
const EOCD_SCAN = EOCD_MIN + 0xffff;

// Bytes of one top-level entry of a zip archive, or null when the archive
// holds no entry of that exact name. Throws on bytes that are not a zip and
// on compression methods other than stored/deflate.
export function extractZipEntry(zip: Buffer, name: string): Buffer | null {
  const eocd = findEocd(zip);
  if (eocd < 0) throw new Error("not a zip archive (no end-of-central-directory record)");
  const entryCount = zip.readUInt16LE(eocd + 10);
  const cdSize = zip.readUInt32LE(eocd + 12);
  const cdOffset = zip.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error("zip64 archives are not supported");
  }
  if (cdOffset + cdSize > zip.length) throw new Error("zip central directory out of bounds");

  let pos = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (pos + 46 > zip.length || zip.readUInt32LE(pos) !== SIG_CENTRAL) {
      throw new Error("zip central directory is corrupt");
    }
    const method = zip.readUInt16LE(pos + 10);
    const compressedSize = zip.readUInt32LE(pos + 20);
    const nameLen = zip.readUInt16LE(pos + 28);
    const extraLen = zip.readUInt16LE(pos + 30);
    const commentLen = zip.readUInt16LE(pos + 32);
    const localOffset = zip.readUInt32LE(pos + 42);
    const entryName = zip.toString("utf8", pos + 46, pos + 46 + nameLen);
    pos += 46 + nameLen + extraLen + commentLen;
    if (entryName !== name) continue;

    if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new Error("zip local header is corrupt");
    }
    const localNameLen = zip.readUInt16LE(localOffset + 26);
    const localExtraLen = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > zip.length) throw new Error("zip entry data out of bounds");
    const data = zip.subarray(dataStart, dataEnd);
    if (method === 0) return Buffer.from(data);
    if (method === 8) return inflateRawSync(data);
    throw new Error(`unsupported zip compression method ${method}`);
  }
  return null;
}

function findEocd(zip: Buffer): number {
  const stop = Math.max(0, zip.length - EOCD_SCAN);
  for (let i = zip.length - EOCD_MIN; i >= stop; i--) {
    if (zip.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

// The bundled preview of a `.showtime` file, shaped like a file-content read
// so the GET /nodes/:id/file handler can serve it in place of the bytes: the
// HTML as `content`, the bundle's own sha256 as `version` (a re-save rewrites
// the preview, so the bundle hash is the right change signal), the bundle's
// filename and, from a local mirror, its absolute path (the desktop preview
// hands that path to the portuni-html protocol, which unzips it itself).
export async function readShowtimePreview(
  db: Client,
  a: { userId: string; nodeId: string; relPath: string },
): Promise<{
  content: string;
  version: string;
  filename: string;
  mime_type: string;
  local_path: string | null;
}> {
  if (!isShowtimePath(a.relPath)) {
    throw new FileContentError(`not a .showtime bundle: ${a.relPath}`, "INVALID_PATH");
  }
  const mirrorRoot = await getMirrorPath(a.userId, a.nodeId);
  let bytes: Buffer;
  let localPath: string | null = null;
  let filename: string;
  if (mirrorRoot) {
    const abs = resolveMirrorAbs(mirrorRoot, a.relPath);
    try {
      bytes = await readFile(abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        throw new FileContentError(`file not found: ${a.relPath}`, "NOT_FOUND");
      }
      throw e;
    }
    localPath = abs;
    filename = basename(abs);
  } else {
    const r = await readFileBytesRemote(db, { nodeId: a.nodeId, relPath: a.relPath });
    bytes = r.bytes;
    filename = r.filename;
  }

  let entry: Buffer | null;
  try {
    entry = extractZipEntry(bytes, SHOWTIME_PREVIEW_ENTRY);
  } catch (e) {
    throw new FileContentError(
      `not a readable .showtime bundle (${(e as Error).message}): ${a.relPath}`,
      "NO_PREVIEW",
    );
  }
  if (!entry) {
    throw new FileContentError(
      `bundle carries no ${SHOWTIME_PREVIEW_ENTRY}; save it with a newer Showtime: ${a.relPath}`,
      "NO_PREVIEW",
    );
  }
  return {
    content: entry.toString("utf8"),
    version: sha256Buffer(bytes),
    filename,
    mime_type: "text/html",
    local_path: localPath,
  };
}
