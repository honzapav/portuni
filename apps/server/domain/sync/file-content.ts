// Path-based read/write of file content inside a node's local mirror.
// Serves both tracked and untracked files (it only resolves a mirror-relative
// path to disk; registration is a separate concern).
// writeFileContent is local-only: it writes the mirror file and never pushes
// -- the sync run / statusScan picks up the change as a push candidate.
// createFile registers + pushes immediately via storeFile (a new tracked
// file needs a remote binding). Conflict detection on writeFileContent
// compares the on-disk sha256 against the caller's baseVersion so a
// concurrent terminal-agent edit is never silently clobbered.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { Client } from "@libsql/client";
import { getMirrorPath } from "./mirror-registry.js";
import { mimeFor, storeFile } from "./engine.js";
import { sha256Buffer } from "./hash.js";
import { safeMirrorJoin, type Section } from "./remote-path.js";

export type FileContentErrorCode =
  | "NO_MIRROR"
  | "NO_REMOTE"
  | "NOT_FOUND"
  | "NOT_EDITABLE"
  | "CONFLICT"
  | "EXISTS"
  | "INVALID_PATH";

export class FileContentError extends Error {
  constructor(
    message: string,
    readonly code: FileContentErrorCode,
    readonly currentVersion?: string,
  ) {
    super(message);
    this.name = "FileContentError";
  }
}

// Editable = text-ish. Unknown extension (null mime) is treated as text so
// .mdx/.yaml/.toml open; known binary types are rejected. A NUL byte in the
// bytes is a hard binary signal even if the extension lied.
function isEditableMime(mime: string | null): boolean {
  if (mime === null) return true;
  if (mime.startsWith("text/")) return true;
  if (mime === "application/json") return true;
  return false;
}

function resolveAbs(mirrorRoot: string, relPath: string): string {
  const segments = relPath.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) {
    throw new FileContentError("empty path", "INVALID_PATH");
  }
  try {
    return safeMirrorJoin(mirrorRoot, ...segments);
  } catch {
    throw new FileContentError(`invalid path: ${relPath}`, "INVALID_PATH");
  }
}

export async function readFileContent(
  _db: Client,
  a: { userId: string; nodeId: string; relPath: string },
): Promise<{
  content: string;
  version: string;
  filename: string;
  mime_type: string | null;
  local_path: string;
}> {
  const mirrorRoot = await getMirrorPath(a.userId, a.nodeId);
  if (!mirrorRoot) throw new FileContentError("node has no local mirror", "NO_MIRROR");
  const abs = resolveAbs(mirrorRoot, a.relPath);
  const filename = basename(abs);
  const mime = mimeFor(filename);

  let buf: Buffer;
  try {
    buf = await readFile(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new FileContentError(`file not found: ${a.relPath}`, "NOT_FOUND");
    }
    throw e;
  }
  if (!isEditableMime(mime) || buf.includes(0)) {
    throw new FileContentError(`file is not editable text: ${a.relPath}`, "NOT_EDITABLE");
  }
  return {
    content: buf.toString("utf8"),
    version: sha256Buffer(buf),
    filename,
    mime_type: mime,
    local_path: abs,
  };
}

export async function writeFileContent(
  _db: Client,
  a: {
    userId: string;
    nodeId: string;
    relPath: string;
    content: string;
    baseVersion?: string;
    force?: boolean;
  },
): Promise<{ version: string }> {
  const mirrorRoot = await getMirrorPath(a.userId, a.nodeId);
  if (!mirrorRoot) throw new FileContentError("node has no local mirror", "NO_MIRROR");
  const abs = resolveAbs(mirrorRoot, a.relPath);

  if (a.baseVersion && !a.force) {
    let current: Buffer | null = null;
    try {
      current = await readFile(abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (current) {
      const currentVersion = sha256Buffer(current);
      if (currentVersion !== a.baseVersion) {
        throw new FileContentError(
          "file changed on disk since it was opened",
          "CONFLICT",
          currentVersion,
        );
      }
    }
  }

  await mkdir(dirname(abs), { recursive: true });
  const bytes = Buffer.from(a.content, "utf8");
  await writeFile(abs, bytes);
  return { version: sha256Buffer(bytes) };
}

export async function createFile(
  db: Client,
  a: {
    userId: string;
    nodeId: string;
    filename: string;
    section?: Section;
    subpath?: string | null;
    content?: string;
  },
): Promise<{
  id: string;
  filename: string;
  status: string;
  description: string | null;
  local_path: string;
  relative_path: string;
  mime_type: string | null;
}> {
  const mirrorRoot = await getMirrorPath(a.userId, a.nodeId);
  if (!mirrorRoot) throw new FileContentError("node has no local mirror", "NO_MIRROR");
  const section: Section = a.section ?? "wip";
  const fn = a.filename;
  if (!fn || fn.includes("/") || fn.includes("\\") || fn.includes("\0") || fn === "." || fn === "..") {
    throw new FileContentError(`invalid filename: ${a.filename}`, "INVALID_PATH");
  }
  const subSegs = a.subpath ? a.subpath.split("/").filter((s) => s.length > 0) : [];
  let abs: string;
  try {
    abs = safeMirrorJoin(mirrorRoot, section, ...subSegs, fn);
  } catch {
    throw new FileContentError("invalid path", "INVALID_PATH");
  }

  // Refuse to clobber an existing file.
  try {
    await readFile(abs);
    throw new FileContentError(`file already exists: ${fn}`, "EXISTS");
  } catch (e) {
    if (e instanceof FileContentError) throw e;
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, Buffer.from(a.content ?? "", "utf8"));

  // Register + push. storeFile detects the file is already inside the mirror
  // (subpathFromMirror) and skips the copy, uploads, and upserts the row.
  const stored = await storeFile(db, {
    userId: a.userId,
    nodeId: a.nodeId,
    localPath: abs,
    status: section === "outputs" ? "output" : "wip",
  });

  const relative_path = abs.startsWith(mirrorRoot + "/")
    ? abs.slice(mirrorRoot.length + 1)
    : [section, ...subSegs, fn].join("/");
  return {
    id: stored.file_id,
    filename: fn,
    status: section === "outputs" ? "output" : "wip",
    description: null,
    local_path: abs,
    relative_path,
    mime_type: mimeFor(fn),
  };
}
