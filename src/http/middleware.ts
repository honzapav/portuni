// Shared HTTP plumbing: body parsing, error responses, security headers,
// auth, host/origin allowlists. Applies uniformly to /mcp and the REST
// API; a single middleware chain keeps invariants in one place.

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { ZodType } from "zod";
import { checkAuthRequiredForConfig } from "../infra/server-config.js";

const MAX_BODY_BYTES = Number(process.env.PORTUNI_MAX_BODY_BYTES ?? 5 * 1024 * 1024);

// Allowed hosts/origins are computed lazily on first use because tests
// (rest-smoke, mcp-smoke) override PORT before booting an in-process
// server, and module-level constants are frozen by the time a test's
// process.env mutations run.
let allowedHostsCache: Set<string> | null = null;
let allowedOriginsCache: Set<string> | null = null;

function getPort(): number {
  return Number(process.env.PORT ?? 4011);
}

function buildAllowedOrigins(): Set<string> {
  const port = getPort();
  const defaults = [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    "http://localhost:4010",
    "http://127.0.0.1:4010",
    // localias (Caddy) serves *.test over HTTPS by default, but also responds
    // on plain HTTP if the user disables TLS. Allow both.
    "http://portuni.test",
    "https://portuni.test",
  ];
  return new Set(
    (process.env.PORTUNI_ALLOWED_ORIGINS ?? defaults.join(","))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function buildAllowedHosts(): Set<string> {
  const port = getPort();
  return new Set(
    [
      `localhost:${port}`,
      `127.0.0.1:${port}`,
      `[::1]:${port}`,
      "api.portuni.test",
      ...(process.env.PORTUNI_ALLOWED_HOSTS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ].map((h) => h.toLowerCase()),
  );
}

function getAllowedOrigins(): Set<string> {
  if (!allowedOriginsCache) allowedOriginsCache = buildAllowedOrigins();
  return allowedOriginsCache;
}

function getAllowedHosts(): Set<string> {
  if (!allowedHostsCache) allowedHostsCache = buildAllowedHosts();
  return allowedHostsCache;
}

// Test seam: clear the cached sets so a subsequent call rebuilds from
// the current process.env. Production code never calls this.
export function resetGateCachesForTesting(): void {
  allowedHostsCache = null;
  allowedOriginsCache = null;
}

// Bearer-token auth. When PORTUNI_AUTH_TOKEN is set, every route except
// /health (and CORS preflight) must present a matching Authorization
// header — protects against malicious local processes that can reach
// loopback ports on the same machine. Empty / unset token means auth is
// disabled (single-user, single-process loopback dev mode).
const AUTH_TOKEN = (process.env.PORTUNI_AUTH_TOKEN ?? "").trim();
export const AUTH_ENABLED = AUTH_TOKEN.length > 0;
const AUTH_PUBLIC_PATHS = new Set(["/health"]);

function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function assertAuthRequiredIfNotLoopback(host: string): void {
  const result = checkAuthRequiredForConfig({
    authEnabled: AUTH_ENABLED,
    host,
    tursoUrl: process.env.TURSO_URL ?? "",
  });
  if (!result.ok) throw new Error(result.message);
}

export class RequestBodyTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`Request body exceeds ${limit} bytes`);
    this.name = "RequestBodyTooLargeError";
  }
}

// One-line JSON response. Sets Content-Type, writes the status, ends
// the response. No-op if headers were already sent (so we don't double-send
// after an early respondError or middleware bail-out).
export function respondJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// Read JSON body and validate against a Zod schema. On parse, body-size
// or schema errors writes the appropriate 4xx response and returns null;
// the caller bails early without touching `res`. On success returns the
// typed parsed value. Replaces the open-coded "parseBody → cast → manual
// if-checks" pattern that was repeated across REST endpoints.
export async function parseJsonBody<T>(
  req: IncomingMessage,
  res: ServerResponse,
  schema: ZodType<T>,
): Promise<T | null> {
  let raw: unknown;
  try {
    raw = await parseBody(req);
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
      return null;
    }
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON body" }));
    return null;
  }
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((i) => {
        const path = i.path.length > 0 ? `${i.path.join(".")}: ` : "";
        return `${path}${i.message}`;
      })
      .join("; ");
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
    return null;
  }
  return parsed.data;
}

export function parseBody(
  req: IncomingMessage,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new RequestBodyTooLargeError(maxBytes));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const data = Buffer.concat(chunks).toString("utf8");
        resolve(data ? JSON.parse(data) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// Centralised error responder. Logs the full error server-side with a short
// request id; sends a generic message + that id to the client. ZodError
// messages are surfaced as 400 because they describe input shape, not
// internals. SQLITE_CONSTRAINT errors carry trigger/CHECK messages that are
// load-bearing for the UI (e.g. "cannot remove the only belongs_to..."),
// so they get a 409 with the friendly text. Anything else is a 500 with a
// generic body so we don't leak DB errors, file paths, or stack traces.
export function respondError(res: ServerResponse, ctx: string, err: unknown): void {
  const id = randomUUID().slice(0, 8);
  const detail =
    err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
  console.error(`[req:${id}] ${ctx} -> ${detail}`);
  if (res.headersSent) return;
  if (err instanceof RequestBodyTooLargeError) {
    res.writeHead(413, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message, request_id: id }));
    return;
  }
  if (err instanceof Error && err.name === "ZodError") {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message, request_id: id }));
    return;
  }
  if (err instanceof Error && err.message.includes("SQLITE_CONSTRAINT")) {
    const m = err.message.match(/SQLite error:\s*([^\n]+)/);
    const friendly = m ? m[1].trim() : "constraint violation";
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: friendly, request_id: id }));
    return;
  }
  res.writeHead(500, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Internal server error", request_id: id }));
}

// Apply the global gates: host allowlist, origin allowlist, CORS headers,
// preflight, bearer auth. Returns true when the request was already
// answered (preflight, blocked by gate, or unauthorized) and the caller
// should stop processing.
export function applyGates(req: IncomingMessage, res: ServerResponse): boolean {
  const hostHeader = (req.headers.host ?? "").toLowerCase();
  const url = new URL(req.url ?? "/", `http://${hostHeader || "localhost"}`);
  const origin = (req.headers.origin as string | undefined) ?? null;

  if (!getAllowedHosts().has(hostHeader)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Host header not allowed" }));
    return true;
  }

  if (origin !== null && !getAllowedOrigins().has(origin)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Origin not allowed" }));
    return true;
  }

  if (origin !== null) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  if (AUTH_ENABLED && !AUTH_PUBLIC_PATHS.has(url.pathname)) {
    const header = (req.headers.authorization as string | undefined) ?? "";
    const presented = header.startsWith("Bearer ")
      ? header.slice("Bearer ".length).trim()
      : "";
    if (presented === "" || !timingSafeStringEqual(presented, AUTH_TOKEN)) {
      res.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Bearer realm="portuni"',
      });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return true;
    }
  }

  return false;
}
