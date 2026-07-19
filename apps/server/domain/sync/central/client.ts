// HTTP client for the central Portuni server, used by the sidecar when it
// runs as a central-mode sync agent (teammate mirrors). This is the ONLY
// place agent-side sync code talks to the network: everything else works
// against the local disk and the per-device sync.db.
//
// Auth: a per-user device token (Bearer). The agent never holds a Turso
// token or Drive credentials -- the central server enforces node visibility
// and global scopes on every call, so a compromised device can reach exactly
// what its user could reach anyway.

import type { DataSourceRow } from "../../../shared/types.js";
import type { NodeSyncInfo, RegisterFileRecordResult } from "../sync-remote-api.js";

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
  dataSources(nodeId: string): Promise<DataSourceRow[]>;
  nodeExists(nodeId: string): Promise<boolean>;
  // Depth-1 neighbour ids from central node-detail. Used to compute the
  // seatbelt read grant in central mode (the local graph replica is empty).
  // Restricted/blanked peers (peer_id === "") are dropped.
  nodeNeighbours(nodeId: string): Promise<string[]>;
  // Drop any cached sync-info for the node (called automatically after
  // mutations through this client; exposed for external invalidation).
  invalidateSyncInfo(nodeId: string): void;
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

    async nodeNeighbours(nodeId) {
      const p = `/nodes/${encodeURIComponent(nodeId)}`;
      const r = await request("GET", p);
      if (r.status !== 200) throwFor(r.status, p, r.json);
      const edges = (r.json as { edges?: Array<{ peer_id?: string }> }).edges ?? [];
      return [
        ...new Set(
          edges
            .map((e) => e.peer_id)
            .filter((id): id is string => typeof id === "string" && id.length > 0),
        ),
      ];
    },

    invalidateSyncInfo(nodeId) {
      invalidate(nodeId);
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
