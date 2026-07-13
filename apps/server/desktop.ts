// Desktop entry point. Differs from src/index.ts in:
//   - no varlock auto-load (config arrives via explicit env from Tauri host)
//   - DB path derived from PORTUNI_DATA_DIR
//   - port from PORTUNI_PORT (0 = OS-assigned), printed on stdout so the
//     parent process can read it back as PORTUNI_LISTENING_PORT=<n>
//   - no AUTH_TOKEN by default — loopback-only is the security boundary

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { startHttpServer, type HttpServerHandle } from "./http/server.js";
import { getDb } from "./infra/db.js";
import { ensureSchema } from "./infra/schema.js";
import { SOLO_USER } from "./infra/schema.js";
import { materializeAllRegisteredMirrors } from "./domain/scope-materialize.js";
import { startMirrorWatcher } from "./boot/mirror-watch.js";
import { createCentralClientFromEnv, type CentralClient } from "./domain/sync/central/client.js";
import {
  listUntrackedLocalCentral,
  mapConcurrent,
  reconcilePathCentral,
} from "./domain/sync/central/engine-central.js";
import { localHashFor } from "./domain/sync/engine.js";
import { createMirrorWatcher, type MirrorWatcher } from "./domain/sync/mirror-watcher.js";
import { listUserMirrors } from "./domain/sync/mirror-registry.js";
import { createAgentRouter } from "./api/agent-router.js";
import { createAgentMcpTransport } from "./mcp/agent-transport.js";

// Reads a required env var, trimmed. Used for the two central-mode
// connection settings: both are already validated non-empty by
// createCentralClientFromEnv() by the time agentMain runs, but re-reading
// them here (rather than threading raw strings through main()) keeps the
// central-URL/token parsing local to the one place that needs the strings
// rather than the CentralClient built from them.
function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

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

// Bind the HTTP listener and announce the bound port on stdout -- shared by
// the local sidecar and the central-mode sync agent.
async function bindAndAnnounce(
  handle: HttpServerHandle,
): Promise<void> {
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
}

// Register anything on disk in one mirror that the central records don't
// know yet: ONE batch registration per mirror, then cache local hashes so
// fast status classifies the files push (same contract as the single-file
// registration path). Used for the boot backfill sweep and, via the
// watcher's backfillMirror seam, for mirrors registered while running.
async function centralBackfillMirror(
  client: CentralClient,
  m: { node_id: string },
): Promise<void> {
  const untracked = await listUntrackedLocalCentral(client, {
    userId: SOLO_USER,
    nodeId: m.node_id,
  });
  if (untracked.length === 0) return;
  const relPaths = untracked.map((u) => {
    const sub = u.subpath ? `${u.subpath.normalize("NFC")}/` : "";
    return `${u.section}/${sub}${u.filename.normalize("NFC")}`;
  });
  const regs = await client.registerFiles(m.node_id, relPaths);
  for (let i = 0; i < regs.length; i += 1) {
    await localHashFor(untracked[i].local_path, regs[i].id, null).catch(() => null);
  }
}

// Central-mode sync agent (teammate mirrors): no Turso, no graph db. Serves
// the local-only sync/mirror/scope routes backed by the central engine, runs
// the mirror watcher with a central reconcile, and also serves MCP on /mcp
// via createAgentMcpTransport -- the local front door: device-local tools
// (agent-tools.ts) run on this box, everything else proxies to the central
// MCP server. Refreshes per-mirror harness configs to point at this local
// front door (resolvePortuniMcpUrl in domain/write-scope.ts).
async function agentMain(client: CentralClient): Promise<void> {
  const port = Number(process.env.PORTUNI_PORT ?? 0);
  process.env.PORT = String(port);

  const mcpTransport = createAgentMcpTransport({
    client,
    centralUrl: requiredEnv("PORTUNI_CENTRAL_URL"),
    centralToken: requiredEnv("PORTUNI_CENTRAL_TOKEN"),
  });
  const handle = startHttpServer({
    port,
    host: "127.0.0.1",
    registerSigint: false,
    router: createAgentRouter(client),
    mcpTransport,
  });
  await bindAndAnnounce(handle);
  console.error("[boot] central-mode sync agent (no local graph db)");

  // Watcher with the central reconcile; the boot backfill is done below (the
  // built-in backfill needs the local graph db the agent doesn't have), and
  // backfillMirror covers mirrors registered while running.
  let watcher: MirrorWatcher | null = null;
  if (process.env.PORTUNI_WATCH_MIRRORS !== "0") {
    watcher = createMirrorWatcher({
      userId: SOLO_USER,
      reconcile: (a) => reconcilePathCentral(client, a),
      backfill: false,
      backfillMirror: (m) => centralBackfillMirror(client, m),
      onError: (e) => console.error("[portuni:watch]", e),
    });
    watcher
      .start()
      .then(() => console.log("[portuni:watch] mirror watcher active (central)"))
      .catch((e) => console.error("[portuni:watch] start failed:", e));
  }

  // Central backfill: register anything on disk the records don't know yet,
  // so files created while the agent was down are tracked. Best-effort.
  // Bounded fan-out across mirrors + ONE batch registration per mirror
  // instead of a strictly sequential per-file chain (perf review, scale-boot).
  void (async () => {
    try {
      const mirrors = await listUserMirrors(SOLO_USER);
      await mapConcurrent(mirrors, 4, async (m) => {
        try {
          await centralBackfillMirror(client, m);
        } catch (e) {
          console.error("[boot] central backfill failed for", m.node_id, e);
        }
      });
    } catch (e) {
      console.error("[boot] central backfill skipped:", e);
    }
  })();

  // Refresh per-mirror harness configs; in agent mode .mcp.json URLs resolve
  // to this local sidecar's front door (PORTUNI_AGENT_MODE branch of
  // resolvePortuniMcpUrl), not to central directly.
  void (async () => {
    try {
      const r = await materializeAllRegisteredMirrors({
        dataSourcesFor: (nodeId) => client.dataSources(nodeId).catch(() => []),
      });
      if (r.errors.length > 0) {
        console.error(
          `[boot] mirror rematerialisation completed with ${r.errors.length} error(s):`,
          r.errors,
        );
      }
    } catch (err) {
      console.error("[boot] mirror rematerialisation skipped:", err);
    }
  })();

  const shutdown = async (): Promise<void> => {
    try {
      watcher?.stop();
      await handle.shutdown();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

async function main(): Promise<void> {
  const dataDir = process.env.PORTUNI_DATA_DIR;
  if (!dataDir) {
    throw new Error("PORTUNI_DATA_DIR must be set in desktop mode");
  }
  mkdirSync(dataDir, { recursive: true });

  // Central-mode sync agent: PORTUNI_AGENT_MODE=1 (plus central URL+token)
  // branches before any Turso/graph-db wiring.
  const agentClient = createCentralClientFromEnv();
  if (agentClient) {
    await agentMain(agentClient);
    return;
  }

  if (!process.env.TURSO_URL || process.env.TURSO_URL.trim() === "") {
    process.env.TURSO_URL = `file:${join(dataDir, "portuni.db")}`;
  }

  await waitForDb();
  await ensureSchema();

  const port = Number(process.env.PORTUNI_PORT ?? 0);
  process.env.PORT = String(port);

  const handle = startHttpServer({ port, host: "127.0.0.1", registerSigint: false });
  await bindAndAnnounce(handle);

  // Deterministic file-state: watch every registered mirror and reconcile on
  // each change so the UI's status is correct without an agent calling
  // portuni_store / portuni_status. On by default in the desktop sidecar (the
  // single local owner of the mirrors); set PORTUNI_WATCH_MIRRORS=0 to disable.
  // Design: docs/archive/specs/2026-06-28-deterministic-file-state-design.md.
  const watcher = startMirrorWatcher(process.env.PORTUNI_WATCH_MIRRORS !== "0");

  // Refresh every registered mirror's harness configs so any .mcp.json
  // pointing at an older random port / rotated token picks up the
  // current PORT + PORTUNI_AUTH_TOKEN. Fire-and-forget *after* the HTTP
  // server is up: with N=37+ mirrors awaiting this used to add ~2 min to
  // boot, during which Tauri showed "backend failed to start". Errors
  // are logged, never fatal. Runs after PORT is set to the bound port so
  // the URL written into per-mirror configs is correct.
  void (async () => {
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
  })();

  const shutdown = async (): Promise<void> => {
    try {
      watcher?.stop();
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
