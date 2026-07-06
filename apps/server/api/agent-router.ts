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
import type { RequestIdentity } from "../auth/request-identity.js";
import { respondError, respondJson } from "../http/middleware.js";
import { handleHealth } from "./health.js";
import { handleWriteScope } from "./write-scope.js";
import type { CentralClient } from "../domain/sync/central/client.js";
import { CentralHttpError } from "../domain/sync/central/client.js";
import {
  computeSyncPendingCentral,
  createMirrorForNodeCentral,
  statusScanCentral,
  syncRunCentral,
} from "../domain/sync/central/engine-central.js";
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
        push(result.orphan, "orphan");
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
