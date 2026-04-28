// Entry point. Loads varlock-managed env (TURSO_*, AUTH_TOKEN, ...),
// runs schema migrations, then starts the HTTP listener that mounts both
// the REST API and the MCP transport.

import "varlock/auto-load";
import { ensureSchema } from "./infra/schema.js";
import { startHttpServer } from "./http/server.js";

async function main() {
  await ensureSchema();
  startHttpServer();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
