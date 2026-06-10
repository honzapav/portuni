// Domain entry point for "make a local mirror for this node". Lifted out
// of the MCP tool so the REST endpoint (POST /nodes/:id/mirror) and the
// MCP tool (portuni_mirror) share the exact same orchestration:
//   1. resolve node + path
//   2. mkdir the standard subfolders (wip/outputs/resources)
//   3. register in the per-device sync.db
//   4. best-effort remote scaffold (skipped on failure, never fatal)
//   5. regenerate every sibling mirror's scope config
//   6. audit
//
// Idempotent: calling with an already-mirrored node returns the existing
// path with created=false and skips mkdir / scaffold / regen. The REST
// route maps created=true to 201 and created=false to 200 so the UI can
// distinguish "we just made the directory" from "it was already there".

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Client } from "@libsql/client";
import { logAudit } from "../../infra/audit.js";
import { SOLO_USER } from "../../infra/schema.js";
import {
  getMirrorPath,
  registerMirror,
  listUserMirrors,
} from "./mirror-registry.js";
import { resolveNodeInfo } from "./engine.js";
import { resolveRemote } from "./routing.js";
import { getAdapter } from "./adapter-cache.js";
import { buildNodeRoot } from "./remote-path.js";
import { ensureUnderRoot, PathTraversalError } from "../../shared/safe-path.js";
import {
  resolvePortuniRoot,
  resolveGuardScriptPath,
} from "../write-scope.js";
import { materializeScopeConfig } from "../scope-materialize.js";

const ORG_PLURALS = ["projects", "processes", "areas", "principles"] as const;
const NODE_SECTIONS = ["wip", "outputs", "resources"] as const;
const TYPE_PLURAL: Record<string, string> = {
  project: "projects",
  process: "processes",
  area: "areas",
  principle: "principles",
};

export class MirrorCreateError extends Error {
  constructor(
    message: string,
    readonly code:
      | "NODE_NOT_FOUND"
      | "WORKSPACE_ROOT_UNSET"
      | "PATH_TRAVERSAL"
      | "PATH_IN_USE",
  ) {
    super(message);
    this.name = "MirrorCreateError";
  }
}

export type CreateMirrorResult = {
  node_id: string;
  local_path: string;
  created: boolean;
  subdirs: string[];
  remote_scaffold: { scaffolded: string[]; remote_name: string | null; error?: string };
  scope_config: {
    written: string[];
    errors: { path: string; message: string }[];
    portuni_root: string | null;
  };
};

async function scaffoldRemoteStructure(
  db: Client,
  nodeId: string,
): Promise<{ scaffolded: string[]; remote_name: string | null; error?: string }> {
  try {
    const info = await resolveNodeInfo(db, nodeId);
    const remoteName = await resolveRemote(db, info.nodeType, info.orgSyncKey);
    if (!remoteName) return { scaffolded: [], remote_name: null };
    const adapter = await getAdapter(db, remoteName);
    if (!adapter.ensureFolder) return { scaffolded: [], remote_name: remoteName };
    const nodeRoot = buildNodeRoot(info);
    const subpaths =
      info.nodeType === "organization" ? ORG_PLURALS : NODE_SECTIONS;
    const created: string[] = [];
    for (const sub of subpaths) {
      const target = `${nodeRoot}/${sub}`;
      await adapter.ensureFolder(target);
      created.push(target);
    }
    return { scaffolded: created, remote_name: remoteName };
  } catch (e) {
    return { scaffolded: [], remote_name: null, error: (e as Error).message };
  }
}

async function materializeAndRegen(
  newMirrorPath: string,
  newNodeId: string,
): Promise<{
  written: string[];
  errors: { path: string; message: string }[];
  portuni_root: string | null;
}> {
  const allMirrors = await listUserMirrors(SOLO_USER);
  const paths = allMirrors.map((m) => m.local_path);
  if (!paths.includes(newMirrorPath)) paths.push(newMirrorPath);

  const portuniRoot =
    resolvePortuniRoot({
      envValue: process.env.PORTUNI_ROOT ?? null,
      knownMirrors: paths,
    }) ?? null;

  if (!portuniRoot) {
    return { written: [], errors: [], portuni_root: null };
  }

  const guardScriptPath = resolveGuardScriptPath();
  const aggregated: { written: string[]; errors: { path: string; message: string }[] } = {
    written: [],
    errors: [],
  };

  for (const m of allMirrors) {
    const others = paths.filter((p) => p !== m.local_path);
    const r = await materializeScopeConfig({
      currentMirror: m.local_path,
      nodeId: m.node_id,
      otherMirrors: others,
      portuniRoot,
      guardScriptPath,
    });
    aggregated.written.push(...r.written);
    aggregated.errors.push(...r.errors);
  }
  if (!allMirrors.find((m) => m.node_id === newNodeId)) {
    const others = paths.filter((p) => p !== newMirrorPath);
    const r = await materializeScopeConfig({
      currentMirror: newMirrorPath,
      nodeId: newNodeId,
      otherMirrors: others,
      portuniRoot,
      guardScriptPath,
    });
    aggregated.written.push(...r.written);
    aggregated.errors.push(...r.errors);
  }

  return { ...aggregated, portuni_root: portuniRoot };
}

// Resolve {root}/{org-key}/{type-plural}/{node-key} (or {root}/{org-key}
// for organizations themselves), honouring an optional safe override path.
// Leafs come from sync_key, NOT slugify(name): sync_key is unique (collision
// names get a numeric suffix at create time), while two names can slug to
// the same leaf and would silently register one directory for two nodes --
// every status scan afterwards cross-attributes their files.
async function resolveMirrorPath(
  db: Client,
  nodeId: string,
  nodeSyncKey: string,
  nodeType: string,
  customPath: string | undefined,
  workspaceRoot: string,
): Promise<string> {
  if (customPath) {
    try {
      return ensureUnderRoot(workspaceRoot, customPath);
    } catch (e) {
      if (e instanceof PathTraversalError) {
        throw new MirrorCreateError(
          `custom_path must be inside PORTUNI_WORKSPACE_ROOT (${workspaceRoot})`,
          "PATH_TRAVERSAL",
        );
      }
      throw e;
    }
  }
  if (nodeType === "organization") {
    return join(workspaceRoot, nodeSyncKey);
  }
  const orgRow = await db.execute({
    sql: `SELECT n.sync_key FROM edges e JOIN nodes n ON n.id = e.target_id
          WHERE e.source_id = ? AND e.relation = 'belongs_to' AND n.type = 'organization'
          LIMIT 1`,
    args: [nodeId],
  });
  const typePlural = TYPE_PLURAL[nodeType] ?? nodeType;
  if (orgRow.rows.length > 0) {
    const orgKey = orgRow.rows[0].sync_key as string;
    return join(workspaceRoot, orgKey, typePlural, nodeSyncKey);
  }
  return join(workspaceRoot, typePlural, nodeSyncKey);
}

// Idempotent. If a mirror is already registered for (userId, nodeId), the
// returned `created` flag is false and the directory is not re-touched.
export async function createMirrorForNode(
  db: Client,
  userId: string,
  args: { nodeId: string; customPath?: string },
): Promise<CreateMirrorResult> {
  const nodeResult = await db.execute({
    sql: "SELECT id, name, type, sync_key FROM nodes WHERE id = ?",
    args: [args.nodeId],
  });
  if (nodeResult.rows.length === 0) {
    throw new MirrorCreateError(
      `node ${args.nodeId} not found`,
      "NODE_NOT_FOUND",
    );
  }
  const row = nodeResult.rows[0];
  const nodeType = row.type as string;
  const nodeSyncKey = row.sync_key as string;

  // Already mirrored on this device — short-circuit. We do not re-validate
  // the directory on disk; reconciling that is the registry's job and
  // costs an extra fs round-trip on every detail-pane render via
  // /nodes/:id, which would dominate the hot path.
  const existing = await getMirrorPath(userId, args.nodeId);
  if (existing && !args.customPath) {
    return {
      node_id: args.nodeId,
      local_path: existing,
      created: false,
      subdirs: ["outputs/", "wip/", "resources/"],
      remote_scaffold: { scaffolded: [], remote_name: null },
      scope_config: { written: [], errors: [], portuni_root: null },
    };
  }

  const root = process.env.PORTUNI_WORKSPACE_ROOT?.replace(/^~/, homedir());
  if (!root) {
    throw new MirrorCreateError(
      "PORTUNI_WORKSPACE_ROOT env variable is not set",
      "WORKSPACE_ROOT_UNSET",
    );
  }

  const localPath = await resolveMirrorPath(
    db,
    args.nodeId,
    nodeSyncKey,
    nodeType,
    args.customPath,
    root,
  );

  // One directory, one node. Registering a second node at an existing
  // mirror path (via customPath, or a stale registry) would make every
  // status scan attribute one folder's files to two nodes.
  const mirrors = await listUserMirrors(userId);
  const taken = mirrors.find(
    (m) => m.local_path === localPath && m.node_id !== args.nodeId,
  );
  if (taken) {
    throw new MirrorCreateError(
      `path ${localPath} is already registered as the mirror of node ${taken.node_id}`,
      "PATH_IN_USE",
    );
  }

  const subdirs = ["outputs", "wip", "resources"];
  for (const subdir of subdirs) {
    await mkdir(join(localPath, subdir), { recursive: true });
  }

  await registerMirror(userId, args.nodeId, localPath);

  const remoteScaffold = await scaffoldRemoteStructure(db, args.nodeId);
  const scopeConfig = await materializeAndRegen(localPath, args.nodeId);

  await logAudit(userId, "mirror_local", "node", args.nodeId, {
    local_path: localPath,
    remote_scaffold: remoteScaffold,
    scope_config: { written: scopeConfig.written, errors: scopeConfig.errors },
  });

  return {
    node_id: args.nodeId,
    local_path: localPath,
    created: true,
    subdirs: ["outputs/", "wip/", "resources/"],
    remote_scaffold: remoteScaffold,
    scope_config: scopeConfig,
  };
}
