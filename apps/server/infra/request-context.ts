// The request id of the HTTP request being served (#573). The webview mints
// one per call (apiFetch), the Rust proxy forwards it, http/server.ts takes it
// (or mints one for a caller that sent none: MCP clients, the CLI) and runs the
// handler inside this context, so every log line and every call the sync agent
// makes to the central server on that request's behalf carries the same id.
// Work not tied to an incoming request (a watcher tick, a sweep) has none and
// mints its own per call.

import { AsyncLocalStorage } from "node:async_hooks";
import { ulid } from "ulid";

export const REQUEST_ID_HEADER = "X-Portuni-Request-Id";

const storage = new AsyncLocalStorage<{ requestId: string }>();

// An incoming id is only trusted as a log token: short, no spaces or control
// characters, so a caller cannot forge log lines through it.
const VALID_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function newRequestId(): string {
  return ulid();
}

// The incoming header's id when it is well-formed, else a fresh one.
export function requestIdFromHeader(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw !== undefined && VALID_REQUEST_ID.test(raw) ? raw : newRequestId();
}

export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn);
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
