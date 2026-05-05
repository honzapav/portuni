// Resolves the base URL for backend HTTP calls and (in Tauri mode) the
// per-launch auth token the sidecar requires.
//
// In Tauri (desktop) mode the Rust host spawns the Node sidecar on an
// OS-assigned loopback port and generates a random auth token per
// launch. Two channels expose the port to the frontend:
//   - `get_backend_port` Tauri command (preferred — works even if the
//     event fired before the React app could listen)
//   - `backend-ready` event (cheap fallback for the rare case the
//     command returns null because the sidecar is still booting)
//
// In a plain browser (Vite dev or static preview) we keep the existing
// `/api` prefix so Vite's dev proxy forwards it to localhost:4011 and
// no Authorization header is needed (the proxy injects one).

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

const BROWSER_BASE = "/api";
const POLL_INTERVAL_MS = 150;
const POLL_TIMEOUT_MS = 30_000;

let cachedBase: string | null = null;
let cachedToken: string | null = null;
let pendingBase: Promise<string> | null = null;
let pendingToken: Promise<string> | null = null;

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function pollBackendPort(): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");

  let unlistenReady: (() => void) | null = null;
  let unlistenError: (() => void) | null = null;

  const eventPromise = new Promise<number>((resolve) => {
    void listen<number>("backend-ready", (event) => {
      resolve(event.payload);
    }).then((fn) => {
      unlistenReady = fn;
    });
  });

  // Tauri host emits backend-error when the sidecar prints a structured
  // PORTUNI_BACKEND_ERROR= line on stdout (e.g. database unreachable) or
  // when it terminates before announcing a port. Surfacing the real
  // reason here is what turns "did not start within 30s" into something
  // the user can act on.
  const errorPromise = new Promise<never>((_, reject) => {
    void listen<string>("backend-error", (event) => {
      reject(new Error(`backend failed to start: ${event.payload}`));
    }).then((fn) => {
      unlistenError = fn;
    });
  });

  const pollPromise = (async (): Promise<number> => {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const port = await invoke<number | null>("get_backend_port");
      if (port !== null) return port;
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error("backend sidecar did not start within 30s");
  })();

  try {
    const port = await Promise.race([pollPromise, eventPromise, errorPromise]);
    return `http://127.0.0.1:${port}`;
  } finally {
    if (unlistenReady) (unlistenReady as () => void)();
    if (unlistenError) (unlistenError as () => void)();
  }
}

async function fetchAuthToken(): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("get_auth_token");
}

export function getBackendBase(): Promise<string> {
  if (cachedBase !== null) return Promise.resolve(cachedBase);
  if (!isTauri()) {
    cachedBase = BROWSER_BASE;
    return Promise.resolve(cachedBase);
  }
  if (!pendingBase) {
    pendingBase = pollBackendPort().then((url) => {
      cachedBase = url;
      return url;
    });
  }
  return pendingBase;
}

function getAuthToken(): Promise<string> {
  if (cachedToken !== null) return Promise.resolve(cachedToken);
  if (!isTauri()) return Promise.resolve("");
  if (!pendingToken) {
    pendingToken = fetchAuthToken().then((token) => {
      cachedToken = token;
      return token;
    });
  }
  return pendingToken;
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const [base, token] = await Promise.all([getBackendBase(), getAuthToken()]);
  const headers = new Headers(init?.headers ?? {});
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${base}${path}`, { ...init, headers });
}
