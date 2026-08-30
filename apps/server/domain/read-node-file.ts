// Read a file's content for portuni_read_file. This is the universal
// (no-hooks) read channel for ad-hoc in-scope nodes: they are not granted
// disk access by the seatbelt (only home + depth-1 neighbours are), so
// instead of a stale staged copy the agent asks portuni_read_file and the
// server -- which is not sandboxed -- reads the live file and returns it.
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

import { readFile } from "node:fs/promises";
import type { Client } from "@libsql/client";
import { getMirrorPath } from "./sync/mirror-registry.js";
import { readFileBytesRemote } from "./sync/file-content-remote.js";
import { FileContentError } from "./sync/file-content.js";
import { ensureUnderRoot } from "../shared/safe-path.js";

// Guardrail: portuni_read_file returns whole-file content inline. Very large
// files belong to the native-FS path (bring the node into the working set),
// not this tool -- cap the inline payload so a huge file can't blow the
// context window.
export const MAX_READ_BYTES = 1_000_000;

export type NodeFileContent =
  | { kind: "text"; text: string }
  | { kind: "binary"; base64: string; bytes: number }
  | { kind: "too_large"; bytes: number }
  | { kind: "no_mirror" }
  | { kind: "no_remote" }
  | { kind: "native_format" }
  | { kind: "not_found" };

function classifyBytes(bytes: Buffer): NodeFileContent {
  if (bytes.length > MAX_READ_BYTES) return { kind: "too_large", bytes: bytes.length };
  // NUL byte => treat as binary and hand back base64.
  if (bytes.includes(0)) {
    return { kind: "binary", base64: bytes.toString("base64"), bytes: bytes.length };
  }
  return { kind: "text", text: bytes.toString("utf8") };
}

export async function readNodeFileFromMirror(
  userId: string,
  nodeId: string,
  relPath: string,
): Promise<NodeFileContent> {
  const mirror = await getMirrorPath(userId, nodeId);
  if (!mirror) return { kind: "no_mirror" };
  let abs: string;
  try {
    abs = ensureUnderRoot(mirror, relPath);
  } catch {
    return { kind: "not_found" };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(abs);
  } catch {
    return { kind: "not_found" };
  }
  return classifyBytes(bytes);
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
  let r: Awaited<ReturnType<typeof readFileBytesRemote>>;
  try {
    r = await readFileBytesRemote(db, { nodeId, relPath });
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
  return classifyBytes(r.bytes);
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
            text: `File is ${r.bytes} bytes, over the ${MAX_READ_BYTES}-byte inline limit. Bring the node into your working set to read it natively.`,
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
