// REST router for the central-mode sync agent (teammate mirrors). The
// sidecar in agent mode serves ONLY the local-only surface -- mirror
// creation, sync status/run, cross-mirror pending, write-scope and sandbox
// profiles -- backed by the central engine. Everything graph-shaped goes to
// the central server directly (the desktop proxy routes it there), so any
// other path landing here answers 501 agent_mode instead of a confusing 404.
//
// Response shapes intentionally mirror api/nodes.ts + api/write-scope.ts so
// the webview cannot tell which engine served it.
//
// Identity: the local env-token gate (loopback + per-launch token). Real
// authorization happens on the central server -- every graph-plane call the
// engine makes carries the user's device token.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Client } from "@libsql/client";
import { z } from "zod";
import type { RequestIdentity } from "../auth/request-identity.js";
import { parseBody, parseJsonBody, respondError, respondJson } from "../http/middleware.js";
import { handleHealth } from "./health.js";
import { handleWriteScope } from "./write-scope.js";
import type { CentralClient } from "../domain/sync/central/client.js";
import { CentralHttpError } from "../domain/sync/central/client.js";
import {
  readFileContent,
  writeFileContent,
  FileContentError,
  type FileContentErrorCode,
} from "../domain/sync/file-content.js";
import {
  computeSyncPendingCentral,
  createMirrorForNodeCentral,
  statusScanCentral,
  storeFileCentral,
  pullFileCentral,
  syncRunCentral,
} from "../domain/sync/central/engine-central.js";
import { findEntryByFileId } from "../mcp/agent-tools.js";
import { mimeFor } from "../domain/sync/engine.js";
import { getLocalMirror } from "../domain/sync/local-db.js";
import { MirrorCreateError } from "../domain/sync/mirror-create.js";
import {
  buildSeatbeltProfile,
  resolveNeighbourReadMirrors,
  resolveSandboxScopeForCwd,
  resolveSandboxScopeForNode,
} from "../domain/sandbox-profile.js";
import type {
  FileContentResponse,
  NodeMirrorResponse,
  SyncStatusResponse,
  UntrackedFile,
} from "../shared/api-types.js";

// The sandbox resolvers take a db parameter their implementations no longer
// touch (mirror registry + env only). The agent has no graph db; passing
// this sentinel documents the contract instead of hiding it.
const NO_DB = null as unknown as Client;

// Central-mode read-grant set: the local graph replica is empty in central
// mode, so depth-1 neighbours come from central node-detail, then map to
// this device's mirrors (resolveNeighbourReadMirrors). Best-effort -- a
// central hiccup degrades to a home-only profile, never a spawn failure.
async function neighbourReadMirrorsCentral(
  client: CentralClient,
  userId: string,
  nodeId: string,
  homeMirror: string,
): Promise<string[]> {
  try {
    const ids = await client.nodeNeighbours(nodeId);
    return await resolveNeighbourReadMirrors(userId, ids, homeMirror);
  } catch {
    return [];
  }
}

function respondCentral404(res: ServerResponse, err: unknown): boolean {
  if (err instanceof CentralHttpError && err.status === 404) {
    respondJson(res, 404, { error: "node not found" });
    return true;
  }
  return false;
}

// --- File content over the device mirror -------------------------------
//
// GET/PUT /nodes/:id/file route HERE in central mode (Rust is_local_only_path)
// so the editor/preview works on files that exist only on this device --
// registered-but-unpushed or untracked mirror files are absent on the remote,
// and the central Drive-direct read would 404 them. A node with a local
// mirror reads/writes the mirror (same semantics as local mode: save is
// local-only, sync pushes later); without a mirror -- or when the file is
// pull-pending (registered remotely, not yet on disk) -- the call falls
// through to central via the device token, preserving today's behaviour.

// Status mapping for FileContentError, same table as api/files.ts.
const AGENT_CODE_STATUS: Record<FileContentErrorCode, number> = {
  NO_MIRROR: 409,
  NO_REMOTE: 409,
  NOT_FOUND: 404,
  NOT_EDITABLE: 415,
  CONFLICT: 409,
  EXISTS: 409,
  INVALID_PATH: 400,
};

function respondFileContentError(res: ServerResponse, err: unknown): boolean {
  if (err instanceof FileContentError) {
    const body: Record<string, unknown> = { error: err.message, code: err.code };
    if (err.code === "CONFLICT" && err.currentVersion) {
      body.currentVersion = err.currentVersion;
    }
    respondJson(res, AGENT_CODE_STATUS[err.code], body);
    return true;
  }
  return false;
}

// Relay a central error verbatim (status + code + currentVersion) so the
// webview sees the same shape the central text endpoint would produce.
function respondCentralFileError(res: ServerResponse, err: unknown): boolean {
  if (err instanceof CentralHttpError) {
    const body: Record<string, unknown> = { error: err.message };
    if (err.code) body.code = err.code;
    if (err.currentVersion) body.currentVersion = err.currentVersion;
    respondJson(res, err.status, body);
    return true;
  }
  return false;
}

// Editable = text-ish; mirrors isEditableMime in file-content.ts (kept in
// sync deliberately). Guards the central byte fallback, which is binary-safe
// by design and would otherwise hand the text editor binary content.
function agentIsEditableMime(mime: string | null): boolean {
  if (mime === null) return true;
  if (mime.startsWith("text/")) return true;
  if (mime === "application/json") return true;
  return false;
}

const agentPutFileSchema = z.object({
  content: z.string(),
  baseVersion: z.string().optional(),
  force: z.boolean().optional(),
});

export type AgentRouteFn = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  identity: RequestIdentity,
) => Promise<boolean>;

export function createAgentRouter(client: CentralClient): AgentRouteFn {
  return async (req, res, url, identity) => {
    const method = req.method ?? "GET";
    const { pathname } = url;

    if (pathname === "/health") {
      handleHealth(res);
      return true;
    }

    if (pathname === "/scope" && method === "GET") {
      await handleWriteScope(req, res, identity, url);
      return true;
    }

    if (pathname === "/sync/pending" && method === "GET") {
      try {
        respondJson(res, 200, await computeSyncPendingCentral(client, identity.userId));
      } catch (err) {
        respondError(res, "GET /sync/pending", err);
      }
      return true;
    }

    if (pathname === "/sandbox-profile" && method === "GET") {
      const cwd = url.searchParams.get("cwd");
      if (!cwd) {
        respondJson(res, 400, { error: "cwd parameter required" });
        return true;
      }
      try {
        const r = await resolveSandboxScopeForCwd(NO_DB, identity.userId, cwd);
        if (!r) {
          respondJson(res, 409, {
            error: `cwd is not inside any registered mirror: ${cwd}`,
            code: "NO_MIRROR",
          });
          return true;
        }
        // Central mode has no local graph, so resolveSandboxScope leaves
        // readMirrors empty; fill it from central's depth-1 neighbours.
        r.scope.readMirrors = await neighbourReadMirrorsCentral(client, identity.userId, r.nodeId, r.scope.homeMirror);
        respondJson(res, 200, {
          node_id: r.nodeId,
          profile: buildSeatbeltProfile(r.scope),
          portuni_root: r.scope.portuniRoot,
          home_mirror: r.scope.homeMirror,
        });
      } catch (err) {
        respondError(res, "GET /sandbox-profile", err);
      }
      return true;
    }

    const syncStatusMatch = pathname.match(/^\/nodes\/([^/]+)\/sync-status$/);
    if (syncStatusMatch && method === "GET") {
      const nodeId = decodeURIComponent(syncStatusMatch[1]);
      try {
        const result = await statusScanCentral(client, {
          userId: identity.userId,
          nodeId,
          includeDiscovery: true,
          fast: true,
        });
        const tagged: SyncStatusResponse["files"] = [];
        const push = (
          arr: typeof result.clean,
          cls: SyncStatusResponse["files"][number]["sync_class"],
        ) => {
          for (const e of arr) {
            tagged.push({
              file_id: e.file_id,
              sync_class: cls,
              local_hash: e.local_hash,
              remote_hash: e.remote_hash,
              last_synced_hash: e.last_synced_hash,
              local_path: e.local_path,
              remote_name: e.remote_name,
              remote_path: e.remote_path,
            });
          }
        };
        push(result.clean, "clean");
        push(result.push_candidates, "push");
        push(result.pull_candidates, "pull");
        push(result.conflicts, "conflict");
        push(result.remote_missing, "remote_missing");
        push(result.remote_error, "remote_error");
        push(result.native, "native");
        push(result.deleted_local, "deleted_local");
        const untracked: UntrackedFile[] = result.new_local.map((u) => ({
          relative_path: u.subpath
            ? `${u.section}/${u.subpath}/${u.filename}`
            : `${u.section}/${u.filename}`,
          section: u.section,
          subpath: u.subpath,
          filename: u.filename,
          local_path: u.local_path,
          mime_type: mimeFor(u.filename),
        }));
        const payload: SyncStatusResponse = { files: tagged, untracked };
        respondJson(res, 200, payload);
      } catch (err) {
        if (respondCentral404(res, err)) return true;
        respondError(res, `GET /nodes/${nodeId}/sync-status`, err);
      }
      return true;
    }

    const syncRunMatch = pathname.match(/^\/nodes\/([^/]+)\/sync$/);
    if (syncRunMatch && method === "POST") {
      const nodeId = decodeURIComponent(syncRunMatch[1]);
      try {
        respondJson(res, 200, await syncRunCentral(client, { userId: identity.userId, nodeId }));
      } catch (err) {
        if (respondCentral404(res, err)) return true;
        respondError(res, `POST /nodes/${nodeId}/sync`, err);
      }
      return true;
    }

    // Conflict / deleted_local resolution -- the agent-mode counterpart of
    // handleResolveFile in api/nodes.ts. findEntryByFileId fans out across
    // this user's mirrored nodes (there is no local graph db to look the
    // file up by id directly) and derives the real local path; keep_local
    // force-pushes it past any stale-hash precondition, take_remote/restore
    // force/plain-pull the remote bytes down.
    const resolveMatch = pathname.match(/^\/nodes\/([^/]+)\/files\/([^/]+)\/resolve$/);
    if (resolveMatch && method === "POST") {
      const nodeId = decodeURIComponent(resolveMatch[1]);
      const fileId = decodeURIComponent(resolveMatch[2]);
      try {
        const body = (await parseBody(req)) as { action?: string } | undefined;
        const action = body?.action;
        if (action !== "keep_local" && action !== "take_remote" && action !== "restore") {
          respondJson(res, 400, { error: "action must be keep_local | take_remote | restore" });
          return true;
        }
        const found = await findEntryByFileId(client, identity.userId, fileId);
        if (!found || found.nodeId !== nodeId || !found.entry.local_path) {
          respondJson(res, 404, { error: "file not found on this device" });
          return true;
        }
        if (action === "keep_local") {
          await storeFileCentral(client, {
            userId: identity.userId,
            nodeId,
            localPath: found.entry.local_path,
            force: true,
          });
        } else {
          await pullFileCentral(client, {
            userId: identity.userId,
            nodeId,
            entry: found.entry,
            force: action === "take_remote",
          });
        }
        respondJson(res, 200, { file_id: fileId, action, status: "ok" });
      } catch (err) {
        if (respondCentral404(res, err)) return true;
        respondError(res, `POST /nodes/${nodeId}/files/${fileId}/resolve`, err);
      }
      return true;
    }

    const fileContentMatch = pathname.match(/^\/nodes\/([^/]+)\/file$/);
    if (fileContentMatch && (method === "GET" || method === "PUT")) {
      const nodeId = decodeURIComponent(fileContentMatch[1]);
      const relPath = url.searchParams.get("path");
      if (!relPath) {
        respondJson(res, 400, { error: "path query param required" });
        return true;
      }
      const mirror = await getLocalMirror(identity.userId, nodeId);

      if (method === "GET") {
        if (mirror) {
          try {
            const r = await readFileContent(NO_DB, {
              userId: identity.userId,
              nodeId,
              relPath,
            });
            const payload: FileContentResponse = {
              content: r.content,
              version: r.version,
              filename: r.filename,
              mime_type: r.mime_type,
              local_path: r.local_path,
            };
            respondJson(res, 200, payload);
            return true;
          } catch (err) {
            // NOT_FOUND on disk = pull-pending file; try central below.
            if (!(err instanceof FileContentError && err.code === "NOT_FOUND")) {
              if (respondFileContentError(res, err)) return true;
              respondError(res, `GET /nodes/${nodeId}/file`, err);
              return true;
            }
          }
        }
        try {
          const filename = relPath.split("/").pop() ?? relPath;
          const mime = mimeFor(filename);
          const raw = await client.getFileRaw(nodeId, relPath);
          if (!agentIsEditableMime(mime) || raw.bytes.includes(0)) {
            respondJson(res, 415, {
              error: `file is not editable text: ${relPath}`,
              code: "NOT_EDITABLE",
            });
            return true;
          }
          const payload: FileContentResponse = {
            content: raw.bytes.toString("utf8"),
            version: raw.version,
            filename,
            mime_type: mime,
            local_path: null,
          };
          respondJson(res, 200, payload);
        } catch (err) {
          if (respondCentralFileError(res, err)) return true;
          respondError(res, `GET /nodes/${nodeId}/file`, err);
        }
        return true;
      }

      // PUT
      const body = await parseJsonBody(req, res, agentPutFileSchema);
      if (!body) return true;
      try {
        if (mirror) {
          const r = await writeFileContent(NO_DB, {
            userId: identity.userId,
            nodeId,
            relPath,
            content: body.content,
            baseVersion: body.baseVersion,
            force: body.force,
          });
          respondJson(res, 200, { version: r.version });
          return true;
        }
        const r = await client.putFileRaw(nodeId, relPath, Buffer.from(body.content, "utf8"), {
          baseVersion: body.baseVersion,
          force: body.force,
        });
        respondJson(res, 200, { version: r.version });
      } catch (err) {
        if (respondFileContentError(res, err)) return true;
        if (respondCentralFileError(res, err)) return true;
        respondError(res, `PUT /nodes/${nodeId}/file`, err);
      }
      return true;
    }

    // Read-only device mirror lookup. Central serves node-detail with
    // local_mirror:null (no device state), so the web overlays this. Rust's
    // is_local_only_path already routes /nodes/:id/mirror here for any method.
    const mirrorReadMatch = pathname.match(/^\/nodes\/([^/]+)\/mirror$/);
    if (mirrorReadMatch && method === "GET") {
      const nodeId = decodeURIComponent(mirrorReadMatch[1]);
      const m = await getLocalMirror(identity.userId, nodeId);
      const payload: NodeMirrorResponse = {
        node_id: nodeId,
        local_mirror: m
          ? { local_path: m.local_path, registered_at: m.registered_at }
          : null,
      };
      respondJson(res, 200, payload);
      return true;
    }

    const mirrorMatch = pathname.match(/^\/nodes\/([^/]+)\/mirror$/);
    if (mirrorMatch && method === "POST") {
      const nodeId = decodeURIComponent(mirrorMatch[1]);
      try {
        const result = await createMirrorForNodeCentral(client, identity.userId, { nodeId });
        respondJson(res, result.created ? 201 : 200, {
          node_id: result.node_id,
          local_path: result.local_path,
          created: result.created,
          // Folder URLs come from the central server (/nodes/:id/folder-url
          // stays a central route); the agent doesn't resolve them.
          remote_url: null,
          subdirs: result.subdirs,
          remote_scaffold: result.remote_scaffold,
          scope_config: result.scope_config,
        });
      } catch (err) {
        if (err instanceof MirrorCreateError) {
          const status =
            err.code === "NODE_NOT_FOUND" ? 404 : err.code === "PATH_TRAVERSAL" ? 400 : 500;
          respondJson(res, status, { error: err.message, code: err.code });
          return true;
        }
        respondError(res, `POST /nodes/${nodeId}/mirror`, err);
      }
      return true;
    }

    const sandboxMatch = pathname.match(/^\/nodes\/([^/]+)\/sandbox-profile$/);
    if (sandboxMatch && method === "GET") {
      const nodeId = decodeURIComponent(sandboxMatch[1]);
      try {
        const scope = await resolveSandboxScopeForNode(NO_DB, identity.userId, nodeId);
        if (!scope) {
          respondJson(res, 409, {
            error: `node ${nodeId} has no local mirror on this device`,
            code: "NO_MIRROR",
          });
          return true;
        }
        scope.readMirrors = await neighbourReadMirrorsCentral(client, identity.userId, nodeId, scope.homeMirror);
        respondJson(res, 200, {
          profile: buildSeatbeltProfile(scope),
          portuni_root: scope.portuniRoot,
          home_mirror: scope.homeMirror,
        });
      } catch (err) {
        respondError(res, `GET /nodes/${nodeId}/sandbox-profile`, err);
      }
      return true;
    }

    // Anything else is a graph-plane route that belongs on the central
    // server; landing here means a proxy misroute. Be loud about it.
    respondJson(res, 501, {
      error: "agent_mode",
      detail: "route not served by the local sync agent; use the central server",
    });
    return true;
  };
}
