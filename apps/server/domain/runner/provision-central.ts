// Central/agent-mode counterpart of provision.ts's provisionRun (spec:
// "the same runtime runs in the central-mode sidecar with a SessionStore
// that talks to central over HTTP instead of libsql" -- provisioning needs
// the same swap). Ends the "no orientation section in central mode" cut
// (CLAUDE.md): CentralClient.orientation(nodeId) now backs a real
// GET /nodes/:id/orientation on central, so a task's runner gets the same
// node-context orientation a local task does, computed on central (which
// has the real graph db) instead of never at all.

import { createMirrorForNodeCentral } from "../sync/central/engine-central.js";
import { listUserMirrors } from "../sync/mirror-registry.js";
import {
  appendHomeNodeIdToUrl,
  buildOrientationHint,
  resolvePortuniMcpUrl,
  resolvePortuniRoot,
  resolveTokenEnvVar,
} from "../write-scope.js";
import type { CentralClient } from "../sync/central/client.js";
import type { ProvisionRunInput, ProvisionRunResult } from "./provision.js";

export function createProvisionRunCentral(
  client: CentralClient,
): (input: ProvisionRunInput) => Promise<ProvisionRunResult> {
  return async function provisionRunCentral(input: ProvisionRunInput): Promise<ProvisionRunResult> {
    // Idempotent, same as the local path: a node already mirrored on this
    // device returns the existing path without re-touching disk.
    const mirror = await createMirrorForNodeCentral(client, input.userId, { nodeId: input.nodeId });
    const cwd = mirror.local_path;

    const allMirrors = await listUserMirrors(input.userId);
    const mirrorPaths = allMirrors.map((m) => m.local_path);
    const portuniRoot =
      resolvePortuniRoot({ envValue: process.env.PORTUNI_ROOT ?? null, knownMirrors: mirrorPaths }) ?? cwd;

    const summary = await client.orientation(input.nodeId).catch(() => null);
    const handoffResume = input.resume?.mode === "handoff" && !!input.resume.handoffPath;
    let orientation = summary ? buildOrientationHint(handoffResume ? { ...summary, handoff: null } : summary) : "";
    if (handoffResume && input.resume?.handoffPath) {
      orientation +=
        `\n## Předání (obnovení z handoffu)\n\n` +
        `Konverzace se neobnovuje přímo; pokračuješ ze zápisu na \`${input.resume.handoffPath}\`. ` +
        `Přečti si ho, než začneš.\n`;
    }

    // resolvePortuniMcpUrl already resolves to the local sidecar front door
    // in agent mode (PORTUNI_AGENT_MODE branch) -- device-local tools stay
    // local, graph/scope tools proxy to central, same as every other agent-
    // mode MCP connection.
    const url = appendHomeNodeIdToUrl(resolvePortuniMcpUrl(), input.nodeId);
    const token = process.env[resolveTokenEnvVar()] ?? "";

    return { cwd, orientation, mcp: { url, token, homeNodeId: input.nodeId }, portuniRoot, mirrors: mirrorPaths };
  };
}
