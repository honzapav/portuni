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
import { getDb } from "./infra/db.js";
import { ensureSchema } from "./infra/schema.js";
import { materializeAllRegisteredMirrors } from "./domain/scope-materialize.js";

// Single ping wrapped in a hard timeout. The libsql client doesn't expose a
// connect timeout of its own, so without this a DNS hiccup or a slow Turso
// cold path can park ensureSchema() indefinitely — the frontend just sees
// the generic 30s "did not start" error with no clue why.
async function pingDb(timeoutMs: number): Promise<void> {
  const db = getDb();
  await Promise.race([
    db.execute("SELECT 1"),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`db ping timed out after ${timeoutMs}ms`)),
        timeoutMs,
      ),
    ),
  ]);
}

async function waitForDb(): Promise<void> {
  // Three attempts with backoff: first immediate, then +1s, then +2s. Each
  // call gets a 5s ceiling, so total wall time is bounded at ~18s — well
  // inside the frontend's 30s polling window. If we still can't reach the
  // DB after that, surface a clean error instead of letting ensureSchema
  // hang forever.
  const attempts = [
    { timeoutMs: 5_000, backoffMs: 0 },
    { timeoutMs: 5_000, backoffMs: 1_000 },
    { timeoutMs: 5_000, backoffMs: 2_000 },
  ];
  let lastError: unknown = null;
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    if (attempt.backoffMs > 0) {
      await new Promise((r) => setTimeout(r, attempt.backoffMs));
    }
    try {
      console.error(`[boot] db ping attempt ${i + 1}/${attempts.length}`);
      await pingDb(attempt.timeoutMs);
      console.error(`[boot] db ping ok`);
      return;
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[boot] db ping failed: ${msg}`);
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`database unreachable after ${attempts.length} attempts: ${reason}`);
}

async function main(): Promise<void> {
  const dataDir = process.env.PORTUNI_DATA_DIR;
  if (!dataDir) {
    throw new Error("PORTUNI_DATA_DIR must be set in desktop mode");
  }
  mkdirSync(dataDir, { recursive: true });

  if (!process.env.TURSO_URL || process.env.TURSO_URL.trim() === "") {
    process.env.TURSO_URL = `file:${join(dataDir, "portuni.db")}`;
  }

  await waitForDb();
  await ensureSchema();

  const port = Number(process.env.PORTUNI_PORT ?? 0);
  // Align allowed-host gate with whatever port we actually bind to,
  // and let resolvePortuniMcpUrl() (used by mirror rematerialisation
  // below) read the right value when it builds the URL.
  process.env.PORT = String(port);

  // Refresh every registered mirror's harness configs so any .mcp.json
  // pointing at an older random port / rotated token picks up the
  // current PORT + PORTUNI_AUTH_TOKEN. Best-effort: errors logged, never
  // fatal — boot must not depend on filesystem state under user mirrors.
  // Must run AFTER process.env.PORT is set (above) so the URL we write
  // matches the port we will actually bind to.
  try {
    const r = await materializeAllRegisteredMirrors();
    if (r.errors.length > 0) {
      console.error(
        `[boot] mirror rematerialisation completed with ${r.errors.length} error(s):`,
        r.errors,
      );
    }
    if (r.written.length > 0) {
      console.error(
        `[boot] refreshed ${r.written.length} per-mirror harness config file(s)`,
      );
    }
  } catch (err) {
    console.error("[boot] mirror rematerialisation skipped:", err);
  }

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
  // Structured marker line the Tauri host parses out of stdout to surface
  // a real error to the UI immediately, instead of waiting for the 30s
  // frontend polling timeout to fire with a generic "did not start"
  // message. Newlines are stripped because each marker must fit on one
  // line for the parser.
  const message = err instanceof Error ? err.message : String(err);
  process.stdout.write(`PORTUNI_BACKEND_ERROR=${message.replace(/[\r\n]+/g, " ")}\n`);
  process.exit(1);
});
