// Calling a Tauri command of the desktop shell. A command that fails rejects
// with `{ code, params, message }` (apps/desktop, #540): `code` is a display
// code (errors:DESKTOP_*, a web code such as UNKNOWN_DETAIL, or a server code
// it passes through), `params` its placeholders, `message` English log text
// that is never shown. `invoke` turns that object into a DesktopError, so
// displayError()/errorText render the code and `err.message` still reads in
// the console. The `backend-error` event carries the same object;
// toDesktopError() converts its payload too.
//
// toDesktopError is pure (tested from the server's node:test runner in
// test/tauri-invoke.test.ts); `invoke` loads @tauri-apps/api/core lazily so
// the module stays out of the main chunk.

import type { ErrorParams } from "../../../server/shared/error-codes";

export class DesktopError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly params: ErrorParams = {},
  ) {
    super(message);
    this.name = "DesktopError";
  }
}

function readParams(value: unknown): ErrorParams {
  const out: ErrorParams = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string" || typeof v === "number") out[k] = v;
  }
  return out;
}

// The error a command's rejection (or a `backend-error` payload) stands for:
// a DesktopError for a `{ code, ... }` object; anything else (an Error, a
// legacy string from an older shell) unchanged, which errorText renders as
// UNKNOWN_DETAIL with its raw text.
export function toDesktopError(raw: unknown): unknown {
  if (raw instanceof Error) return raw;
  if (raw && typeof raw === "object" && typeof (raw as { code?: unknown }).code === "string") {
    const obj = raw as { code: string; params?: unknown; message?: unknown };
    const message = typeof obj.message === "string" && obj.message ? obj.message : obj.code;
    return new DesktopError(obj.code, message, readParams(obj.params));
  }
  return raw;
}

// One module promise for every call, so calls issued in order reach Rust in
// order (sessions-client's send then cancel) even while the module loads.
let core: Promise<typeof import("@tauri-apps/api/core")> | null = null;

export async function invoke<T = void>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  core ??= import("@tauri-apps/api/core");
  const { invoke: tauriInvoke } = await core;
  try {
    return await tauriInvoke<T>(cmd, args);
  } catch (err) {
    throw toDesktopError(err);
  }
}
