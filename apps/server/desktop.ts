// Desktop entry point. Differs from src/index.ts in:
//   - no varlock auto-load (config arrives via explicit env from Tauri host)
//   - DB path derived from PORTUNI_DATA_DIR
//   - port from PORTUNI_PORT (0 = OS-assigned), printed on stdout so the
//     parent process can read it back as PORTUNI_LISTENING_PORT=<n>
//   - PORTUNI_AUTH_TOKEN always passed by the Tauri host; without it the
//     sidecar refuses to start (PORTUNI_BACKEND_ERROR=..., #521)

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { startHttpServer, type HttpServerHandle } from "./http/server.js";
import { assertAuthConfig } from "./infra/auth-config.js";
import { getDb } from "./infra/db.js";
import { getDeviceContentDb } from "./infra/device-content-db.js";
import { loadDeviceIdentity } from "./domain/runner/hosts.js";
import { claimHostRecordsCentral, claimHostRecordsLocal } from "./boot/host-identity.js";
import { ensurePersonalWorkspaceSchema } from "./boot/content-import.js";
import { SOLO_USER } from "./infra/schema.js";
import { materializeAllRegisteredMirrors } from "./domain/scope-materialize.js";
import { startMirrorWatcher } from "./boot/mirror-watch.js";
import { createCentralClientFromEnv, type CentralClient } from "./domain/sync/central/client.js";
import { reconcilePathCentral } from "./domain/sync/central/engine-central.js";
import { centralBackfillMirror, createCentralBackfillSweep } from "./boot/central-backfill.js";
import {
  mirrorConfigsFresh,
  recordMirrorConfigsRefreshed,
  sidecarBuildId,
} from "./boot/mirror-config-refresh-stamp.js";
import { resolvePortuniMcpUrl } from "./domain/write-scope.js";
import { createMirrorWatcher, type MirrorWatcher } from "./domain/sync/mirror-watcher.js";
import { listUserMirrors } from "./domain/sync/mirror-registry.js";
import { createAgentSessionRuntime, getSessionRuntime } from "./boot/session-runtime.js";
import { createAgentSessionsWsDeps, createSessionsWsServer } from "./api/sessions-ws.js";
import { createAgentRouter } from "./api/agent-router.js";
import { createAgentMcpTransport } from "./mcp/agent-transport.js";
import { sweepOrphanedRunsOnBoot, sweepOrphanedRunsOnBootCentral } from "./boot/run-sweep.js";
import { sweepReadFileSpillOnBoot } from "./boot/read-file-spill-sweep.js";
import { CentralSessionStore } from "./domain/runner/store-central.js";
import {
  startIdleRunSweep,
  sweepArchivedSessionsOnBoot,
  sweepStaleDraftSessionsOnBoot,
  sweepStaleRunningSessionsOnBoot,
} from "./boot/session-sweep.js";
import { warnIfLocalWorkspaceHasStaleRemotesOnBoot } from "./boot/local-mode-remote-warning.js";
import { registerRunnerAdapters } from "./boot/register-runner-adapters.js";

// Reads a required env var, trimmed. Used for the two central-mode
// connection settings: both are already validated non-empty by
// createCentralClientFromEnv() by the time agentMain runs, but re-reading
// them here (rather than threading raw strings through main()) keeps the
// central-URL/token parsing local to the one place that needs the strings
// rather than the CentralClient built from them.
const BACKFILL_SWEEP_INTERVAL_MS = 10 * 60_000;

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

// Central-mode sync agent (teammate mirrors): no Turso, no graph db. Serves
// the local-only sync/mirror/scope routes backed by the central engine, runs
// the mirror watcher with a central reconcile, and also serves MCP on /mcp
// via createAgentMcpTransport -- the local front door: device-local tools
// (agent-tools.ts) run on this box, everything else proxies to the central
// MCP server. Refreshes per-mirror harness configs to point at this local
// front door (resolvePortuniMcpUrl in domain/write-scope.ts).
// Both workspaces end the same way on SIGTERM/SIGINT: stop the watcher,
// close the server, exit.
function exitOnSignal(
  watcher: { stop(): void } | null | undefined,
  handle: { shutdown(): Promise<void> },
): void {
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

async function agentMain(client: CentralClient, dataDir: string): Promise<void> {
  const port = Number(process.env.PORTUNI_PORT ?? 0);
  process.env.PORT = String(port);

  const mcpTransport = createAgentMcpTransport({
    client,
    centralUrl: requiredEnv("PORTUNI_CENTRAL_URL"),
    centralToken: requiredEnv("PORTUNI_CENTRAL_TOKEN"),
  });
  // One session runtime for the whole agent process: the REST routes start
  // and steer tasks on it, the live channel (GET /sessions/ws) streams
  // from it -- the desktop's sessions_connect points at THIS sidecar, so
  // without the socket mounted here central mode had no live channel at
  // all (the Rust side just reconnected forever).
  const sessionRuntime = createAgentSessionRuntime(client);
  const handle = startHttpServer({
    port,
    host: "127.0.0.1",
    registerSigint: false,
    router: createAgentRouter(client, { sessionRuntime }),
    mcpTransport,
    sessionsWs: createSessionsWsServer(createAgentSessionsWsDeps(client, sessionRuntime)),
  });
  await bindAndAnnounce(handle);
  console.error("[boot] central-mode sync agent (no local graph db)");
  // #378: this sidecar is what actually drives the run in agent mode too
  // ("one implementation" -- session-runtime.ts never changes between
  // modes), so the idle sweep runs against THIS process's own runtime
  // instance, not the local singleton (which agent mode never touches).
  startIdleRunSweep(sessionRuntime);
  // #393: this process spawns the runner children here too, so a crash or
  // a quit with a task in flight leaves the same pid files behind as in
  // local mode -- and nothing used to reap them, so the run stayed open and
  // its session read "running" forever. The idle sweep cannot see them: it
  // filters an in-process map that is empty after a restart.
  void sweepOrphanedRunsOnBootCentral(new CentralSessionStore(client));
  // #406: agent mode spills too (readNodeFileOrPath downloads through
  // CentralClient.getFileRaw for a node this device does not mirror), and no
  // MCP transport survives a restart.
  void sweepReadFileSpillOnBoot();

  // Watcher with the central reconcile; the boot backfill is done below (the
  // built-in backfill needs the local graph db the agent doesn't have), and
  // backfillMirror covers mirrors registered while running.
  // Watcher events are one-shot: a failed reconcile (central unreachable,
  // request timed out) used to get one delayed retry INLINE, awaited inside
  // the watcher's own per-mirror reconcile chain -- a 15s sleep that blocked
  // every other queued event for that mirror behind it (#273). The retry
  // now belongs on the periodic backfillSweep below (every 10 min, plus one
  // at boot) instead of in the chain: a failure here is recorded
  // (recordWatcherError, surfaced via onError) and left for that sweep to
  // repair, so one bad path stalls nothing.
  let watcher: MirrorWatcher | null = null;
  if (process.env.PORTUNI_WATCH_MIRRORS !== "0") {
    watcher = createMirrorWatcher({
      userId: SOLO_USER,
      reconcile: (a) => reconcilePathCentral(client, a),
      backfill: false,
      backfillMirror: (m) => centralBackfillMirror(client, SOLO_USER, m),
      onError: (e) => console.error("[portuni:watch]", e),
    });
    watcher
      .start()
      .then(() => console.log("[portuni:watch] mirror watcher active (central)"))
      .catch((e) => console.error("[portuni:watch] start failed:", e));
  }

  // Central backfill: register anything on disk the records don't know yet,
  // so files created while the agent was down are tracked, and drop the
  // registration of a mirror whose node central does not know (#635).
  // Best-effort. Runs at boot and then periodically -- the safety net for
  // any watcher event that was still lost despite timeout+retry (GH #80).
  const backfillSweep = createCentralBackfillSweep({ client, userId: SOLO_USER });
  void backfillSweep("boot");
  setInterval(() => void backfillSweep("sweep"), BACKFILL_SWEEP_INTERVAL_MS).unref();

  // Refresh per-mirror harness configs; in agent mode .mcp.json URLs resolve
  // to this local sidecar's front door (PORTUNI_AGENT_MODE branch of
  // resolvePortuniMcpUrl), not to central directly.
  void (async () => {
    try {
      // #633: a quick restart (same port, same mirrors, a refresh that
      // completed minutes ago) would rewrite the same files at a cost of
      // two central requests per mirror. Skip it then.
      const refreshKey = {
        mcpUrl: resolvePortuniMcpUrl(),
        build: sidecarBuildId(),
        mirrors: (await listUserMirrors(SOLO_USER)).map((m) => ({
          node_id: m.node_id,
          local_path: m.local_path,
        })),
      };
      if (mirrorConfigsFresh(dataDir, refreshKey, Date.now())) {
        console.error("[boot] mirror configs refreshed minutes ago by this build with the same URL, skipped");
        return;
      }
      // A central read that failed degrades that mirror's files; such a
      // refresh is not recorded, so the next boot fetches again.
      let centralReadFailed = false;
      const r = await materializeAllRegisteredMirrors({
        dataSourcesFor: (nodeId) =>
          client.dataSources(nodeId).catch(() => {
            centralReadFailed = true;
            return [];
          }),
        // #323 ends the "no orientation in central mode" cut: no local db
        // in agent mode, but CentralClient.orientation now backs a real
        // GET /nodes/:id/orientation on central.
        orientationFor: (nodeId) =>
          client.orientation(nodeId).catch(() => {
            centralReadFailed = true;
            return null;
          }),
      });
      if (r.errors.length > 0) {
        console.error(
          `[boot] mirror rematerialisation completed with ${r.errors.length} error(s):`,
          r.errors,
        );
      } else if (!centralReadFailed) {
        recordMirrorConfigsRefreshed(dataDir, refreshKey, Date.now());
      }
    } catch (err) {
      console.error("[boot] mirror rematerialisation skipped:", err);
    }
  })();

  exitOnSignal(watcher, handle);
}

async function main(): Promise<void> {
  // The front door always needs a bearer (#521); fail before any boot work
  // so the host shows the reason instead of a half-started sidecar.
  assertAuthConfig();
  const dataDir = process.env.PORTUNI_DATA_DIR;
  if (!dataDir) {
    throw new Error("PORTUNI_DATA_DIR must be set in desktop mode");
  }
  mkdirSync(dataDir, { recursive: true });
  registerRunnerAdapters();

  // This device's host id (#578): a ULID in the data dir, minted on the
  // first boot, so renaming the machine never turns its own threads into
  // another device's. Both workspaces; PORTUNI_HOST_ID still overrides.
  const hostIdentity = loadDeviceIdentity(dataDir);

  // The device content db (content.db next to runners.json): a thread's
  // transcript and its first message live on the device that ran it, in
  // both workspaces, so this is opened before the central-mode branch --
  // a sync agent has no graph db but it does have content.
  await getDeviceContentDb();

  // Central-mode sync agent: PORTUNI_AGENT_MODE=1 (plus central URL+token)
  // branches before any Turso/graph-db wiring.
  const agentClient = createCentralClientFromEnv();
  if (agentClient) {
    // Records made under this device's previous ids live on the central
    // server; best-effort, never holds up the boot.
    void claimHostRecordsCentral(agentClient, hostIdentity);
    await agentMain(agentClient, dataDir);
    return;
  }

  if (!process.env.TURSO_URL || process.env.TURSO_URL.trim() === "") {
    process.env.TURSO_URL = `file:${join(dataDir, "portuni.db")}`;
  }

  await waitForDb();

  // Personal workspace, one-time copy (#456): this device has always kept
  // everything, so its transcripts, briefs and inline summaries are in the
  // graph db. Moved into content.db before serving a single request, so a
  // thread opened right after the upgrade still has its history. The same
  // boot step index.ts runs; idempotent, keyed on content.db's own
  // device_schema.version, retried on the next boot after a failure. It
  // runs before ensureSchema: migration 040 drops that content from the
  // graph db and is held back while the copy is incomplete (#462).
  await ensurePersonalWorkspaceSchema();
  // Before serving: a thread this device ran under its old id is its own
  // again by the time the first request reads it (#578).
  await claimHostRecordsLocal(hostIdentity);

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

  // Must finish before sweepStaleRunningSessionsOnBoot: this sweep already
  // resolves any 'running' session a runner task was driving, so the other
  // sweep's own query for stale 'running' rows sees an already-correct
  // picture instead of racing it.
  void sweepOrphanedRunsOnBoot().then(() => sweepStaleRunningSessionsOnBoot());
  void sweepStaleDraftSessionsOnBoot();
  void sweepArchivedSessionsOnBoot();
  // #406: no MCP transport survives a restart, so every read-file spill
  // directory left on disk is orphaned.
  void sweepReadFileSpillOnBoot();
  void warnIfLocalWorkspaceHasStaleRemotesOnBoot();
  startIdleRunSweep(getSessionRuntime());

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

  exitOnSignal(watcher, handle);
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
