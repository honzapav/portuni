// Read a file's content for portuni_read_file. This is the universal
// (no-hooks) read channel for ad-hoc in-scope nodes: the seatbelt only
// grants a real mirror path for home + depth-1 neighbours; an ad-hoc node
// with a local mirror also gets hardlinked into the session's projection
// directory (domain/session-projection.ts) so it becomes readable on disk
// too, but a node with no local mirror on this device has no disk path at
// all -- portuni_read_file is the one channel that always works, since the
// server (unsandboxed) reads the live file or falls back to the remote.
//
// Two sources, tried in order by readNodeFile:
//   1. the node's local mirror on disk (readNodeFileFromMirror);
//   2. when this machine has no mirror for the node (central server, VPS,
//      a remote client with no local workspace), the routed remote directly
//      (readNodeFileFromRemote) -- the same Drive-direct path GET
//      /nodes/:id/file takes.
//
// Path safety: relPath is joined under the mirror root via ensureUnderRoot,
// which rejects any traversal that would escape the mirror; the remote path
// goes through the same validation buildRemotePath applies.

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import type { Client } from "@libsql/client";
import { getMirrorPath } from "./sync/mirror-registry.js";
import { readFileBytesRemote } from "./sync/file-content-remote.js";
import { FileContentError } from "./sync/file-content.js";
import { ensureUnderRoot } from "../shared/safe-path.js";

// Guardrail: portuni_read_file returns whole-file content inline. Very large
// files belong to the disk-path path (as_path, or the too_large refusal
// pointing at it -- see mcp/read-file-spill.ts), not this tool -- cap the
// inline payload so a huge file can't blow the context window.
export const MAX_READ_BYTES = 1_000_000;

export type NodeFileContent =
  | { kind: "text"; text: string }
  | { kind: "binary"; base64: string; bytes: number }
  // raw carries the full bytes (already read once to classify) so a caller
  // that needs to spill an oversized file to disk (mcp/read-file-spill.ts)
  // does not have to re-fetch it a second time.
  | { kind: "too_large"; bytes: number; raw: Buffer }
  | { kind: "no_mirror" }
  | { kind: "no_remote" }
  | { kind: "native_format" }
  | { kind: "not_found" };

// Exported for mcp/read-file-spill.ts, which fetches raw bytes itself (via a
// db-backed read in local mode, or CentralClient.getFileRaw in agent mode)
// and classifies them locally rather than through readNodeFile*.
export function classifyBytes(bytes: Buffer): NodeFileContent {
  if (bytes.length > MAX_READ_BYTES) return { kind: "too_large", bytes: bytes.length, raw: bytes };
  // NUL byte => treat as binary and hand back base64.
  if (bytes.includes(0)) {
    return { kind: "binary", base64: bytes.toString("base64"), bytes: bytes.length };
  }
  return { kind: "text", text: bytes.toString("utf8") };
}

type RawResult =
  | { kind: "ok"; bytes: Buffer }
  | { kind: "no_mirror" }
  | { kind: "no_remote" }
  | { kind: "native_format" }
  | { kind: "not_found" };

async function rawFromMirror(
  userId: string,
  nodeId: string,
  relPath: string,
): Promise<Exclude<RawResult, { kind: "no_remote" } | { kind: "native_format" }>> {
  const mirror = await getMirrorPath(userId, nodeId);
  if (!mirror) return { kind: "no_mirror" };
  let abs: string;
  try {
    abs = ensureUnderRoot(mirror, relPath);
  } catch {
    return { kind: "not_found" };
  }
  try {
    return { kind: "ok", bytes: await readFile(abs) };
  } catch {
    return { kind: "not_found" };
  }
}

// Drive-direct fetch against the node's routed remote, for a server with no
// mirror of the node. Adapter/transport failures propagate; only the
// "expected" outcomes are mapped onto RawResult.
async function rawFromRemote(
  db: Client,
  nodeId: string,
  relPath: string,
): Promise<Exclude<RawResult, { kind: "no_mirror" }>> {
  try {
    const r = await readFileBytesRemote(db, { nodeId, relPath });
    return { kind: "ok", bytes: r.bytes };
  } catch (e) {
    if (e instanceof FileContentError) {
      switch (e.code) {
        case "NOT_FOUND":
        case "INVALID_PATH":
          return { kind: "not_found" };
        case "NO_REMOTE":
          return { kind: "no_remote" };
        case "NOT_EDITABLE":
          return { kind: "native_format" };
        default:
          break;
      }
    }
    throw e;
  }
}

export async function readNodeFileFromMirror(
  userId: string,
  nodeId: string,
  relPath: string,
): Promise<NodeFileContent> {
  const r = await rawFromMirror(userId, nodeId, relPath);
  return r.kind === "ok" ? classifyBytes(r.bytes) : r;
}

// Drive-direct read against the node's routed remote, for a server with no
// mirror of the node. Adapter/transport failures propagate (the tool then
// reports them as an error result); only the "expected" outcomes are mapped
// onto NodeFileContent.
export async function readNodeFileFromRemote(
  db: Client,
  nodeId: string,
  relPath: string,
): Promise<NodeFileContent> {
  const r = await rawFromRemote(db, nodeId, relPath);
  return r.kind === "ok" ? classifyBytes(r.bytes) : r;
}

// Mirror first, remote when this machine holds no mirror of the node.
export async function readNodeFile(
  db: Client,
  userId: string,
  nodeId: string,
  relPath: string,
): Promise<NodeFileContent> {
  const local = await readNodeFileFromMirror(userId, nodeId, relPath);
  if (local.kind !== "no_mirror") return local;
  return readNodeFileFromRemote(db, nodeId, relPath);
}

// Raw bytes, no size cap and no text/binary classification: mirror first,
// remote fallback when this machine holds no mirror of the node. Used by the
// read-file spill path (mcp/read-file-spill.ts) to write a node's file to
// disk when it has no local mirror to hardlink from.
export async function readNodeFileRaw(
  db: Client,
  userId: string,
  nodeId: string,
  relPath: string,
): Promise<Exclude<RawResult, { kind: "no_mirror" }>> {
  const local = await rawFromMirror(userId, nodeId, relPath);
  if (local.kind !== "no_mirror") return local;
  return rawFromRemote(db, nodeId, relPath);
}

// Write bytes to a path inside a session's projection directory, creating
// any missing parent directories. Used to spill a node's content there
// when it has no local mirror to hardlink from instead.
export async function writeBytesToPath(destPath: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, bytes);
}

// Coarse extension-based MIME guess for a spilled file. Good enough for the
// agent to decide how to open the path (e.g. treat .pdf/.html specially);
// exact accuracy is not load-bearing since the agent reads the file itself.
const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".html": "text/html",
  ".htm": "text/html",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".zip": "application/zip",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
};

export function mimeFromExtension(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";
}

// Render a NodeFileContent as an MCP tool result. Shared by the local tool
// (mcp/tools/files.ts) and the central-mode front door (mcp/agent-transport.ts)
// so both surfaces return identical shapes.
export function formatNodeFileContent(
  r: NodeFileContent,
  path: string,
): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  switch (r.kind) {
    case "text":
      return { content: [{ type: "text", text: r.text }] };
    case "binary":
      return {
        content: [{ type: "text", text: `[binary file, ${r.bytes} bytes, base64]\n${r.base64}` }],
      };
    case "too_large":
      return {
        content: [
          {
            type: "text",
            text: `File is ${r.bytes} bytes, over the ${MAX_READ_BYTES}-byte inline limit. Call again with as_path: true to get a disk path you can Read/Grep natively, or portuni_expand_scope this node and read its readable_path from portuni_get_node.`,
          },
        ],
        isError: true,
      };
    case "no_mirror":
      return {
        content: [
          {
            type: "text",
            text: `Node is not mirrored on this device. portuni_pull it (or a specific file) first.`,
          },
        ],
        isError: true,
      };
    case "no_remote":
      return {
        content: [
          {
            type: "text",
            text: `Node is not mirrored on this device and has no routed remote to read from. portuni_pull it first, or configure routing (portuni_set_routing_policy).`,
          },
        ],
        isError: true,
      };
    case "native_format":
      return {
        content: [
          {
            type: "text",
            text: `File ${path} is a native Google format (Doc/Sheet/Slides) and has no byte content to return. Open it via its Drive URL (portuni_list_files -> remote_path, or the node's folder link).`,
          },
        ],
        isError: true,
      };
    case "not_found":
      return { content: [{ type: "text", text: `No such file: ${path}` }], isError: true };
  }
}
