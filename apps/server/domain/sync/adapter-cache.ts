import type { Client } from "@libsql/client";
import type { FileAdapter } from "./types.js";
import { getRemote } from "./routing.js";
import { createOpenDALAdapter } from "./opendal-adapter.js";
import { createDriveAdapter } from "./drive-adapter.js";
import { readDeviceTokens } from "./device-tokens.js";

const cache = new Map<string, FileAdapter>();

export async function getAdapter(db: Client, remoteName: string): Promise<FileAdapter> {
  const hit = cache.get(remoteName);
  if (hit) return hit;
  const remote = await getRemote(db, remoteName);
  if (!remote) throw new Error(`Unknown remote: ${remoteName}`);
  const tokens = await readDeviceTokens([remoteName]);
  const adapter = remote.type === "gdrive"
    ? createDriveAdapter(remote, tokens)
    : createOpenDALAdapter(remote, tokens);
  cache.set(remoteName, adapter);
  return adapter;
}

export function invalidateAdapter(name: string): void {
  cache.delete(name);
}

export function resetAdapterCacheForTests(): void {
  cache.clear();
}

// Test-only seam: pre-populate the cache with a caller-supplied adapter
// (getAdapter checks the cache before ever calling getRemote/constructing a
// real backend, so this lets tests substitute a fake FileAdapter -- e.g. one
// that reports Drive-native-format behaviour -- without a real Drive
// account or a real fs-backed remote).
export function setAdapterForTests(name: string, adapter: FileAdapter): void {
  cache.set(name, adapter);
}
