// The one ceiling on the size of a file Portuni moves to a remote (#662).
// It applies on every path that pushes bytes: the central server's
// PUT /nodes/:id/file (streamed or JSON), storeFile on a server with a
// graph db, and the sync agent before it reads a file to send it. A file
// over the limit is refused with FILE_TOO_LARGE and its size, and the status
// scan marks it with the same error so the Unsynced dialog and
// portuni_status show why it stays unsynced.
//
// PORTUNI_MAX_FILE_BYTES (docs/env-vars.md), default 1 GiB.

import { stat } from "node:fs/promises";
import type { SyncPendingFileError } from "../../shared/api-types.js";

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024 * 1024;
// The ceiling of the setting: the sync agent and storeFile read a file whole
// (fs.readFile), which Node refuses past 2 GiB.
const MAX_FILE_BYTES_CEILING = 2 * 1024 * 1024 * 1024 - 1;

function clampLimit(n: number): number {
  return Math.min(Math.floor(n), MAX_FILE_BYTES_CEILING);
}

export function maxFileBytes(): number {
  const raw = process.env.PORTUNI_MAX_FILE_BYTES;
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? clampLimit(n) : DEFAULT_MAX_FILE_BYTES;
}

// The central server's limit as it last reported it: `max_file_bytes` on
// every sync-info answer, or the `limit` of a FILE_TOO_LARGE refusal. A sync
// agent applies it instead of its own env value, so the limit is one value
// set on the central server; the device's own value (or the default) only
// covers a central too old to report one. In-process: a restart forgets it
// until the next sync-info answer.
let remoteLimit: number | null = null;

export function noteRemoteFileLimit(limit: unknown): void {
  const n = typeof limit === "number" ? limit : Number(limit);
  if (Number.isFinite(n) && n > 0) remoteLimit = clampLimit(n);
}

export function effectiveMaxFileBytes(): number {
  return remoteLimit ?? maxFileBytes();
}

export function resetRemoteFileLimitForTests(): void {
  remoteLimit = null;
}

export interface FileTooLargeInfo {
  code: "FILE_TOO_LARGE";
  params: { size: number; limit: number };
}

export class FileTooLargeError extends Error {
  readonly params: { size: number; limit: number };
  constructor(size: number, limit: number, what = "file") {
    super(`${what} is ${size} bytes, over the ${limit}-byte limit (PORTUNI_MAX_FILE_BYTES)`);
    this.name = "FileTooLargeError";
    this.params = { size, limit };
  }
}

function tooLargeInfo(size: number, limit = effectiveMaxFileBytes()): FileTooLargeInfo | null {
  return size > limit ? { code: "FILE_TOO_LARGE", params: { size, limit } } : null;
}

export function assertFileSize(size: number, limit = effectiveMaxFileBytes(), what?: string): void {
  if (size > limit) throw new FileTooLargeError(size, limit, what);
}

// Status-scan annotation: stats each entry's local file and sets `error`
// on those over the limit. A file that cannot be stat'ed is left as it is
// (the scan's own classification already covers a missing file).
export async function markTooLarge<T extends { local_path: string | null; error?: FileTooLargeInfo }>(
  entries: T[],
): Promise<void> {
  const limit = effectiveMaxFileBytes();
  await Promise.all(
    entries.map(async (e) => {
      if (!e.local_path) return;
      try {
        const s = await stat(e.local_path);
        const info = tooLargeInfo(s.size, limit);
        if (info) e.error = info;
      } catch {
        /* gone or unreadable: not this annotation's concern */
      }
    }),
  );
}

// The per-file errors of one node's scan for GET /sync/pending.
export function pendingFileErrors(scan: {
  push_candidates: Array<{ file_id: string; filename: string; error?: FileTooLargeInfo }>;
  new_local: Array<{ filename: string; error?: FileTooLargeInfo }>;
}): SyncPendingFileError[] {
  const out: SyncPendingFileError[] = [];
  for (const e of scan.push_candidates) {
    if (e.error) out.push({ file_id: e.file_id, filename: e.filename, code: e.error.code, params: { ...e.error.params } });
  }
  for (const e of scan.new_local) {
    if (e.error) out.push({ file_id: null, filename: e.filename, code: e.error.code, params: { ...e.error.params } });
  }
  return out;
}
