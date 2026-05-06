import { z } from "zod";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { getDb } from "../../infra/db.js";
import { logAudit } from "../../infra/audit.js";
import { SOLO_USER } from "../../infra/schema.js";
import { registerMirror, listUserMirrors } from "../../domain/sync/mirror-registry.js";
import { resolveNodeInfo } from "../../domain/sync/engine.js";
import { resolveRemote } from "../../domain/sync/routing.js";
import { getAdapter } from "../../domain/sync/adapter-cache.js";
import { buildNodeRoot } from "../../domain/sync/remote-path.js";
import { ensureUnderRoot, PathTraversalError } from "../../shared/safe-path.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  resolvePortuniRoot,
  resolveGuardScriptPath,
} from "../../domain/write-scope.js";
import { materializeScopeConfig } from "../../domain/scope-materialize.js";

// Per-type remote folder shape:
// - organizations get the parent type plurals (projects/processes/areas/principles)
// - everything else gets section folders (wip/outputs/resources)
const ORG_PLURALS = ["projects", "processes", "areas", "principles"] as const;
const NODE_SECTIONS = ["wip", "outputs", "resources"] as const;

async function scaffoldRemoteStructure(
  db: import("@libsql/client").Client,
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

const NodeMinimalRow = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
});

// Materialize the new mirror's scope config and refresh every sibling's
// .claude/settings.json + .codex/config.toml + soft hints so the deny lists
// stay in sync with the current mirror set on this device. Best-effort;
// errors are captured but don't fail the calling tool.
async function materializeAndRegen(
  newMirrorPath: string,
  newNodeId: string,
): Promise<{
  written: string[];
  errors: { path: string; message: string }[];
  portuni_root: string | null;
}> {
  const allMirrors = await listUserMirrors(SOLO_USER);
  // Make sure the new mirror is included if it isn't yet (timing: caller
  // should have just written it, but registerMirror is idempotent).
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

  // Resolve the agent-harness wiring inputs once for the whole regen sweep.
  // The MCP server URL + bearer token live in user-scoped configs
  // (~/.claude.json, ~/.codex/config.toml) written by the Settings UI;
  // mirror folders only carry permissions, sandbox, and soft hints.
  const guardScriptPath = resolveGuardScriptPath();

  const aggregated: { written: string[]; errors: { path: string; message: string }[] } = {
    written: [],
    errors: [],
  };

  for (const m of allMirrors) {
    const others = paths.filter((p) => p !== m.local_path);
    const r = await materializeScopeConfig({
      currentMirror: m.local_path,
      otherMirrors: others,
      portuniRoot,
      guardScriptPath,
    });
    aggregated.written.push(...r.written);
    aggregated.errors.push(...r.errors);
  }
  // The new mirror itself, if not yet in allMirrors (it should be).
  if (!allMirrors.find((m) => m.node_id === newNodeId)) {
    const others = paths.filter((p) => p !== newMirrorPath);
    const r = await materializeScopeConfig({
      currentMirror: newMirrorPath,
      otherMirrors: others,
      portuniRoot,
      guardScriptPath,
    });
    aggregated.written.push(...r.written);
    aggregated.errors.push(...r.errors);
  }

  return { ...aggregated, portuni_root: portuniRoot };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function registerMirrorTools(server: McpServer): void {
  server.tool(
    "portuni_mirror",
    "Create a local folder for a node and register it. Default path: {root}/{org-slug}/{type-plural}/{node-slug}/ (e.g. workflow/processes/gws-implementation). Organizations mirror directly to {root}/{org-slug}/. Creates outputs/, wip/, resources/ subfolders. Targets: only 'local' supported in Phase 1.",
    {
      node_id: z.string().describe("Node ID (ULID)"),
      targets: z
        .array(z.enum(["local"]))
        .describe("Mirror targets (only 'local' supported in Phase 1)"),
      custom_path: z
        .string()
        .optional()
        .describe("Optional override for default path ({root}/{org-slug}/{type-plural}/{node-slug})"),
    },
    async (args) => {
      const db = getDb();

      // 1. Verify node exists, get name and type
      const nodeResult = await db.execute({
        sql: "SELECT id, name, type FROM nodes WHERE id = ?",
        args: [args.node_id],
      });

      if (nodeResult.rows.length === 0) {
        return {
          content: [{ type: "text" as const, text: `Error: node ${args.node_id} not found` }],
          isError: true,
        };
      }

      const node = NodeMinimalRow.parse(nodeResult.rows[0]);
      const nodeName = node.name;

      // 2. Compute slug and path
      const slug = slugify(nodeName);
      const root = process.env.PORTUNI_WORKSPACE_ROOT?.replace(/^~/, homedir());
      if (!root) {
        return {
          content: [{ type: "text" as const, text: "Error: PORTUNI_WORKSPACE_ROOT env variable is not set" }],
          isError: true,
        };
      }

      let localPath: string;
      if (args.custom_path) {
        try {
          localPath = ensureUnderRoot(root, args.custom_path);
        } catch (e) {
          if (e instanceof PathTraversalError) {
            return {
              content: [{ type: "text" as const, text: `Error: custom_path must be inside PORTUNI_WORKSPACE_ROOT (${root})` }],
              isError: true,
            };
          }
          throw e;
        }
      } else if (node.type === "organization") {
        localPath = join(root, slug);
      } else {
        // Resolve org-aware path: {root}/{org-slug}/{type-plural}/{node-slug}
        const orgRow = await db.execute({
          sql: `SELECT n.name FROM edges e JOIN nodes n ON n.id = e.target_id
                WHERE e.source_id = ? AND e.relation = 'belongs_to' AND n.type = 'organization'
                LIMIT 1`,
          args: [args.node_id],
        });
        const TYPE_PLURAL: Record<string, string> = {
          project: "projects",
          process: "processes",
          area: "areas",
          principle: "principles",
        };
        const typePlural = TYPE_PLURAL[node.type] ?? node.type;
        if (orgRow.rows.length > 0) {
          const orgSlug = slugify(orgRow.rows[0].name as string);
          localPath = join(root, orgSlug, typePlural, slug);
        } else {
          localPath = join(root, typePlural, slug);
        }
      }

      // 3. Create directory structure
      const subdirs = ["outputs", "wip", "resources"];
      for (const subdir of subdirs) {
        await mkdir(join(localPath, subdir), { recursive: true });
      }

      // 4. Register mirror in per-device sync.db
      await registerMirror(SOLO_USER, args.node_id, localPath);

      // 5. Scaffold the remote folder structure if a remote is routed.
      // Best-effort: if Drive is unreachable or no routing is configured,
      // local mirror still succeeds.
      const remoteScaffold = await scaffoldRemoteStructure(db, args.node_id);

      // 6. Materialize per-harness scope config. Best-effort: failures are
      //    captured in the response but don't fail the registration. After
      //    we wrote the new mirror's row, regenerate every sibling's deny
      //    list so it includes this fresh mirror.
      const scopeConfig = await materializeAndRegen(localPath, args.node_id);

      // 7. Log audit
      await logAudit(SOLO_USER, "mirror_local", "node", args.node_id, {
        local_path: localPath,
        remote_scaffold: remoteScaffold,
        scope_config: { written: scopeConfig.written, errors: scopeConfig.errors },
      });

      // 8. Return result
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              node_id: args.node_id,
              local_path: localPath,
              subdirs: ["outputs/", "wip/", "resources/"],
              remote_scaffold: remoteScaffold,
              scope_config: scopeConfig,
            }),
          },
        ],
      };
    },
  );
}
