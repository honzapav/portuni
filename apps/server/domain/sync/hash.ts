import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";

export async function sha256File(path: string): Promise<string> {
  return streamHash(path, "sha256");
}

export async function md5File(path: string): Promise<string> {
  return streamHash(path, "md5");
}

export function sha256Buffer(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

export function md5Buffer(b: Buffer): string {
  return createHash("md5").update(b).digest("hex");
}

export interface StatForCache {
  mtime: number;
  size: number;
  // Inode identity: rename(2) preserves it on the same volume, so the
  // watcher pairs an on-disk mv with the tracked record it left behind.
  ino: number;
  dev: number;
}

export async function statForCache(path: string): Promise<StatForCache> {
  const s = await fs.stat(path);
  return { mtime: s.mtimeMs, size: s.size, ino: s.ino, dev: s.dev };
}

function streamHash(path: string, algo: "sha256" | "md5"): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash(algo);
    const stream = createReadStream(path);
    stream.on("data", (c) => h.update(c));
    stream.on("end", () => resolve(h.digest("hex")));
    stream.on("error", reject);
  });
}
