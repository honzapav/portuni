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

// Open an external URL in the OS default handler. A plain <a target="_blank">
// (or window.open) works in a browser, but inside the Tauri webview such a
// click is a silent no-op. The previous attempt routed through the JS
// `tauri-plugin-shell` `open` (`plugin:shell|open`), but that stayed a no-op
// in the macOS webview and -- worse -- swallowed its own error, leaving no
// trail to debug. We now invoke a native `open_external` command instead,
// which is reliable and logs every attempt to sidecar.log. The invoke is
// also our Tauri-detection: if it throws because there is no IPC bridge
// (real browser build), we fall back to window.open. Errors are surfaced to
// the console rather than silently dropped.
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_external", { url });
      return;
    } catch (e) {
      // Real failure (not "we're in a browser") -- surface it, then fall
      // through to window.open as a last resort.
      console.error("[openExternal] native open_external failed:", e);
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

// Open a local file in the OS default app (for .html: the default browser).
// Scope-guarded in Rust to the workspace root. No-op in browser mode.
export async function openPathExternal(path: string): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_path_external", { path });
}

// Open a local path in Finder. When reveal=true uses `open -R` so Finder
// selects the file in its parent folder; when false opens the folder itself.
// No-op in browser mode (not running in Tauri).
export async function openInFinder(path: string, reveal: boolean): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_in_finder", { path, reveal });
}

// Returns the POSIX path of the file currently in the macOS clipboard
// (copied from Finder), or null if the clipboard does not hold a file or
// the command is not running in Tauri / on macOS.
export async function clipboardFilePath(): Promise<string | null> {
  if (!isTauri()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("clipboard_file_path");
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
  // Null-body statuses: new Response("", { status: 204 }) throws TypeError.
  const nullBody = res.status === 204 || res.status === 205 || res.status === 304;
  return new Response(nullBody ? null : res.body, { status: res.status });
}
