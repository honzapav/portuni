// Registers every runner adapter this process can run tasks with (spec:
// "registry.ts: adapters by id; detect() on each at boot and on GET
// /runners"). Called once from both entry points (index.ts, desktop.ts) --
// the registry itself is a process-wide singleton (domain/runner/
// registry.ts), so registering twice would just be redundant, not harmful,
// but there is only ever one of these calls per process.

import { registerAdapter } from "../domain/runner/registry.js";
import { createClaudeAdapter } from "../domain/runner/adapters/claude.js";

export function registerRunnerAdapters(): void {
  registerAdapter(createClaudeAdapter());
}
