// Central/agent-mode counterpart of provision.ts's provisionRun (spec:
// "the same runtime runs in the central-mode sidecar with a SessionStore
// that talks to central over HTTP instead of libsql" -- provisioning needs
// the same swap). Ends the "no orientation section in central mode" cut
// (CLAUDE.md): CentralClient.orientation(nodeId) now backs a real
// GET /nodes/:id/orientation on central, so a task's runner gets the same
// node-context orientation a local task does, computed on central (which
// has the real graph db) instead of never at all.

import { createMirrorForNodeCentral } from "../sync/central/engine-central.js";
import { resolveRunnerMcpToken } from "../write-scope.js";
import type { CentralClient } from "../sync/central/client.js";
import { completeProvisionRun, type ProvisionRunInput, type ProvisionRunResult } from "./provision.js";

export function createProvisionRunCentral(
  client: CentralClient,
): (input: ProvisionRunInput) => Promise<ProvisionRunResult> {
  return async function provisionRunCentral(input: ProvisionRunInput): Promise<ProvisionRunResult> {
    // First, before any mirror work: a run without a front-door bearer
    // cannot reach Portuni at all (#507).
    const token = resolveRunnerMcpToken();
    // Idempotent, same as the local path: a node already mirrored on this
    // device returns the existing path without re-touching disk.
    const mirror = await createMirrorForNodeCentral(client, input.userId, { nodeId: input.nodeId });
    const cwd = mirror.local_path;

    return completeProvisionRun(input, token, cwd, () => client.orientation(input.nodeId).catch(() => null));
  };
}
