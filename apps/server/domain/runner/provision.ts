// Provisioning for a runner run (spec: "provision.ts"): what the terminal
// spawn path does today, minus the terminal itself -- ensure the mirror
// exists, build the orientation text, and resolve the MCP endpoint the
// adapter's own MCP client connects back through. Reuses the exact
// functions the REST/MCP spawn flow already calls
// (domain/sync/mirror-create.ts's createMirrorForNode, domain/scope-
// materialize.ts's orientationForNode, domain/write-scope.ts's URL/token
// helpers) rather than the Seatbelt-specific parts of
// domain/sandbox-profile.ts, which this does not import.

import { getDb } from "../../infra/db.js";
import { createMirrorForNode } from "../sync/mirror-create.js";
import { listUserMirrors } from "../sync/mirror-registry.js";
import {
  appendHomeNodeIdToUrl,
  buildOrientationHint,
  resolvePortuniMcpUrl,
  resolvePortuniRoot,
  resolveTokenEnvVar,
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
  sessionId: string;
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
  const db = getDb();

  // Idempotent: a node already mirrored on this device returns the
  // existing path without re-touching disk or scope config.
  const mirror = await createMirrorForNode(db, input.userId, { nodeId: input.nodeId });
  const cwd = mirror.local_path;

  const allMirrors = await listUserMirrors(input.userId);
  const mirrorPaths = allMirrors.map((m) => m.local_path);
  const portuniRoot =
    resolvePortuniRoot({ envValue: process.env.PORTUNI_ROOT ?? null, knownMirrors: mirrorPaths }) ?? cwd;

  const summary = await orientationForNode(input.nodeId);
  let orientation = summary ? buildOrientationHint(summary) : "";
  if (input.resume?.mode === "handoff" && input.resume.handoffPath) {
    orientation +=
      `\n## Předání (obnovení z handoffu)\n\n` +
      `Konverzace se neobnovuje přímo; pokračuješ ze zápisu na \`${input.resume.handoffPath}\`. ` +
      `Přečti si ho, než začneš.\n`;
  }

  const url = appendHomeNodeIdToUrl(resolvePortuniMcpUrl(), input.nodeId);
  const token = process.env[resolveTokenEnvVar()] ?? "";

  return {
    cwd,
    orientation,
    mcp: { url, token, homeNodeId: input.nodeId },
    portuniRoot,
    mirrors: mirrorPaths,
  };
}
