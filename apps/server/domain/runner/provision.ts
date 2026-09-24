// Provisioning for a runner run (spec: "provision.ts"): ensure the mirror
// exists, build the orientation text, and resolve the MCP endpoint the
// adapter's own MCP client connects back through. Reuses the exact
// functions the REST/MCP spawn flow already calls (domain/sync/mirror-
// create.ts's createMirrorForNode, domain/scope-materialize.ts's
// orientationForNode, domain/write-scope.ts's URL/token helpers).

import { getDb } from "../../infra/db.js";
import { createMirrorForNode } from "../sync/mirror-create.js";
import { listUserMirrors } from "../sync/mirror-registry.js";
import {
  appendHomeNodeIdToUrl,
  buildOrientationHint,
  resolvePortuniMcpUrl,
  resolvePortuniRoot,
  resolveRunnerMcpToken,
} from "../write-scope.js";
import { orientationForNode } from "../scope-materialize.js";

export interface ProvisionRunResumeInfo {
  mode: "conversation" | "handoff";
  // The pointer text appended to the orientation on a handoff resume --
  // absent/ignored for a conversation resume, which needs no extra hint
  // (the runner's own conversation already has the context).
  handoffPath?: string | null;
}

export interface ProvisionRunInput {
  userId: string;
  nodeId: string;
  // Null when the run is provisioned before its record exists (a new
  // thread is provisioned first, so a run that cannot start creates
  // nothing).
  sessionId: string | null;
  resume: ProvisionRunResumeInfo | null;
}

export interface ProvisionRunResult {
  cwd: string;
  orientation: string;
  mcp: { url: string; token: string; homeNodeId: string };
  portuniRoot: string;
  mirrors: string[];
}

export async function provisionRun(input: ProvisionRunInput): Promise<ProvisionRunResult> {
  // First, before any mirror work: a run without a front-door bearer
  // cannot reach Portuni at all (#507).
  const token = resolveRunnerMcpToken();
  const db = getDb();

  // Idempotent: a node already mirrored on this device returns the
  // existing path without re-touching disk or scope config.
  const mirror = await createMirrorForNode(db, input.userId, { nodeId: input.nodeId });
  const cwd = mirror.local_path;

  const allMirrors = await listUserMirrors(input.userId);
  const mirrorPaths = allMirrors.map((m) => m.local_path);
  const portuniRoot =
    resolvePortuniRoot({ envValue: process.env.PORTUNI_ROOT ?? null, knownMirrors: mirrorPaths }) ?? cwd;

  const summary = await orientationForNode(input.nodeId, input.userId);
  const handoffResume = input.resume?.mode === "handoff" && !!input.resume.handoffPath;
  // orientationForNode points at the node's most recent suspended session's
  // handoff on its own; on a handoff resume the pointer below names THIS
  // session's, so the generic one is dropped rather than carried twice.
  let orientation = summary ? buildOrientationHint(handoffResume ? { ...summary, handoff: null } : summary) : "";
  if (handoffResume && input.resume?.handoffPath) {
    orientation +=
      `\n## Předání (obnovení z handoffu)\n\n` +
      `Konverzace se neobnovuje přímo; pokračuješ ze zápisu na \`${input.resume.handoffPath}\`. ` +
      `Přečti si ho, než začneš.\n`;
  }

  const url = appendHomeNodeIdToUrl(resolvePortuniMcpUrl(), input.nodeId);

  return {
    cwd,
    orientation,
    mcp: { url, token, homeNodeId: input.nodeId },
    portuniRoot,
    mirrors: mirrorPaths,
  };
}
