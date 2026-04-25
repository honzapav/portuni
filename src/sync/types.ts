export type RemoteType = "gdrive" | "dropbox" | "s3" | "fs" | "webdav" | "sftp";
export type NativeFormat = "gdoc" | "gsheet" | "gslide" | "notion_page";

export interface FileRef {
  path: string;
  hash: string | null;
  size: number;
  modified_at: Date;
  is_native_format: boolean;
  native_format?: NativeFormat;
}

export interface FileAdapter {
  put(path: string, content: Buffer, opts?: { mimeType?: string }): Promise<FileRef>;
  get(path: string): Promise<Buffer>;
  stat(path: string): Promise<FileRef | null>;
  list(prefix: string): Promise<FileRef[]>;
  delete(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  url(path: string): Promise<string>;
  export?(pathOrId: string, format: "pdf" | "markdown" | "docx"): Promise<Buffer>;
  // Idempotently create a directory (and its ancestors) on the backend.
  // Optional because not every backend has a meaningful concept of empty
  // directories; callers should treat absence as best-effort no-op.
  ensureFolder?(path: string): Promise<void>;
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
