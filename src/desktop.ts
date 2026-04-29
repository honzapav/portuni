// Desktop entry point. Differs from src/index.ts in:
//   - no varlock auto-load (config arrives via explicit env from Tauri host)
//   - DB path derived from PORTUNI_DATA_DIR
//   - port from PORTUNI_PORT (0 = OS-assigned), printed on stdout so the
//     parent process can read it back as PORTUNI_LISTENING_PORT=<n>
//   - no AUTH_TOKEN by default — loopback-only is the security boundary

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { startHttpServer } from "./http/server.js";
import { ensureSchema } from "./infra/schema.js";

async function main(): Promise<void> {
  const dataDir = process.env.PORTUNI_DATA_DIR;
  if (!dataDir) {
    throw new Error("PORTUNI_DATA_DIR must be set in desktop mode");
  }
  mkdirSync(dataDir, { recursive: true });

  if (!process.env.TURSO_URL || process.env.TURSO_URL.trim() === "") {
    process.env.TURSO_URL = `file:${join(dataDir, "portuni.db")}`;
  }

  await ensureSchema();

  const port = Number(process.env.PORTUNI_PORT ?? 0);
  // Align allowed-host gate with whatever port we actually bind to.
  process.env.PORT = String(port);

  const handle = startHttpServer({ port, host: "127.0.0.1", registerSigint: false });

  if (!handle.server.listening) {
    await new Promise<void>((resolve) => handle.server.once("listening", resolve));
  }
  const address = handle.server.address() as AddressInfo | null;
  if (!address || typeof address === "string") {
    throw new Error("desktop entry: failed to bind HTTP server");
  }
  process.env.PORT = String(address.port);
  // Parent (Tauri) reads this line from stdout to learn the bound port.
  process.stdout.write(`PORTUNI_LISTENING_PORT=${address.port}\n`);

  const shutdown = async (): Promise<void> => {
    try {
      await handle.shutdown();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((err) => {
  console.error("desktop entry fatal:", err);
  process.exit(1);
});
