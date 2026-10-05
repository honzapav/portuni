// On-device trail of recent UI steps (#573): which view the user was on,
// which API calls ran and how they ended, which errors surfaced. A ring
// buffer in memory only; nothing leaves the device unless the user copies
// it out (Settings -> Copy diagnostics). When something fails -- an error,
// a 5xx, a network failure -- the entries added since the last flush go to
// the flusher: the desktop writes them to sidecar.log (target `ui`), the
// browser build to console.error.
//
// Privacy by construction: an entry has only the fields typed below. An
// API entry carries the path without its query string and the error code,
// never a request or response body; a view entry carries the URL state the
// app writes (view, node id, settings tab), never a title.
//
// React-free and import-free so the server's node:test runner can test it.

export const TRAIL_CAPACITY = 300;

export type TrailEntry =
  | { kind: "view"; at: string; url: string }
  | {
      kind: "api";
      at: string;
      method: string;
      path: string;
      // null when the request never got an answer (network failure).
      status: number | null;
      duration_ms: number;
      request_id: string;
      code: string | null;
    }
  | { kind: "error"; at: string; label: string; name: string; message: string; frame: string | null };

export type TrailInput =
  | { kind: "view"; url: string }
  | {
      kind: "api";
      method: string;
      path: string;
      status: number | null;
      duration_ms: number;
      request_id: string;
      code?: string | null;
    }
  | { kind: "error"; label: string; error: unknown };

export type TrailFlusher = (lines: string[]) => void;

export interface UiTrail {
  record(input: TrailInput): void;
  entries(): TrailEntry[];
  // Every entry as one line each, oldest first.
  lines(): string[];
}

// The path of an API call without query string or fragment: a query can
// carry search text or file names.
export function stripQuery(path: string): string {
  const cut = path.search(/[?#]/);
  return cut === -1 ? path : path.slice(0, cut);
}

// The first stack frame of an error (the line after the "Name: message"
// header in V8, the first line in WebKit), or null.
function firstFrame(stack: string | undefined): string | null {
  if (!stack) return null;
  for (const raw of stack.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("at ")) return line;
    if (line.includes("@")) return line;
  }
  return null;
}

function toEntry(input: TrailInput, at: string): TrailEntry {
  switch (input.kind) {
    case "view":
      return { kind: "view", at, url: input.url };
    case "api":
      return {
        kind: "api",
        at,
        method: input.method.toUpperCase(),
        path: stripQuery(input.path),
        status: input.status,
        duration_ms: Math.round(input.duration_ms),
        request_id: input.request_id,
        code: input.code ?? null,
      };
    case "error": {
      const err = input.error;
      if (err instanceof Error) {
        return {
          kind: "error",
          at,
          label: input.label,
          name: err.name,
          message: err.message,
          frame: firstFrame(err.stack),
        };
      }
      return { kind: "error", at, label: input.label, name: "NonError", message: String(err), frame: null };
    }
  }
}

// Whether an entry is a failure worth writing to disk right away.
function isFailure(entry: TrailEntry): boolean {
  if (entry.kind === "error") return true;
  if (entry.kind === "api") return entry.status === null || entry.status >= 500;
  return false;
}

function formatEntry(entry: TrailEntry): string {
  switch (entry.kind) {
    case "view":
      return `${entry.at} view ${entry.url}`;
    case "api": {
      const status = entry.status === null ? "network-error" : String(entry.status);
      const code = entry.code ? ` code=${entry.code}` : "";
      return `${entry.at} api ${entry.method} ${entry.path} -> ${status} ${entry.duration_ms}ms id=${entry.request_id}${code}`;
    }
    case "error": {
      const frame = entry.frame ? ` @ ${entry.frame}` : "";
      return `${entry.at} error [${entry.label}] ${entry.name}: ${entry.message}${frame}`.replace(/\s*\n\s*/g, " ");
    }
  }
}

export function createUiTrail(opts: {
  capacity?: number;
  now?: () => Date;
  flush?: TrailFlusher;
} = {}): UiTrail {
  const capacity = opts.capacity ?? TRAIL_CAPACITY;
  const now = opts.now ?? (() => new Date());
  const buffer: TrailEntry[] = [];
  // Entries recorded since the last flush, capped like the buffer itself.
  let unflushed: TrailEntry[] = [];

  return {
    record(input) {
      const entry = toEntry(input, now().toISOString());
      buffer.push(entry);
      if (buffer.length > capacity) buffer.splice(0, buffer.length - capacity);
      unflushed.push(entry);
      if (unflushed.length > capacity) unflushed.splice(0, unflushed.length - capacity);
      if (isFailure(entry) && opts.flush) {
        const batch = unflushed;
        unflushed = [];
        try {
          opts.flush(batch.map(formatEntry));
        } catch {
          // The flusher is best effort; a failing one must never recurse
          // into another error entry.
        }
      }
    },
    entries() {
      return buffer.slice();
    },
    lines() {
      return buffer.map(formatEntry);
    },
  };
}

// A ULID (Crockford base32: 48-bit ms timestamp + 80 random bits), the
// request id apiFetch sends as X-Portuni-Request-Id.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newRequestId(nowMs: number = Date.now()): string {
  let time = "";
  let t = nowMs;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let rand = "";
  for (const b of bytes) rand += CROCKFORD[b % 32];
  return time + rand;
}

// The app's one trail. The flusher is installed at boot (main.tsx), so the
// module stays free of Tauri imports.
let flusher: TrailFlusher | undefined;
export const uiTrail: UiTrail = createUiTrail({
  flush: (lines) => flusher?.(lines),
});

export function setTrailFlusher(fn: TrailFlusher): void {
  flusher = fn;
}

// The plain text Settings -> Copy diagnostics puts on the clipboard: a
// short header the person reading a report needs to place the trail, then
// the trail itself. Field names are fixed log tokens, not UI text.
export function formatDiagnostics(args: {
  appVersion: string;
  workspaceKind: "personal" | "team" | "unknown";
  workspaceId: string | null;
  generatedAt: Date;
  lines: string[];
}): string {
  return [
    "Portuni diagnostics",
    `generated_at: ${args.generatedAt.toISOString()}`,
    `app_version: ${args.appVersion}`,
    `workspace_kind: ${args.workspaceKind}`,
    `workspace_id: ${args.workspaceId ?? "-"}`,
    `trail_entries: ${args.lines.length}`,
    "",
    ...args.lines,
    "",
  ].join("\n");
}
