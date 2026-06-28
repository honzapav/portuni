// Entry point. Loads varlock-managed env (TURSO_*, AUTH_TOKEN, ...),
// runs schema migrations, then starts the HTTP listener that mounts both
// the REST API and the MCP transport.

import "varlock/auto-load";
import { ensureSchema } from "./infra/schema.js";
import { startHttpServer } from "./http/server.js";
import { startMirrorWatcher } from "./boot/mirror-watch.js";

async function main() {
  await ensureSchema();
  startHttpServer();
  // Standalone server: opt in with PORTUNI_WATCH_MIRRORS=1. Default off so it
  // never double-reconciles against a desktop sidecar sharing the same
  // sync.db. Design: docs/superpowers/specs/2026-06-28-deterministic-file-state-design.md.
  const watcher = startMirrorWatcher(process.env.PORTUNI_WATCH_MIRRORS === "1");
  if (watcher) process.on("SIGINT", () => watcher.stop());
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
