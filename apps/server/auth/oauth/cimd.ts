// Client ID Metadata Documents (CIMD) -- the "no DCR" client identification
// path. A client is identified by the URL of its own metadata document; the
// document must self-reference that same URL as its client_id. Fetched over
// HTTPS only, with a timeout and a size cap, and cached briefly since
// /oauth/authorize is hit on every connect attempt.
// Spec: docs/superpowers/specs/2026-08-31-oauth-connectors-design.md
// ("Decisions", "Authorization flow" step 1).

const FETCH_TIMEOUT_MS = 5_000;
const MAX_DOCUMENT_BYTES = 64 * 1024;
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface ClientMetadataDocument {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
}

let cimdFetch: typeof fetch = globalThis.fetch.bind(globalThis);

// Test seam: swap in a fake fetch instead of hitting the network.
// Production code never calls this.
export function __setCimdFetchForTests(f: typeof fetch): void {
  cimdFetch = f;
}

const cache = new Map<string, { at: number; doc: ClientMetadataDocument }>();

// Test seam: clear the in-memory CIMD cache between tests.
export function __clearCimdCacheForTests(): void {
  cache.clear();
}

export type CimdResult =
  | { ok: true; doc: ClientMetadataDocument }
  | { ok: false; reason: string };

export async function fetchClientMetadata(clientId: string): Promise<CimdResult> {
  const cached = cache.get(clientId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { ok: true, doc: cached.doc };
  }

  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return { ok: false, reason: "client_id is not a valid URL" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: "client_id must be an https URL" };
  }

  let res: Response;
  try {
    res = await cimdFetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
  } catch {
    return { ok: false, reason: "failed to fetch the client metadata document" };
  }
  if (!res.ok) {
    return { ok: false, reason: `client metadata document fetch failed (${res.status})` };
  }

  const lengthHeader = res.headers.get("content-length");
  if (lengthHeader && Number(lengthHeader) > MAX_DOCUMENT_BYTES) {
    return { ok: false, reason: "client metadata document is too large" };
  }
  const text = await res.text();
  if (text.length > MAX_DOCUMENT_BYTES) {
    return { ok: false, reason: "client metadata document is too large" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "client metadata document is not valid JSON" };
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).client_id !== "string" ||
    !Array.isArray((parsed as Record<string, unknown>).redirect_uris)
  ) {
    return { ok: false, reason: "client metadata document is missing required fields" };
  }
  const doc = parsed as Record<string, unknown>;
  if (doc.client_id !== clientId) {
    return { ok: false, reason: "client_id does not self-reference the document URL" };
  }
  const redirectUris = (doc.redirect_uris as unknown[]).filter(
    (u): u is string => typeof u === "string",
  );

  const metadata: ClientMetadataDocument = {
    client_id: clientId,
    client_name: typeof doc.client_name === "string" ? doc.client_name : undefined,
    redirect_uris: redirectUris,
  };
  cache.set(clientId, { at: Date.now(), doc: metadata });
  return { ok: true, doc: metadata };
}

// Loopback exemption (RFC 8252 SS7.3): a native app can't predict the
// OS-assigned ephemeral port ahead of time, so the port is ignored for
// http://localhost/... and http://127.0.0.1/... redirect URIs. Every other
// URI (including any other non-HTTPS scheme) must match exactly.
export function redirectUriAllowed(registered: string[], requested: string): boolean {
  let requestedUrl: URL;
  try {
    requestedUrl = new URL(requested);
  } catch {
    return false;
  }
  const isLoopback =
    requestedUrl.protocol === "http:" &&
    (requestedUrl.hostname === "localhost" || requestedUrl.hostname === "127.0.0.1");

  for (const candidate of registered) {
    if (candidate === requested) return true;
    if (!isLoopback) continue;

    let candidateUrl: URL;
    try {
      candidateUrl = new URL(candidate);
    } catch {
      continue;
    }
    if (
      candidateUrl.protocol === "http:" &&
      candidateUrl.hostname === requestedUrl.hostname &&
      candidateUrl.pathname === requestedUrl.pathname &&
      candidateUrl.search === requestedUrl.search
    ) {
      return true;
    }
  }
  return false;
}
