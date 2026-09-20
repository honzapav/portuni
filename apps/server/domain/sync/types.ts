import { isLocalWorkspace } from "../../infra/server-config.js";

export type RemoteType = "gdrive" | "dropbox" | "s3" | "fs" | "webdav" | "sftp";
export type NativeFormat = "gdoc" | "gsheet" | "gslide" | "notion_page";

// Env-var namespace for per-remote device tokens (varlock token store).
// Lives here so token-store implementations and the device-tokens reader
// can both import it without forming a cycle.
export const TOKEN_ENV_PREFIX = "PORTUNI_REMOTE_";

export interface FileRef {
  path: string;
  hash: string | null;
  size: number;
  modified_at: Date;
  is_native_format: boolean;
  native_format?: NativeFormat;
}

// One hit of a content search on a backend. `path` is the object's path
// relative to the remote root, in exactly the form list() reports (so it
// joins on files.remote_path). `snippet` is a backend-provided excerpt around
// the match, when the backend has one (Drive does not).
export interface SearchHit {
  path: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  snippet?: string;
}

// Search is discovery, not ingestion: hits carry a short snippet, not the
// full match, and callers cap how many hits they ask for. One place for both
// bounds -- see docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md
// ("Search is discovery, not ingestion").
export const SEARCH_SNIPPET_MAX_CHARS = 200;
export const SEARCH_HITS_DEFAULT_LIMIT = 20;
export const SEARCH_HITS_MAX_LIMIT = 50;

// One observed change on the remote, as reported by a backend's change feed
// (Drive's Changes API). The watcher (domain/sync/remote-watcher.ts) turns
// these into the same adopt / hash-refresh / delete + tombstone operations a
// full remoteSweep would apply -- see
// docs/superpowers/specs/2026-09-12-remote-watcher-design.md.
//
// `path` is relative to the remote root, in exactly the form list() reports,
// so it joins on files.remote_path. A remove carries a null path when the
// backend no longer knows where the object was (Drive reports a hard delete
// with no file metadata at all); the file id is always there.
export type RemoteChange =
  | { kind: "upsert"; path: string; hash: string | null; modified_at: Date; is_folder: boolean }
  | { kind: "remove"; path: string | null; file_id: string };

export interface RemoteChanges {
  // The cursor to hand back on the next call. Persist it only once every
  // change in this batch has been applied -- a replayed batch is idempotent,
  // a skipped one is lost.
  cursor: string;
  changes: RemoteChange[];
  // The cursor handed in was invalid or expired; nothing in `changes` is a
  // complete account of what happened. The caller must run a full sweep and
  // start again from `cursor`.
  reset: boolean;
}

export interface FileAdapter {
  put(path: string, content: Buffer, opts?: { mimeType?: string }): Promise<FileRef>;
  get(path: string): Promise<Buffer>;
  stat(path: string): Promise<FileRef | null>;
  list(prefix: string): Promise<FileRef[]>;
  delete(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  url(path: string): Promise<string>;
  // Browser-openable URL for a *folder* path (not a file). Returns null if
  // the folder doesn't exist yet on the remote (e.g. node has no synced
  // files). Optional: backends without a meaningful web URL (s3, sftp, fs)
  // should omit it.
  folderUrl?(path: string): Promise<string | null>;
  export?(pathOrId: string, format: "pdf" | "markdown" | "docx"): Promise<Buffer>;
  // Idempotently create a directory (and its ancestors) on the backend.
  // Optional because not every backend has a meaningful concept of empty
  // directories; callers should treat absence as best-effort no-op.
  ensureFolder?(path: string): Promise<void>;
  // Full-text search over file CONTENTS on the backend (Drive: `fullText
  // contains`). Optional: only backends with a content index (or cheap
  // enough to grep, like fs) implement it; callers skip the others. Returns
  // at most `opts.limit` hits whose path resolves under the remote root.
  search?(query: string, opts?: { limit?: number }): Promise<SearchHit[]>;
  // Incremental change feed. Optional: only backends with one implement it
  // (Drive), everything else is kept current by the full sweep alone (spec
  // rule 3). `cursor` null means "no cursor yet": the backend answers with a
  // fresh start cursor and no changes, and the caller baselines with a full
  // sweep.
  changes?(cursor: string | null): Promise<RemoteChanges>;
}

export interface RemoteConfig {
  name: string;
  type: RemoteType;
  config: Record<string, unknown>;
}

export interface DeviceToken {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  service_account_json?: string;
  mode?: "oauth" | "service_account";
}

export type DeviceTokens = Record<string, DeviceToken>;

export class CapabilityError extends Error {
  constructor(public readonly backend: string, public readonly operation: string) {
    super(`Backend ${backend} does not support operation: ${operation}`);
    this.name = "CapabilityError";
  }
}

// A local workspace (see infra/server-config.ts's isLocalWorkspace()) has no
// remote and cannot be given one -- collaboration runs through central mode
// instead. Thrown by every remote-registration/routing write; central and
// agent-mode servers never see this.
export class LocalModeNoRemoteError extends Error {
  readonly code = "LOCAL_MODE_NO_REMOTE" as const;
  constructor() {
    super("Lokální workspace nemá remote; sdílení souborů běží přes centrální server.");
    this.name = "LocalModeNoRemoteError";
  }
}

// The one guard every remote-touching entry point runs first. Kept here,
// next to the error it throws, so a new entry point has one line to add.
export function assertRemoteCapable(): void {
  if (isLocalWorkspace()) throw new LocalModeNoRemoteError();
}
