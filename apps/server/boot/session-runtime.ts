// Composition root for the process-wide session runtime (runner batch,
// docs/superpowers/specs/2026-09-12-runner-and-session-design.md). Built
// lazily on first call rather than at either entry point's startup --
// api/sessions.ts's new task routes are the first caller, and by the time
// any of them fire, getDb() already resolved a real client. Same pattern as
// infra/db.ts's getDb()/setDbForTesting: a module-level singleton with a
// test-only override seam.

import { getDb } from "../infra/db.js";
import { DbSessionStore } from "../domain/runner/store.js";
import { CentralSessionStore } from "../domain/runner/store-central.js";
import { getAdapter } from "../domain/runner/registry.js";
import { provisionRun } from "../domain/runner/provision.js";
import { createProvisionRunCentral } from "../domain/runner/provision-central.js";
import { createSuspendFallbackCentral } from "../domain/runner/suspend-fallback-central.js";
import { createSessionRuntime, type SessionRuntime } from "../domain/runner/session-runtime.js";
import type { CentralClient } from "../domain/sync/central/client.js";

let runtime: SessionRuntime | null = null;

export function getSessionRuntime(): SessionRuntime {
  if (!runtime) {
    runtime = createSessionRuntime({
      store: new DbSessionStore(getDb()),
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
export function createAgentSessionRuntime(
  client: CentralClient,
  // Test-only override for the suspend() poll loop, same reasoning as
  // CreateSessionRuntimeDeps's own suspendPollIntervalMs/suspendTimeoutMs --
  // production never sets this.
  opts?: { suspendPollIntervalMs?: number; suspendTimeoutMs?: number },
): SessionRuntime {
  const store = new CentralSessionStore(client);
  return createSessionRuntime({
    store,
    registry: { getAdapter },
    provision: createProvisionRunCentral(client),
    suspendFallback: createSuspendFallbackCentral(store),
    suspendPollIntervalMs: opts?.suspendPollIntervalMs,
    suspendTimeoutMs: opts?.suspendTimeoutMs,
  });
}
