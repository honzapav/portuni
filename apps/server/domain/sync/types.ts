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
  mode?: "oauth" | "service_account" | "refresh_token";
  client_id?: string;
  client_secret?: string;
  account_email?: string;
}

export type DeviceTokens = Record<string, DeviceToken>;

export class CapabilityError extends Error {
  constructor(public readonly backend: string, public readonly operation: string) {
    super(`Backend ${backend} does not support operation: ${operation}`);
    this.name = "CapabilityError";
  }
}
