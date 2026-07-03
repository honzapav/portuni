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

export interface CentralClient {
  syncInfo(nodeId: string): Promise<NodeSyncInfo>;
  registerFile(nodeId: string, relPath: string): Promise<RegisterFileRecordResult>;
  getFileRaw(
    nodeId: string,
    relPath: string,
  ): Promise<{ bytes: Buffer; version: string; canonicalHash: string }>;
  putFileRaw(
    nodeId: string,
    relPath: string,
    bytes: Buffer,
    opts?: { baseVersion?: string; force?: boolean },
  ): Promise<{ version: string; canonicalHash: string }>;
  dataSources(nodeId: string): Promise<DataSourceRow[]>;
  nodeExists(nodeId: string): Promise<boolean>;
}

interface HttpClientArgs {
  baseUrl: string;
  token: string;
  // Injectable for tests; defaults to global fetch.
  fetchImpl?: typeof fetch;
}

export function createHttpCentralClient(args: HttpClientArgs): CentralClient {
  const base = args.baseUrl.replace(/\/+$/, "");
  const doFetch = args.fetchImpl ?? fetch;

  async function request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${args.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON body (unexpected); error paths below still carry status */
    }
    return { status: res.status, json };
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

  return {
    async syncInfo(nodeId) {
      const p = `/nodes/${encodeURIComponent(nodeId)}/sync-info`;
      const r = await request("GET", p);
      if (r.status !== 200) throwFor(r.status, p, r.json);
      return r.json as NodeSyncInfo;
    },

    async registerFile(nodeId, relPath) {
      const p = `/nodes/${encodeURIComponent(nodeId)}/files/register`;
      const r = await request("POST", p, { relPath });
      if (r.status !== 201) throwFor(r.status, p, r.json);
      return r.json as RegisterFileRecordResult;
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
        ...(opts?.force ? { force: true } : {}),
      });
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
