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
import { mkdir, rename as fsRename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Client } from "@libsql/client";
import { z } from "zod";
import type { RequestIdentity } from "../auth/request-identity.js";
import { parseBody, parseJsonBody, respondError, respondJson } from "../http/middleware.js";
import { handleHealth } from "./health.js";
import { handleWriteScope } from "./write-scope.js";
import { handleExchangeHandoff, handleMintHandoff } from "./auth.js";
import type { CentralClient } from "../domain/sync/central/client.js";
import { CentralHttpError } from "../domain/sync/central/client.js";
import {
  readFileContent,
  writeFileContent,
  FileContentError,
  type FileContentErrorCode,
} from "../domain/sync/file-content.js";
import {
  extractZipEntry,
  isShowtimePath,
  readShowtimePreview,
  SHOWTIME_PREVIEW_ENTRY,
} from "../domain/sync/showtime-preview.js";
import {
  computeSyncPendingCentral,
  createMirrorForNodeCentral,
  statusScanCentral,
  storeFileCentral,
  pullFileCentral,
  syncRunCentral,
  registerLocalFileCentral,
  loadNodeContext,
} from "../domain/sync/central/engine-central.js";
import { findEntryByFileId } from "../mcp/agent-tools.js";
import { guardAgentRestWrite } from "./write-gate.js";
import { startSyncJob, getSyncJob, getCurrentSyncJob } from "../domain/sync/sync-jobs.js";
import { mimeFor, localHashFor, PullDirtyLocalError } from "../domain/sync/engine.js";
import { safeMirrorJoin, deriveLocalPath, type Section } from "../domain/sync/remote-path.js";
import { getMirrorPath } from "../domain/sync/mirror-registry.js";
import { getLocalMirror } from "../domain/sync/local-db.js";
import { removeLocalCopyAndState } from "../domain/sync/local-cleanup.js";
import { trackPendingPush, clearPendingPushIfCurrent, awaitPendingPush } from "../domain/sync/pending-pushes.js";
import { getWatcherErrors } from "../domain/sync/watcher-error-buffer.js";
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
  NO_PREVIEW: 422,
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

// Same shape as api/files.ts's renameSchema.
const agentRenameFileSchema = z.object({ new_filename: z.string().min(1) });

// Same shape as api/files.ts's moveSchema.
const agentMoveFileSchema = z.object({
  new_section: z.enum(["wip", "outputs", "resources"]).optional(),
  new_subpath: z.string().nullable().optional(),
  new_filename: z.string().min(1).optional(),
  new_node_id: z.string().optional(),
  confirmed: z.boolean().optional(),
});

// Same shape as api/files.ts's createSchema -- kept in sync deliberately.
const agentCreateFileSchema = z.object({
  filename: z.string().min(1),
  section: z.enum(["wip", "outputs", "resources"]).optional(),
  subpath: z.string().nullish(),
  content: z.string().optional(),
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

    // Showtime handoff in agent mode: the local sidecar mints against the
    // per-launch token (the same one Portuni's terminals get) and answers
    // the exchange with its own MCP front door; node access is central's
    // verdict (404 -> not visible), node name comes from sync-info.
    if (pathname === "/auth/handoff/exchange" && method === "POST") {
      await handleExchangeHandoff(req, res, async (nodeId) => (await client.syncInfo(nodeId)).node.name);
      return true;
    }
    if (pathname === "/auth/handoff" && method === "POST") {
      await handleMintHandoff(req, res, identity, (nodeId) => client.nodeExists(nodeId));
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

    // #202: same in-process buffer mirror-watcher.ts writes to -- this
    // front door and the local sidecar's own watcher run in the same
    // process, so no cross-process wiring is needed. No group-visibility
    // filter here: agent mode is always a single device's own user.
    if (pathname === "/sync/health" && method === "GET") {
      respondJson(res, 200, { errors: getWatcherErrors() });
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
          projection_root: r.scope.projectionRoot ?? null,
          session_id: r.scope.sessionId ?? null,
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
        const watcherErrors = getWatcherErrors(nodeId);
        const payload: SyncStatusResponse = {
          files: tagged,
          untracked,
          ...(watcherErrors.length > 0 ? { watcher_errors: watcherErrors } : {}),
        };
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
      if (!guardAgentRestWrite(req, res, identity, nodeId)) return true;
      try {
        respondJson(res, 200, await syncRunCentral(client, { userId: identity.userId, nodeId }));
      } catch (err) {
        if (respondCentral404(res, err)) return true;
        respondError(res, `POST /nodes/${nodeId}/sync`, err);
      }
      return true;
    }

    // Background multi-node sync job (#273): central-mode counterpart of
    // handleStartSyncJob/handleGetSyncJob (api/nodes.ts) -- "Synchronizovat
    // vše" starts one of these regardless of data mode, so this front door
    // needs the same three routes. guardAgentRestWrite is not actually
    // per-node (it only checks the webview-proxy posture), so one call
    // gates the whole batch instead of filtering node ids individually the
    // way local mode's filterRestWritableNodeIds does.
    if (pathname === "/sync/jobs" && method === "POST") {
      if (!guardAgentRestWrite(req, res, identity, "sync-jobs")) return true;
      const body = await parseJsonBody(req, res, z.object({ node_ids: z.array(z.string()).optional() }));
      if (!body) return true;
      try {
        let nodeIds = body.node_ids;
        if (!nodeIds) {
          const pending = await computeSyncPendingCentral(client, identity.userId);
          nodeIds = pending.nodes.filter((n) => n.total > 0).map((n) => n.node_id);
        }
        const job = startSyncJob({
          userId: identity.userId,
          nodeIds,
          runNode: (nodeId) => syncRunCentral(client, { userId: identity.userId, nodeId }),
        });
        respondJson(res, 202, job);
      } catch (err) {
        respondError(res, "POST /sync/jobs", err);
      }
      return true;
    }
    if (pathname === "/sync/jobs/current" && method === "GET") {
      respondJson(res, 200, { job: getCurrentSyncJob(identity.userId) });
      return true;
    }
    const syncJobMatch = pathname.match(/^\/sync\/jobs\/([^/]+)$/);
    if (syncJobMatch && method === "GET") {
      const job = getSyncJob(identity.userId, decodeURIComponent(syncJobMatch[1]));
      if (!job) {
        respondJson(res, 404, { error: "job not found" });
        return true;
      }
      respondJson(res, 200, job);
      return true;
    }

    // Create (#266): a device with a mirror owns the bytes, same as local
    // mode's createFile -- write into the mirror, register the record
    // WITHOUT waiting on the Drive upload, and push in the background.
    // Central's own create (adapter-direct) does adapter.put before
    // answering, taking ~2s and leaving the device with no baseline at all
    // once the editor's own local-only save lands -- reconcile then sees a
    // local hash with no last_synced_hash and a remote hash of md5(""),
    // which is a genuine (if permanent) conflict from its point of view.
    // Skipping straight to the mirror avoids ever creating that state:
    // the record starts in the ordinary "push" classification (registered,
    // current_remote_hash null, local hash cached) and only becomes clean
    // once the background push lands, exactly like any other new local file.
    const createFileMatch = pathname.match(/^\/nodes\/([^/]+)\/files$/);
    if (createFileMatch && method === "POST") {
      const nodeId = decodeURIComponent(createFileMatch[1]);
      if (!guardAgentRestWrite(req, res, identity, nodeId)) return true;
      const body = await parseJsonBody(req, res, agentCreateFileSchema);
      if (!body) return true;
      const filename = body.filename;
      if (
        filename.includes("/") ||
        filename.includes("\\") ||
        filename.includes("\0") ||
        filename === "." ||
        filename === ".."
      ) {
        respondJson(res, 400, { error: `invalid filename: ${filename}`, code: "INVALID_PATH" });
        return true;
      }
      const section: Section = body.section ?? "wip";
      try {
        const mirrorRoot = await getMirrorPath(identity.userId, nodeId);
        if (!mirrorRoot) {
          // No mirror on this device: central creates it directly
          // (mirror-less, adapter-direct) exactly as a non-agent-mode
          // create would.
          const f = await client.createFile(nodeId, {
            filename,
            section,
            subpath: body.subpath ?? null,
            content: body.content,
          });
          respondJson(res, 201, f);
          return true;
        }
        const subSegs = body.subpath ? body.subpath.split("/").filter((s) => s.length > 0) : [];
        let abs: string;
        try {
          abs = safeMirrorJoin(mirrorRoot, section, ...subSegs, filename);
        } catch {
          respondJson(res, 400, { error: "invalid path", code: "INVALID_PATH" });
          return true;
        }
        try {
          await stat(abs);
          respondJson(res, 409, { error: `file already exists: ${filename}`, code: "EXISTS" });
          return true;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, Buffer.from(body.content ?? "", "utf8"));

        // Record-only register -- no Drive call, so this answers fast.
        const reg = await registerLocalFileCentral(client, {
          userId: identity.userId,
          nodeId,
          localPath: abs,
        });
        const relative_path = abs.startsWith(`${mirrorRoot}/`)
          ? abs.slice(mirrorRoot.length + 1)
          : [section, ...subSegs, filename].join("/");
        respondJson(res, 201, {
          id: reg.file_id,
          filename,
          status: section === "outputs" ? "output" : "wip",
          local_path: abs,
          relative_path,
          mime_type: mimeFor(filename),
        });
        // Push to Drive in the background -- the response above must not
        // wait on it. storeFileCentral re-registers (idempotent) and PUTs
        // the bytes with an ifAbsent precondition (no last_synced_hash yet
        // on a brand-new record), then writes the last_synced_hash baseline
        // that flips the row from "push" to "clean".
        // Tracked per path (pending-pushes.ts, shared with agent-transport.ts's
        // MCP dispatch, #277) so a later delete/resolve/move on the same
        // file -- through EITHER entry point -- waits for it
        // (awaitPendingPush) instead of racing the upload: an adapter.put
        // landing after the record was deleted would recreate the remote
        // object as an orphan and undo the confirmed delete.
        const push = storeFileCentral(client, { userId: identity.userId, nodeId, localPath: abs })
          .then(() => undefined)
          .catch((e) => {
            console.error(`[portuni:agent] background push after create failed for ${abs}:`, e);
          })
          .finally(() => {
            clearPendingPushIfCurrent(abs, push);
          });
        trackPendingPush(abs, push);
      } catch (err) {
        if (respondCentral404(res, err)) return true;
        respondError(res, `POST /nodes/${nodeId}/files`, err);
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
      if (!guardAgentRestWrite(req, res, identity, nodeId)) return true;
      const fileId = decodeURIComponent(resolveMatch[2]);
      try {
        const body = (await parseBody(req)) as { action?: string } | undefined;
        const action = body?.action;
        if (action !== "keep_local" && action !== "take_remote" && action !== "restore") {
          respondJson(res, 400, { error: "action must be keep_local | take_remote | restore" });
          return true;
        }
        // findEntryByFileId fans out across every node this device has
        // mirrored, not just the URL's nodeId -- IDOR guard: require the
        // file to actually resolve to THIS node before touching it (a
        // caller cannot resolve node B's file by addressing node A's URL),
        // checked before any adapter or filesystem work. Same not-found
        // shape either way.
        const found = await findEntryByFileId(client, identity.userId, fileId);
        if (!found || found.nodeId !== nodeId || !found.entry.local_path) {
          respondJson(res, 404, { error: "file not found on this device" });
          return true;
        }
        await awaitPendingPush(found.entry.local_path);
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
        if (err instanceof PullDirtyLocalError) {
          respondJson(res, 409, { error: err.message });
          return true;
        }
        if (respondCentral404(res, err)) return true;
        respondError(res, `POST /nodes/${nodeId}/files/${fileId}/resolve`, err);
      }
      return true;
    }

    // Rename: central owns the record + remote step (CentralClient.renameFile,
    // the same POST a non-agent-mode rename hits), but only THIS device can
    // rename the mirror copy -- without that step the local file kept its
    // old name, so the next scan reported the renamed record as missing
    // locally AND the old name as a new untracked file. Same shape as the
    // MCP portuni_move_file after-step (applyLocalAfterProxiedMutation).
    // Also waits for a create's in-flight background upload on this path,
    // so the upload cannot land at the old remote path after the rename.
    const renameFileMatch = pathname.match(/^\/nodes\/([^/]+)\/files\/([^/]+)\/rename$/);
    if (renameFileMatch && method === "POST") {
      const nodeId = decodeURIComponent(renameFileMatch[1]);
      const fileId = decodeURIComponent(renameFileMatch[2]);
      if (!guardAgentRestWrite(req, res, identity, nodeId)) return true;
      const body = await parseJsonBody(req, res, agentRenameFileSchema);
      if (!body) return true;
      const fn = body.new_filename;
      if (fn.includes("/") || fn.includes("\\") || fn.includes("\0") || fn === "." || fn === "..") {
        respondJson(res, 400, { error: `invalid filename: ${fn}`, code: "INVALID_PATH" });
        return true;
      }
      try {
        // Same IDOR guard as delete/resolve: a file this device mirrors must
        // belong to THIS node; one it does not mirror is simply not found
        // here and forwards to central with no local step.
        const found = await findEntryByFileId(client, identity.userId, fileId);
        if (found && found.nodeId !== nodeId) {
          respondJson(res, 404, { error: "file not found on this device" });
          return true;
        }
        const oldLocal = found?.entry.local_path ?? null;
        if (oldLocal) await awaitPendingPush(oldLocal);
        const r = await client.renameFile(nodeId, fileId, fn);
        if (oldLocal && (r as { status?: unknown }).status === "ok") {
          const newLocal = join(dirname(oldLocal), fn);
          if (newLocal !== oldLocal) {
            try {
              await fsRename(oldLocal, newLocal);
              await localHashFor(newLocal, fileId, null).catch(() => null);
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code === "ENOENT") {
                // No local copy (pull-pending) -- nothing to rename here.
              } else {
                // #279 finding 13: central already committed the record +
                // remote rename -- a local failure past this point (a
                // permission error, a destination collision) must report
                // repair_needed like the move handler above, not a raw 500
                // that implies nothing happened.
                respondJson(res, 200, {
                  ...(r as Record<string, unknown>),
                  status: "repair_needed",
                  detail: { local_error: (e as Error).message },
                  repair_hint:
                    "Remote already renamed; the local copy could not be renamed. Rename it manually, or delete the local copy and pull.",
                });
                return true;
              }
            }
          }
        }
        respondJson(res, 200, r);
      } catch (err) {
        if (respondCentral404(res, err)) return true;
        respondError(res, `POST /nodes/${nodeId}/files/${fileId}/rename`, err);
      }
      return true;
    }

    // Move (#278): same shape as rename above -- central owns the record +
    // remote step (CentralClient.moveFileRecord, the same POST a
    // non-agent-mode move hits, whose own local disk step no-ops since the
    // central server has no mirror), but only THIS device can relocate the
    // mirror copy. Without this handler the desktop sent the move straight
    // to central (is_local_only_path never matched it), central moved the
    // record + remote object, and the device's local file just sat at the
    // old path forever -- the next slow sync then saw the new path as
    // deleted_local and the old path as untracked, adopting/pushing the
    // stale copy as a second file.
    const moveFileMatch = pathname.match(/^\/nodes\/([^/]+)\/files\/([^/]+)\/move$/);
    if (moveFileMatch && method === "POST") {
      const nodeId = decodeURIComponent(moveFileMatch[1]);
      const fileId = decodeURIComponent(moveFileMatch[2]);
      if (!guardAgentRestWrite(req, res, identity, nodeId)) return true;
      const body = await parseJsonBody(req, res, agentMoveFileSchema);
      if (!body) return true;
      if (body.new_node_id && body.new_node_id !== nodeId) {
        if (!guardAgentRestWrite(req, res, identity, body.new_node_id)) return true;
      }
      try {
        // Same IDOR guard as rename/resolve/delete.
        const found = await findEntryByFileId(client, identity.userId, fileId);
        if (found && found.nodeId !== nodeId) {
          respondJson(res, 404, { error: "file not found on this device" });
          return true;
        }
        const oldLocal = found?.entry.local_path ?? null;
        if (oldLocal) await awaitPendingPush(oldLocal);
        const r = (await client.moveFileRecord(nodeId, fileId, {
          new_section: body.new_section,
          new_subpath: body.new_subpath ?? null,
          new_filename: body.new_filename,
          new_node_id: body.new_node_id,
          confirmed: body.confirmed ?? false,
        })) as {
          status?: string;
          requires_confirmation?: boolean;
          new_remote_path?: string;
          [key: string]: unknown;
        };
        // Unconfirmed -- central returned a preview, nothing committed yet.
        // No local step: there is nothing on disk to move.
        if (r.requires_confirmation || !oldLocal || r.status !== "ok" || !r.new_remote_path) {
          respondJson(res, 200, r);
          return true;
        }
        // Confirmed and committed on central -- relocate this device's own
        // mirror copy. The target node may differ from the URL's node
        // (cross-node move), so its mirror root/nodeRoot must be resolved
        // independently rather than reusing the source node's context.
        const targetNodeId = body.new_node_id ?? nodeId;
        const targetCtx = await loadNodeContext(client, identity.userId, targetNodeId);
        let newLocal: string | null = null;
        if (targetCtx.mirrorRoot) {
          try {
            newLocal = deriveLocalPath({
              mirrorRoot: targetCtx.mirrorRoot,
              nodeRoot: targetCtx.nodeRoot,
              remotePath: r.new_remote_path,
            });
          } catch {
            newLocal = null;
          }
        }
        if (!newLocal) {
          // The target node isn't mirrored on this device (or the derived
          // path was rejected) -- there is nowhere to put the file. The
          // record and remote object already moved; only the local half is
          // incomplete, so report repair_needed rather than silently
          // leaving a stale copy at the old path with no signal.
          respondJson(res, 200, {
            ...r,
            status: "repair_needed",
            detail: { ...(r.detail as object | undefined), local_reason: "target_not_mirrored" },
            repair_hint:
              "Remote already moved; this device has no mirror for the target node, so the local copy could not be relocated. Remove it manually or mirror the target node and pull.",
          });
          return true;
        }
        if (newLocal === oldLocal) {
          respondJson(res, 200, r);
          return true;
        }
        try {
          await mkdir(dirname(newLocal), { recursive: true });
          await fsRename(oldLocal, newLocal);
          await localHashFor(newLocal, fileId, null).catch(() => null);
          respondJson(res, 200, r);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") {
            // No local copy to move (pull-pending) -- nothing to do here.
            respondJson(res, 200, r);
          } else {
            respondJson(res, 200, {
              ...r,
              status: "repair_needed",
              detail: { ...(r.detail as object | undefined), local_error: (e as Error).message },
              repair_hint:
                "Remote already moved; the local copy could not be relocated. Move or copy it manually, or run portuni_pull to re-download.",
            });
          }
        }
      } catch (err) {
        if (respondCentral404(res, err)) return true;
        respondError(res, `POST /nodes/${nodeId}/files/${fileId}/move`, err);
      }
      return true;
    }

    // Delete (#254): the record + remote step is adapter-direct on the
    // central server (deleteFileRecord), same as a non-agent-mode delete --
    // but the server has no device mirror to clean up, so without this
    // handler the local copy stayed on disk and the mirror-watcher's
    // backfill sweep re-registered it right after the DB row was removed.
    // Confirm-first is enforced here rather than round-tripped through a
    // preview: the only caller (the web UI's deleteFile()) always confirms
    // client-side first and sends confirmed=true directly.
    const deleteFileMatch = pathname.match(/^\/nodes\/([^/]+)\/files\/([^/]+)$/);
    if (deleteFileMatch && method === "DELETE") {
      const nodeId = decodeURIComponent(deleteFileMatch[1]);
      const fileId = decodeURIComponent(deleteFileMatch[2]);
      if (!guardAgentRestWrite(req, res, identity, nodeId)) return true;
      if (url.searchParams.get("confirmed") !== "true") {
        respondJson(res, 400, { error: "confirmed=true required" });
        return true;
      }
      try {
        // Same IDOR guard as /resolve: a file this device DOES mirror must
        // actually belong to THIS node before anything is touched. A file on
        // a node this device has no mirror for is not found here at all --
        // that is not an error: the route is local-only for every node
        // (is_local_only_path), so it forwards to central's own delete
        // exactly as a non-agent-mode delete would, with no local step.
        const found = await findEntryByFileId(client, identity.userId, fileId);
        if (found && found.nodeId !== nodeId) {
          respondJson(res, 404, { error: "file not found on this device" });
          return true;
        }
        // A create's background upload still in flight for this path must
        // finish first, or its adapter.put would land after the record is
        // gone and resurrect the remote object as an orphan.
        if (found?.entry.local_path) await awaitPendingPush(found.entry.local_path);
        // Record + remote object first (the source of truth); only clean up
        // the local copy once that has actually succeeded. Central answers
        // 200 with { status: "repair_needed" } when the remote delete
        // failed and it deliberately KEPT the record -- same contract the
        // MCP path checks in applyLocalAfterProxiedMutation -- so the local
        // copy and file_state must stay put then too, or an unsynced local
        // edit would be lost for a delete that never happened.
        const r = await client.deleteFileRecord(nodeId, fileId);
        if (found && (r as { status?: unknown }).status === "ok") {
          // file_state is only cleared once the local copy is actually
          // confirmed gone (#275) -- otherwise a failed rm here left an
          // orphan with no identity proof, which the next sync's discovery
          // scan read as new content and adopted/pushed back, resurrecting
          // a confirmed deletion. central.deleteFileRecord already wrote
          // the tombstone, so a leftover copy is still cleaned up by that
          // sync's tombstone cleanup even when this rm fails here.
          await removeLocalCopyAndState(found.entry.local_path, fileId);
        }
        respondJson(res, 200, r);
      } catch (err) {
        if (respondCentral404(res, err)) return true;
        respondError(res, `DELETE /nodes/${nodeId}/files/${fileId}`, err);
      }
      return true;
    }

    const fileContentMatch = pathname.match(/^\/nodes\/([^/]+)\/file$/);
    if (fileContentMatch && (method === "GET" || method === "PUT")) {
      const nodeId = decodeURIComponent(fileContentMatch[1]);
      if (method === "PUT" && !guardAgentRestWrite(req, res, identity, nodeId)) return true;
      const relPath = url.searchParams.get("path");
      if (!relPath) {
        respondJson(res, 400, { error: "path query param required" });
        return true;
      }
      const mirror = await getLocalMirror(identity.userId, nodeId);

      if (method === "GET") {
        if (mirror) {
          try {
            // A .showtime deck reads as the preview.html it carries; the
            // reader never touches the DB when a mirror holds the file.
            const args = { userId: identity.userId, nodeId, relPath };
            const r = isShowtimePath(relPath)
              ? await readShowtimePreview(NO_DB, args)
              : await readFileContent(NO_DB, args);
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
          if (isShowtimePath(relPath)) {
            let entry: Buffer | null = null;
            try {
              entry = extractZipEntry(raw.bytes, SHOWTIME_PREVIEW_ENTRY);
            } catch (e) {
              respondJson(res, 422, {
                error: `not a readable .showtime bundle (${(e as Error).message}): ${relPath}`,
                code: "NO_PREVIEW",
              });
              return true;
            }
            if (!entry) {
              respondJson(res, 422, {
                error: `bundle carries no ${SHOWTIME_PREVIEW_ENTRY}; save it with a newer Showtime: ${relPath}`,
                code: "NO_PREVIEW",
              });
              return true;
            }
            const payload: FileContentResponse = {
              content: entry.toString("utf8"),
              version: raw.version,
              filename,
              mime_type: "text/html",
              local_path: null,
            };
            respondJson(res, 200, payload);
            return true;
          }
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
      if (isShowtimePath(relPath)) {
        // The editor holds the bundled preview, never the bundle's text.
        respondJson(res, 415, {
          error: `a .showtime bundle is read-only here; edit it in Showtime: ${relPath}`,
          code: "NOT_EDITABLE",
        });
        return true;
      }
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
      if (!guardAgentRestWrite(req, res, identity, nodeId)) return true;
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
          projection_root: scope.projectionRoot ?? null,
          session_id: scope.sessionId ?? null,
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
