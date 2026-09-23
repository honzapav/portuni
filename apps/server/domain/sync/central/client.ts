// HTTP client for the central Portuni server, used by the sidecar when it
// runs as a central-mode sync agent (teammate mirrors). This is the ONLY
// place agent-side sync code talks to the network: everything else works
// against the local disk and the per-device sync.db.
//
// Auth: a per-user device token (Bearer). The agent never holds a Turso
// token or Drive credentials -- the central server enforces node visibility
// and global scopes on every call, so a compromised device can reach exactly
// what its user could reach anyway.

import type { DataSourceRow, SessionRow, SessionState } from "../../../shared/types.js";
import type { LegacySessionContentPage, SessionScopeRecord } from "../../../shared/api-types.js";
import type { NodeSyncInfo, RegisterFileRecordResult } from "../sync-remote-api.js";
import type { RemoteSweepResult } from "../remote-sweep.js";
import type { OrientationSummary } from "../../write-scope.js";
import type {
  CreateDraftSessionInput,
  CreateRunInput,
  CreateRunnerSessionInput,
  PatchRunInput,
  PatchSessionInput,
  SessionRunRow,
} from "../../runner/store.js";

export class CentralHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly currentVersion?: string,
  ) {
    super(message);
    this.name = "CentralHttpError";
  }
}

export interface PutFileOpts {
  baseVersion?: string;
  // Stat-only canonical-hash precondition (sync-agent conflict check).
  baseCanonicalHash?: string;
  // Create-only write (clobber-safe adopt of brand-new files).
  ifAbsent?: boolean;
  force?: boolean;
}

export interface CentralClient {
  syncInfo(nodeId: string): Promise<NodeSyncInfo>;
  // One request for many nodes (cross-mirror pending aggregate). Hidden or
  // missing nodes are omitted from the result.
  syncInfoBatch(nodeIds: string[]): Promise<NodeSyncInfo[]>;
  registerFile(nodeId: string, relPath: string): Promise<RegisterFileRecordResult>;
  registerFiles(nodeId: string, relPaths: string[]): Promise<RegisterFileRecordResult[]>;
  // Mirror-less create (POST /nodes/:id/files), adapter-direct on the
  // central server -- used only when THIS device has no mirror for the
  // node (#266); a device with a mirror creates locally instead (writes
  // the file into the mirror, registers record-only, pushes in the
  // background) rather than routing through this call.
  createFile(
    nodeId: string,
    args: { filename: string; section?: string; subpath?: string | null; content?: string },
  ): Promise<{
    id: string;
    filename: string;
    status: string;
    local_path: string | null;
    relative_path: string | null;
    mime_type: string | null;
  }>;
  getFileRaw(
    nodeId: string,
    relPath: string,
  ): Promise<{ bytes: Buffer; version: string; canonicalHash: string }>;
  putFileRaw(
    nodeId: string,
    relPath: string,
    bytes: Buffer,
    opts?: PutFileOpts,
  ): Promise<{ version: string; canonicalHash: string }>;
  // Record+remote rename on central (POST /nodes/:id/files/:id/rename):
  // basename swap in place. The caller owns the local disk side (the agent
  // router renames the device copy after central confirms).
  renameFile(nodeId: string, fileId: string, newFilename: string): Promise<Record<string, unknown>>;
  // Record+remote move on central (POST /nodes/:id/files/:id/move). The
  // caller owns the local disk side; central's own local step no-ops.
  moveFileRecord(
    nodeId: string,
    fileId: string,
    body: {
      new_section?: string;
      new_subpath?: string | null;
      new_filename?: string;
      new_node_id?: string;
      confirmed: boolean;
    },
  ): Promise<Record<string, unknown>>;
  // Confirmed record delete on central (DELETE /nodes/:id/files/:id). For a
  // never-pushed record this is record-only (no remote object exists).
  deleteFileRecord(nodeId: string, fileId: string): Promise<Record<string, unknown>>;
  // Remote credentials live on the central server, so the sweep runs there
  // (POST /nodes/:id/sync/remote-sweep) -- the agent calls this and folds
  // the outcome into its own sync run instead of sweeping locally.
  remoteSweep(nodeId: string): Promise<RemoteSweepResult>;
  dataSources(nodeId: string): Promise<DataSourceRow[]>;
  nodeExists(nodeId: string): Promise<boolean>;
  // The node's organization, read off central's own node-detail edges
  // (#407): the runner's task defaults resolve the organization default
  // instance from it, and an agent-mode sidecar has no graph db of its own
  // to query for the belongs_to edge. null when the node has no
  // organization or central does not know the node.
  nodeOrganizationId(nodeId: string): Promise<string | null>;
  // Drop any cached sync-info for the node (called automatically after
  // mutations through this client; exposed for external invalidation).
  invalidateSyncInfo(nodeId: string): void;

  // Session/runner record half (docs/superpowers/specs/2026-09-12-runner-
  // and-session-design.md, "Central (record half)"): domain/runner/
  // store-central.ts's CentralSessionStore is built over exactly these
  // methods, one per REST endpoint api/sessions.ts's "central record half"
  // section serves -- see that file's own header comment for the route list.
  getSessionRecord(id: string): Promise<SessionRow | null>;
  // GET /sessions?state=a,b&limit=n -- the sessions this device's user can
  // see in the given states (api/sessions.ts's handleListSessions); the
  // agent-mode live channel's initial session_state snapshot.
  listSessionRecords(opts: { states: readonly SessionState[]; limit?: number }): Promise<SessionRow[]>;
  createSessionRecord(input: CreateRunnerSessionInput): Promise<SessionRow>;
  // #374's draft thread, created before a brief or runner exists. Same
  // POST /sessions/record endpoint, its draft shape -- the row is the
  // thread, so central has to own it in this mode too.
  createDraftSessionRecord(input: CreateDraftSessionInput): Promise<SessionRow>;
  patchSessionRecord(id: string, patch: PatchSessionInput): Promise<SessionRow>;
  createSessionRun(input: CreateRunInput): Promise<SessionRunRow>;
  patchSessionRun(sessionId: string, runId: string, patch: PatchRunInput): Promise<SessionRunRow>;
  listSessionRuns(sessionId: string): Promise<SessionRunRow[]>;
  // There is deliberately no event method here: a thread's transcript, its
  // first message and its inline handoff summary are CONTENT and stay on
  // the device that ran it (#456, docs/superpowers/specs/
  // 2026-09-22-local-sessions-design.md, "Principle"). Nothing on the
  // device sends them to the central server; SessionContentStore over the
  // device's own content.db is their only writer and reader.
  // GET /sessions/:id/scope (#427): the session's read/write set by node id
  // and the anchor node's name. `session_scope` is a graph-db table, so a
  // sync agent has none -- the server-side suspend
  // (domain/session-handoff.ts's createSuspendServerSide, #458) fills its
  // summary's scope sections from here instead of leaving them empty.
  sessionScopeRecord(sessionId: string): Promise<SessionScopeRecord>;
  // The one exception to "no content crosses": the content a sidecar
  // released before #456 DID send, read back once so this device keeps its
  // own history (boot/content-import.ts, first boot of a sync agent). The
  // ids of the device user's threads that ran on `hostId` and still have
  // legacy content on the central server, then one thread's content, its
  // events a page at a time. Owner-only on the central server; nothing on
  // the device writes content back.
  listLegacySessionContent(hostId: string): Promise<string[]>;
  getLegacySessionContent(sessionId: string, opts?: { after?: number }): Promise<LegacySessionContentPage>;
  // GET /nodes/:id/orientation: what buildOrientationHint would render
  // locally, computed by the central server (which has the real graph db)
  // instead of the agent-mode sidecar (which does not).
  orientation(nodeId: string): Promise<OrientationSummary | null>;
}

interface HttpClientArgs {
  baseUrl: string;
  token: string;
  // Injectable for tests; defaults to global fetch.
  fetchImpl?: typeof fetch;
  // Per-request budget override (tests). Defaults: 10 s GET, 30 s mutations.
  requestTimeoutMs?: number;
  // sync-info micro-cache TTL. Absorbs the request storms the perf review
  // flagged: a bulk of watcher events, the 5s status poll overlapping the
  // pending poll, and window-focus bursts all ask for the same document
  // within a few seconds. 0 disables. Default 3000 ms -- staleness is
  // bounded well under the UI's own 5s poll cadence.
  syncInfoTtlMs?: number;
}

const GET_TIMEOUT_MS = 10_000;
const MUTATION_TIMEOUT_MS = 30_000;

export function createHttpCentralClient(args: HttpClientArgs): CentralClient {
  const base = args.baseUrl.replace(/\/+$/, "");
  const doFetch = args.fetchImpl ?? fetch;
  const ttl = args.syncInfoTtlMs ?? 3000;
  // nodeId -> in-flight promise (concurrent dedup) or settled value + stamp.
  const infoCache = new Map<
    string,
    { promise: Promise<NodeSyncInfo>; resolvedAt: number | null }
  >();

  async function requestOnce(
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<{ status: number; json: unknown }> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${args.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON body (unexpected); error paths below still carry status */
    }
    return { status: res.status, json };
  }

  // fetch has no default timeout, so a request scheduled onto a dead
  // keep-alive slot would otherwise hang forever and its payload silently
  // never arrive (GH #80). Timeout every request and retry once on
  // abort/network failure -- the retry opens a fresh connection instead of
  // reusing the zombie slot. HTTP error statuses are returned, not thrown,
  // so they never retry. A mutation whose first attempt did land surfaces
  // as a version/precondition error to the caller rather than silent loss.
  async function request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const timeoutMs =
      args.requestTimeoutMs ?? (method === "GET" ? GET_TIMEOUT_MS : MUTATION_TIMEOUT_MS);
    try {
      return await requestOnce(method, path, body, timeoutMs);
    } catch {
      return requestOnce(method, path, body, timeoutMs);
    }
  }

  function throwFor(status: number, path: string, json: unknown): never {
    const obj = (json ?? {}) as Record<string, unknown>;
    throw new CentralHttpError(
      `central ${path} -> ${status}: ${typeof obj.error === "string" ? obj.error : "request failed"}`,
      status,
      typeof obj.code === "string" ? obj.code : undefined,
      typeof obj.currentVersion === "string" ? obj.currentVersion : undefined,
    );
  }

  async function fetchSyncInfo(nodeId: string): Promise<NodeSyncInfo> {
    const p = `/nodes/${encodeURIComponent(nodeId)}/sync-info`;
    const r = await request("GET", p);
    if (r.status !== 200) throwFor(r.status, p, r.json);
    return r.json as NodeSyncInfo;
  }

  function invalidate(nodeId: string): void {
    infoCache.delete(nodeId);
  }

  return {
    async syncInfo(nodeId) {
      if (ttl > 0) {
        const hit = infoCache.get(nodeId);
        if (hit) {
          // In-flight: share the promise. Settled: honour the TTL.
          if (hit.resolvedAt === null || Date.now() - hit.resolvedAt < ttl) {
            return hit.promise;
          }
          infoCache.delete(nodeId);
        }
      }
      const entry = { promise: fetchSyncInfo(nodeId), resolvedAt: null as number | null };
      if (ttl > 0) {
        infoCache.set(nodeId, entry);
        entry.promise.then(
          () => {
            entry.resolvedAt = Date.now();
          },
          () => {
            // Never cache failures.
            if (infoCache.get(nodeId) === entry) infoCache.delete(nodeId);
          },
        );
      }
      return entry.promise;
    },

    async syncInfoBatch(nodeIds) {
      if (nodeIds.length === 0) return [];
      const p = "/sync/info-batch";
      const r = await request("POST", p, { node_ids: nodeIds });
      if (r.status !== 200) throwFor(r.status, p, r.json);
      const infos = (r.json as { infos: NodeSyncInfo[] }).infos;
      // Freshest data we have -- seed the cache with it.
      if (ttl > 0) {
        const now = Date.now();
        for (const info of infos) {
          infoCache.set(info.node.id, { promise: Promise.resolve(info), resolvedAt: now });
        }
      }
      return infos;
    },

    async registerFile(nodeId, relPath) {
      const p = `/nodes/${encodeURIComponent(nodeId)}/files/register`;
      const r = await request("POST", p, { relPath });
      invalidate(nodeId);
      if (r.status !== 201) throwFor(r.status, p, r.json);
      return r.json as RegisterFileRecordResult;
    },

    async registerFiles(nodeId, relPaths) {
      if (relPaths.length === 0) return [];
      const p = `/nodes/${encodeURIComponent(nodeId)}/files/register-batch`;
      const r = await request("POST", p, { relPaths });
      invalidate(nodeId);
      if (r.status !== 201) throwFor(r.status, p, r.json);
      return (r.json as { files: RegisterFileRecordResult[] }).files;
    },

    async createFile(nodeId, args) {
      const p = `/nodes/${encodeURIComponent(nodeId)}/files`;
      const r = await request("POST", p, args);
      invalidate(nodeId);
      if (r.status !== 201) throwFor(r.status, p, r.json);
      return r.json as {
        id: string;
        filename: string;
        status: string;
        local_path: string | null;
        relative_path: string | null;
        mime_type: string | null;
      };
    },

    async getFileRaw(nodeId, relPath) {
      const p = `/nodes/${encodeURIComponent(nodeId)}/file?path=${encodeURIComponent(relPath)}&encoding=base64`;
      const r = await request("GET", p);
      if (r.status !== 200) throwFor(r.status, p, r.json);
      const j = r.json as { content_base64: string; version: string; canonical_hash: string };
      return {
        bytes: Buffer.from(j.content_base64, "base64"),
        version: j.version,
        canonicalHash: j.canonical_hash,
      };
    },

    async putFileRaw(nodeId, relPath, bytes, opts) {
      const p = `/nodes/${encodeURIComponent(nodeId)}/file?path=${encodeURIComponent(relPath)}`;
      const r = await request("PUT", p, {
        content_base64: bytes.toString("base64"),
        ...(opts?.baseVersion ? { baseVersion: opts.baseVersion } : {}),
        ...(opts?.baseCanonicalHash ? { baseCanonicalHash: opts.baseCanonicalHash } : {}),
        ...(opts?.ifAbsent ? { ifAbsent: true } : {}),
        ...(opts?.force ? { force: true } : {}),
      });
      invalidate(nodeId);
      if (r.status !== 200) throwFor(r.status, p, r.json);
      const j = r.json as { version: string; canonical_hash: string };
      return { version: j.version, canonicalHash: j.canonical_hash };
    },

    async renameFile(nodeId, fileId, newFilename) {
      const p = `/nodes/${encodeURIComponent(nodeId)}/files/${encodeURIComponent(fileId)}/rename`;
      const r = await request("POST", p, { new_filename: newFilename });
      invalidate(nodeId);
      if (r.status !== 200) throwFor(r.status, p, r.json);
      return r.json as Record<string, unknown>;
    },

    async moveFileRecord(nodeId, fileId, body) {
      const p = `/nodes/${encodeURIComponent(nodeId)}/files/${encodeURIComponent(fileId)}/move`;
      const r = await request("POST", p, body);
      invalidate(nodeId);
      if (body.new_node_id) invalidate(body.new_node_id);
      if (r.status !== 200) throwFor(r.status, p, r.json);
      return r.json as Record<string, unknown>;
    },

    async deleteFileRecord(nodeId, fileId) {
      const p = `/nodes/${encodeURIComponent(nodeId)}/files/${encodeURIComponent(fileId)}?confirmed=true`;
      const r = await request("DELETE", p);
      invalidate(nodeId);
      if (r.status !== 200) throwFor(r.status, p, r.json);
      return r.json as Record<string, unknown>;
    },

    async remoteSweep(nodeId) {
      const p = `/nodes/${encodeURIComponent(nodeId)}/sync/remote-sweep`;
      const r = await request("POST", p);
      invalidate(nodeId);
      if (r.status !== 200) throwFor(r.status, p, r.json);
      return r.json as RemoteSweepResult;
    },

    async dataSources(nodeId) {
      const p = `/data-sources?node_id=${encodeURIComponent(nodeId)}`;
      const r = await request("GET", p);
      if (r.status !== 200) throwFor(r.status, p, r.json);
      return r.json as DataSourceRow[];
    },

    async nodeExists(nodeId) {
      const p = `/nodes/${encodeURIComponent(nodeId)}`;
      const r = await request("GET", p);
      if (r.status === 200) return true;
      if (r.status === 404) return false;
      throwFor(r.status, p, r.json);
    },

    async nodeOrganizationId(nodeId) {
      const p = `/nodes/${encodeURIComponent(nodeId)}`;
      const r = await request("GET", p);
      if (r.status === 404) return null;
      if (r.status !== 200) throwFor(r.status, p, r.json);
      const edges =
        (r.json as { edges?: Array<{ relation?: string; direction?: string; peer_id?: string; peer_type?: string }> })
          .edges ?? [];
      const org = edges.find(
        (e) =>
          e.relation === "belongs_to" &&
          e.direction === "outgoing" &&
          e.peer_type === "organization" &&
          typeof e.peer_id === "string" &&
          e.peer_id.length > 0,
      );
      return org?.peer_id ?? null;
    },

    invalidateSyncInfo(nodeId) {
      invalidate(nodeId);
    },

    async getSessionRecord(id) {
      const p = `/sessions/${encodeURIComponent(id)}`;
      const r = await request("GET", p);
      if (r.status === 404) return null;
      if (r.status !== 200) throwFor(r.status, p, r.json);
      return r.json as SessionRow;
    },

    async listSessionRecords(opts) {
      const qs = new URLSearchParams({ state: opts.states.join(",") });
      if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
      const p = `/sessions?${qs.toString()}`;
      const r = await request("GET", p);
      if (r.status !== 200) throwFor(r.status, p, r.json);
      return (r.json as { sessions: SessionRow[] }).sessions;
    },

    async createSessionRecord(input) {
      const p = "/sessions/record";
      const r = await request("POST", p, input);
      if (r.status !== 201) throwFor(r.status, p, r.json);
      return r.json as SessionRow;
    },

    async createDraftSessionRecord(input) {
      const p = "/sessions/record";
      const r = await request("POST", p, {
        draft: true,
        node_id: input.node_id,
        model: input.model ?? null,
        effort: input.effort ?? null,
        runner: input.runner ?? null,
        instance_id: input.instance_id ?? null,
      });
      if (r.status !== 201) throwFor(r.status, p, r.json);
      return r.json as SessionRow;
    },

    async patchSessionRecord(id, patch) {
      const p = `/sessions/${encodeURIComponent(id)}`;
      const r = await request("PATCH", p, patch);
      if (r.status !== 200) throwFor(r.status, p, r.json);
      return r.json as SessionRow;
    },

    async createSessionRun(input) {
      const p = `/sessions/${encodeURIComponent(input.session_id)}/runs`;
      const r = await request("POST", p, {
        runner: input.runner,
        instance_id: input.instance_id,
        host_id: input.host_id,
        agent_session_id: input.agent_session_id ?? null,
        resumed_from_run_id: input.resumed_from_run_id ?? null,
      });
      if (r.status !== 201) throwFor(r.status, p, r.json);
      return (r.json as { run: SessionRunRow }).run;
    },

    async patchSessionRun(sessionId, runId, patch) {
      const p = `/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}`;
      const r = await request("PATCH", p, patch);
      if (r.status !== 200) throwFor(r.status, p, r.json);
      return (r.json as { run: SessionRunRow }).run;
    },

    async listSessionRuns(sessionId) {
      const p = `/sessions/${encodeURIComponent(sessionId)}/runs`;
      const r = await request("GET", p);
      if (r.status !== 200) throwFor(r.status, p, r.json);
      return (r.json as { runs: SessionRunRow[] }).runs;
    },

    async sessionScopeRecord(sessionId) {
      const p = `/sessions/${encodeURIComponent(sessionId)}/scope`;
      const r = await request("GET", p);
      if (r.status !== 200) throwFor(r.status, p, r.json);
      return r.json as SessionScopeRecord;
    },

    async listLegacySessionContent(hostId) {
      const p = `/sessions/legacy-content?host_id=${encodeURIComponent(hostId)}`;
      const r = await request("GET", p);
      if (r.status !== 200) throwFor(r.status, p, r.json);
      return (r.json as { sessions: string[] }).sessions;
    },

    async getLegacySessionContent(sessionId, opts) {
      const qs = opts?.after !== undefined ? `?after=${opts.after}` : "";
      const p = `/sessions/${encodeURIComponent(sessionId)}/legacy-content${qs}`;
      const r = await request("GET", p);
      if (r.status !== 200) throwFor(r.status, p, r.json);
      return r.json as LegacySessionContentPage;
    },

    async orientation(nodeId) {
      const p = `/nodes/${encodeURIComponent(nodeId)}/orientation`;
      const r = await request("GET", p);
      if (r.status === 404) return null;
      if (r.status !== 200) throwFor(r.status, p, r.json);
      return (r.json as { orientation: OrientationSummary | null }).orientation;
    },
  };
}

// Boot-time factory: the desktop host passes the central URL + device token
// via env when spawning the sidecar in agent mode. Returns null when the
// sidecar is NOT in agent mode (normal local sidecar / standalone server).
export function createCentralClientFromEnv(): CentralClient | null {
  if (process.env.PORTUNI_AGENT_MODE !== "1") return null;
  const baseUrl = process.env.PORTUNI_CENTRAL_URL?.trim();
  const token = process.env.PORTUNI_CENTRAL_TOKEN?.trim();
  if (!baseUrl || !token) {
    throw new Error(
      "PORTUNI_AGENT_MODE=1 requires PORTUNI_CENTRAL_URL and PORTUNI_CENTRAL_TOKEN",
    );
  }
  return createHttpCentralClient({ baseUrl, token });
}
