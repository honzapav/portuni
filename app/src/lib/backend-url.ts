// Resolves how API calls reach the backend.
//
// In Tauri (desktop) mode the Rust host owns both the per-launch auth
// token and the loopback port. The webview no longer constructs HTTP
// requests itself: `apiFetch` forwards every call to the `api_request`
// Tauri command, which runs in the same trust domain as the sidecar
// and is the only place the bearer header is attached. There is no
// `Authorization` header in webview JS, ever.
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

let backendReady = false;
let pendingReady: Promise<void> | null = null;

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// Wait until the sidecar has announced its port via `get_backend_port`
// or the `backend-ready` event. Mirrors the previous polling logic but
// resolves to void — callers don't construct URLs anymore, the Rust
// side does.
async function pollBackendReady(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");

  let unlistenReady: (() => void) | null = null;
  let unlistenError: (() => void) | null = null;

  const eventPromise = new Promise<void>((resolve) => {
    void listen<number>("backend-ready", () => {
      resolve();
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

  const pollPromise = (async (): Promise<void> => {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const port = await invoke<number | null>("get_backend_port");
      if (port !== null) return;
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error("backend sidecar did not start within 30s");
  })();

  try {
    await Promise.race([pollPromise, eventPromise, errorPromise]);
  } finally {
    if (unlistenReady) (unlistenReady as () => void)();
    if (unlistenError) (unlistenError as () => void)();
  }
}

function ensureBackendReady(): Promise<void> {
  if (backendReady) return Promise.resolve();
  if (!isTauri()) {
    backendReady = true;
    return Promise.resolve();
  }
  if (!pendingReady) {
    pendingReady = pollBackendReady().then(() => {
      backendReady = true;
    });
  }
  return pendingReady;
}

type ApiResponse = { status: number; body: string };

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  await ensureBackendReady();

  if (!isTauri()) {
    return fetch(`${BROWSER_BASE}${path}`, init);
  }

  const { invoke } = await import("@tauri-apps/api/core");
  const method = (init?.method ?? "GET").toUpperCase();

  // api.ts's jsonRequest pre-stringifies bodies; that's the only shape
  // the proxy supports. Reject anything else loudly so a future caller
  // doesn't silently lose its payload.
  let body: string | null = null;
  if (typeof init?.body === "string") {
    body = init.body;
  } else if (init?.body != null) {
    throw new Error("apiFetch (Tauri mode) requires string body");
  }

  const headers: Record<string, string> = {};
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
  }

  const res = await invoke<ApiResponse>("api_request", {
    method,
    path,
    body,
    headers: Object.keys(headers).length > 0 ? headers : null,
  });
  return new Response(res.body, { status: res.status });
}
