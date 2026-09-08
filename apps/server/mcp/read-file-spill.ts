// Serve portuni_read_file either inline (the common case: small text/binary
// content) or spilled to a disk path when the file is over the inline limit
// or the caller passed as_path -- see #252 ("expand_scope leaves the added
// node unreadable on disk, and read_file has no way past the 1 MB limit").
//
// Direction (issue #252 comment, 2026-09-08): do not add chunked reads
// (offset/length) -- every chunk would still pass through the model's
// context with no server-side grep, so the agent would page blindly through
// a large file. Instead spill the bytes to
// <projectionRoot>/<projectionSessionId>/<nodeId>/<relPath>, the directory
// the Seatbelt profile already grants this session read-only access to
// (domain/sandbox-profile.ts, domain/session-projection.ts), and return
// { path, bytes, mime } so the agent uses its own Read/Grep with offsets.
//
// Two sources for the spilled bytes, shared by both the local mode tool
// (mcp/tools/files.ts, backed by the graph db) and the central-mode agent
// front door (mcp/agent-transport.ts, backed by CentralClient over REST --
// see the `remote` parameter):
// - the node HAS a local mirror on this device: DiskProjector.projectNode
//   already hardlinks the whole node under the session's projection
//   directory (no data duplication, always current) -- the spilled path is
//   just that directory + the file's relative path. The home node's own
//   files need no projection at all: its real mirror is already granted.
// - the node has NO local mirror here (central/remote-only): the bytes are
//   fetched once (uncapped -- REST/db reads are not bound by the MCP
//   tool-result inline limit) and written into the same session-scoped
//   directory (a real copy, since there is no local source to hardlink
//   from).

import { join } from "node:path";
import { stat } from "node:fs/promises";
import { getMirrorPath } from "../domain/sync/mirror-registry.js";
import { resolveProjectionRootForNode } from "../domain/sandbox-profile.js";
import { nodeProjectionDir } from "../domain/session-projection.js";
import {
  readNodeFileFromMirror,
  writeBytesToPath,
  mimeFromExtension,
  classifyBytes,
  formatNodeFileContent,
  type NodeFileContent,
} from "../domain/read-node-file.js";
import type { DiskProjector } from "./disk-projection.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function spilledResult(path: string, bytes: number, relPath: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ path, bytes, mime: mimeFromExtension(relPath) }),
      },
    ],
  };
}

// Fetches a node file's raw bytes when it has no local mirror on this
// device. Uncapped by design -- MAX_READ_BYTES only bounds what may be
// inlined into a tool result, not what may be spilled to disk.
export type RemoteRawFetch = (
  nodeId: string,
  relPath: string,
) => Promise<Exclude<NodeFileContent, { kind: "text" | "binary" | "too_large" }> | { kind: "ok"; bytes: Buffer }>;

export interface ReadFileOrSpillArgs {
  userId: string;
  homeNodeId: string | null;
  projectionSessionId: string | null;
  projector: DiskProjector;
  nodeId: string;
  relPath: string;
  asPath: boolean;
  remote: RemoteRawFetch;
}

export async function readFileOrSpill(args: ReadFileOrSpillArgs): Promise<ToolResult> {
  const { userId, homeNodeId, projectionSessionId, projector, nodeId, relPath, asPath, remote } = args;
  const mirrorPath = await getMirrorPath(userId, nodeId);

  if (mirrorPath) {
    if (!asPath) {
      const r = await readNodeFileFromMirror(userId, nodeId, relPath);
      if (r.kind !== "too_large") return formatNodeFileContent(r, relPath);
    }
    const dir =
      nodeId === homeNodeId
        ? mirrorPath
        : await projector.projectNode(nodeId).then((o) => (o.kind === "projected" ? o.dir : null));
    if (dir) {
      const spillPath = join(dir, relPath);
      try {
        const st = await stat(spillPath);
        return spilledResult(spillPath, st.size, relPath);
      } catch {
        /* file missing at the projected/real path -- fall through to inline below */
      }
    }
    const r = await readNodeFileFromMirror(userId, nodeId, relPath);
    return formatNodeFileContent(r, relPath);
  }

  // No local mirror on this device: fetch the raw bytes (uncapped) and
  // classify them ourselves, so a caller that only knows how to fetch raw
  // bytes (agent-transport.ts's CentralClient-backed fetch) does not also
  // need to reimplement the inline-vs-spill decision.
  const raw = await remote(nodeId, relPath);
  if (raw.kind !== "ok") return formatNodeFileContent(raw, relPath);
  if (!asPath) {
    const classified = classifyBytes(raw.bytes);
    if (classified.kind !== "too_large") return formatNodeFileContent(classified, relPath);
  }
  if (homeNodeId && projectionSessionId) {
    const root = await resolveProjectionRootForNode(userId, homeNodeId);
    if (root) {
      const destPath = join(
        nodeProjectionDir(root.projectionRoot, projectionSessionId, nodeId),
        relPath,
      );
      await writeBytesToPath(destPath, raw.bytes);
      return spilledResult(destPath, raw.bytes.length, relPath);
    }
  }
  // No home node bound to this session (e.g. interactive_chat), or no
  // projection root resolvable -- nowhere to spill to. classifyBytes still
  // enforces the inline cap, so this never dumps an oversized payload.
  return formatNodeFileContent(classifyBytes(raw.bytes), relPath);
}
