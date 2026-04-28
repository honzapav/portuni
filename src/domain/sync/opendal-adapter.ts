import { Operator } from "opendal";
import { createHash } from "node:crypto";
import type { FileAdapter, FileRef, RemoteConfig, DeviceTokens } from "./types.js";
import { CapabilityError } from "./types.js";

function asString(v: unknown, name: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return v;
}

function buildOperator(remote: AdapterRemote, _tokens: DeviceTokens): Operator {
  const type: string = remote.type;
  switch (type) {
    case "fs": {
      const root = asString(remote.config.root, "fs.root");
      return new Operator("fs", { root });
    }
    case "memory": {
      // OpenDAL's memory backend takes no required options. `memory` is not
      // part of the production RemoteType, but is accepted here for tests
      // and ephemeral in-process use.
      return new Operator("memory");
    }
    default:
      throw new Error(
        `opendal-adapter: remote type '${type}' not handled here. Drive uses a custom adapter. Add OpenDAL-backed support for '${type}' when needed.`,
      );
  }
}

function sha256Buffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function metadataToFileRef(path: string, meta: { contentLength: bigint | null; lastModified: string | null }): FileRef {
  const size = meta.contentLength === null ? 0 : Number(meta.contentLength);
  const modified = meta.lastModified ? new Date(meta.lastModified) : new Date(0);
  return {
    path,
    hash: null, // stat does not return a content-addressable hash; computed on put.
    size,
    modified_at: modified,
    is_native_format: false,
  };
}

// `RemoteConfig` is widened here to also accept a `memory` type so the
// OpenDAL adapter can be exercised in tests without touching the real
// types.ts surface (`memory` is not a production remote type).
export type AdapterRemote =
  | RemoteConfig
  | { name: string; type: "memory"; config: Record<string, unknown> };

export function createOpenDALAdapter(
  remote: AdapterRemote,
  tokens: DeviceTokens,
): FileAdapter {
  const op = buildOperator(remote, tokens);

  async function statToRef(path: string): Promise<FileRef | null> {
    try {
      const meta = await op.stat(path);
      return metadataToFileRef(path, meta);
    } catch {
      return null;
    }
  }

  return {
    async put(path, content, _opts) {
      await op.write(path, content);
      return {
        path,
        hash: sha256Buffer(content),
        size: content.length,
        modified_at: new Date(),
        is_native_format: false,
      };
    },
    async get(path) {
      const buf = await op.read(path);
      return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    },
    async stat(path) {
      return statToRef(path);
    },
    async list(prefix) {
      // OpenDAL requires the prefix path to end with "/" for non-recursive
      // listing. Empty prefix means root.
      const normalized =
        prefix === "" ? "" : prefix.endsWith("/") ? prefix : `${prefix}/`;
      let entries: Awaited<ReturnType<typeof op.list>>;
      try {
        entries = await op.list(normalized);
      } catch {
        return [];
      }
      const out: FileRef[] = [];
      for (const entry of entries) {
        const p = entry.path();
        // Listing returns the directory itself plus children; skip dirs.
        if (p.endsWith("/") || p === normalized) continue;
        const meta = entry.metadata();
        if (typeof meta.isFile === "function" && !meta.isFile()) continue;
        out.push(metadataToFileRef(p, meta));
      }
      return out;
    },
    async delete(path) {
      await op.delete(path);
    },
    async rename(from, to) {
      try {
        await op.rename(from, to);
        return;
      } catch {
        // Fall through to copy+delete for backends without native rename.
      }
      const buf = await op.read(from);
      await op.write(to, Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
      await op.delete(from);
    },
    async url(path) {
      if (remote.type === "fs") {
        const root = asString(remote.config.root, "fs.root");
        const sep = root.endsWith("/") ? "" : "/";
        return `file://${root}${sep}${path}`;
      }
      throw new CapabilityError(remote.type, "url");
    },
    async ensureFolder(path) {
      // OpenDAL exposes createDir for backends that have a folder concept.
      // Trailing slash is required to signal "this is a directory".
      const dirPath = path.endsWith("/") ? path : `${path}/`;
      await op.createDir(dirPath);
    },
  };
}
