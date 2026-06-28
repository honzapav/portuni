// MCP server over stdio. Used by Claude Desktop and similar local hosts
// that spawn the server as a subprocess and speak JSON-RPC over its
// stdin/stdout. Re-uses createMcpServer() — same tools, same resources
// — so the surface is identical to the HTTP transport.
//
// PORTUNI_DATA_DIR controls the libSQL file location. If TURSO_URL is
// already set in the environment we honor it; otherwise default to a
// file: URL inside PORTUNI_DATA_DIR (or ./portuni.db when neither is
// provided, so a quick `npx tsx src/mcp/stdio-entry.ts` works for dev).

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ensureSchema } from "../infra/schema.js";
import { SOLO_USER } from "../infra/schema.js";
import { createMcpServer } from "./server.js";
import type { RequestIdentity } from "../auth/request-identity.js";

// JSON-RPC owns stdout in stdio mode. Anything else (migration logs,
// debug prints) must go to stderr or it corrupts the wire protocol.
console.log = (...args: unknown[]): void => {
  console.error(...args);
};

// Build env-mode identity from environment variables. SOLO_USER is the
// binding point for env mode: this is intentional and the one place in
// src/mcp that legitimately imports SOLO_USER.
function buildStdioIdentity(): RequestIdentity {
  return {
    userId: SOLO_USER,
    email: process.env.PORTUNI_USER_EMAIL ?? "solo@localhost",
    name: process.env.PORTUNI_USER_NAME ?? "Solo User",
    globalScope: "admin",
    groups: [],
    via: "env",
  };
}

async function main(): Promise<void> {
  const dataDir = process.env.PORTUNI_DATA_DIR;
  if (dataDir) {
    mkdirSync(dataDir, { recursive: true });
    if (!process.env.TURSO_URL || process.env.TURSO_URL.trim() === "") {
      process.env.TURSO_URL = `file:${join(dataDir, "portuni.db")}`;
    }
  }

  await ensureSchema();

  const identity = buildStdioIdentity();
  const { server } = createMcpServer(identity);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // stderr only -- stdout is reserved for JSON-RPC traffic.
  console.error("mcp-stdio fatal:", err);
  process.exit(1);
});
