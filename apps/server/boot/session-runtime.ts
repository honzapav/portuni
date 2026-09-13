// Composition root for the process-wide session runtime (runner batch,
// docs/superpowers/specs/2026-09-12-runner-and-session-design.md). Built
// lazily on first call rather than at either entry point's startup --
// api/sessions.ts's new task routes are the first caller, and by the time
// any of them fire, getDb() already resolved a real client. Same pattern as
// infra/db.ts's getDb()/setDbForTesting: a module-level singleton with a
// test-only override seam.

import { getDb } from "../infra/db.js";
import { DbSessionStore } from "../domain/runner/store.js";
import { getAdapter } from "../domain/runner/registry.js";
import { provisionRun } from "../domain/runner/provision.js";
import { createSessionRuntime, type SessionRuntime } from "../domain/runner/session-runtime.js";

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
