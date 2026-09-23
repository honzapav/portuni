// Composition root for the process-wide session runtime (runner batch,
// docs/superpowers/specs/2026-09-12-runner-and-session-design.md). Built
// lazily on first call rather than at either entry point's startup --
// api/sessions.ts's new task routes are the first caller, and by the time
// any of them fire, getDb() already resolved a real client. Same pattern as
// infra/db.ts's getDb()/setDbForTesting: a module-level singleton with a
// test-only override seam.

import { getDb } from "../infra/db.js";
import { DbSessionStore } from "../domain/runner/store.js";
import { deviceSessionContentStore } from "../domain/runner/store-content.js";
import { CentralSessionStore } from "../domain/runner/store-central.js";
import { getAdapter } from "../domain/runner/registry.js";
import { provisionRun } from "../domain/runner/provision.js";
import { createProvisionRunCentral } from "../domain/runner/provision-central.js";
import { registerLocalFileCentral } from "../domain/sync/central/engine-central.js";
import { createSuspendServerSide, handoffEnrichedName } from "../domain/session-handoff.js";
import { createSessionRuntime, type SessionRuntime } from "../domain/runner/session-runtime.js";
import type { CentralClient } from "../domain/sync/central/client.js";

let runtime: SessionRuntime | null = null;

export function getSessionRuntime(): SessionRuntime {
  if (!runtime) {
    runtime = createSessionRuntime({
      store: new DbSessionStore(getDb()),
      content: deviceSessionContentStore(),
      registry: { getAdapter },
      provision: provisionRun,
    });
  }
  return runtime;
}

// Test-only seam. A test builds its own runtime (typically over a
// FakeRunnerAdapter and a temp :memory: store) and installs it here so the
// REST routes exercise it instead of lazily constructing the production one
// against whatever getDb() happens to resolve to at that moment.
export function setSessionRuntimeForTesting(rt: SessionRuntime | null): void {
  runtime = rt;
}

// Agent-mode counterpart of getSessionRuntime() (runner batch, #323): a
// fresh, non-singleton instance bound to CentralSessionStore/
// provisionRunCentral instead of the local db -- the agent-mode sidecar has
// no graph db of its own, so it can never use the local singleton above.
// createAgentRouter(client) calls this once at boot, the same way desktop.ts
// builds exactly one CentralClient per agent-mode sidecar process. The
// adapter registry is the SAME process-global one local mode uses --
// adapters (Claude, the fake) are not mode-specific.
export function createAgentSessionRuntime(client: CentralClient): SessionRuntime {
  const store = new CentralSessionStore(client);
  const content = deviceSessionContentStore();
  return createSessionRuntime({
    store,
    content,
    registry: { getAdapter },
    provision: createProvisionRunCentral(client),
    // #458: the same suspend the personal workspace runs, with the two
    // graph-db reads it needs pointed at the central server -- the summary
    // itself, the file in the mirror and the inline fallback are shared
    // code (domain/session-handoff.ts). The team-workspace copy of that
    // algorithm is gone; these four seams replaced it.
    suspendFallback: createSuspendServerSide({
      record: store,
      content,
      scope: (sessionId) => client.sessionScopeRecord(sessionId),
      suspendRecord: (session, input) =>
        store.patchSession(session.id, {
          state: "suspended",
          waiting_since: null,
          handoff_path: input.handoffPath,
          handoff_hash: input.handoffHash,
          name: handoffEnrichedName(session, input.handoffTitle),
        }),
      // Record-only registration, exactly what the watcher does for a file
      // that appeared in the mirror: the handoff shows up under Files at
      // once, and the push is a later deliberate sync run (#427).
      trackHandoff: async (input) => {
        await registerLocalFileCentral(client, input);
      },
    }),
    // #407: the belongs_to edge lives on central's graph db, so the
    // organization default instance is resolved there too -- without this
    // the runtime's local query would throw here and every task in this
    // mode would silently run on the runner's own default instance.
    resolveNodeOrgId: (nodeId) => client.nodeOrganizationId(nodeId),
  });
}
