import { Operator } from "opendal";
import { createHash } from "node:crypto";
import type { FileAdapter, FileRef, RemoteConfig, DeviceTokens, SearchHit } from "./types.js";
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

// OpenDAL's napi binding (0.49.x) flattens every backend error into a plain
// Error with `code: "GenericFailure"` -- the only thing that carries the
// ErrorKind is the message, which always starts with the kind:
//   "NotFound (permanent) at stat, context: { ... } => entity not found"
//   "PermissionDenied (permanent) at stat, context: { ... }"
//   "Unexpected (temporary) at stat, context: { ... }"
// So the kind is matched off the head of the message. Anything we cannot
// positively identify as NotFound counts as a failure, not as absence.
function isNotFound(e: unknown): boolean {
  return e instanceof Error && /^NotFound\b/.test(e.message);
}

const SEARCH_MAX_BYTES = 5_000_000;
const SNIPPET_MAX_CHARS = 200;

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
    } catch (e) {
      // "Absent" and "could not find out" are different answers, and the
      // remote sweep acts destructively on the first one: it deletes the
      // record (and every device then removes its byte-identical local copy)
      // when stat reports null. So only OpenDAL's NotFound kind may answer
      // null here -- an auth failure, a 5xx or a timeout must throw, and the
      // sweep's catch turns that into a reported error with the record left
      // alone.
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  const adapter: FileAdapter = {
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
      // OpenDAL requires the prefix path to end with "/". Empty prefix
      // means root. Recursive: callers (runDiscovery) expect the whole
      // node subtree -- synced files always live under section dirs
      // (wip/, outputs/, resources/), so a one-level list would make
      // new_remote discovery blind. Mirrors the Drive adapter's walk.
      const normalized =
        prefix === "" ? "" : prefix.endsWith("/") ? prefix : `${prefix}/`;
      let entries: Awaited<ReturnType<typeof op.list>>;
      try {
        entries = await op.list(normalized, { recursive: true });
      } catch {
        return [];
      }
      const out: FileRef[] = [];
      for (const entry of entries) {
        const p = entry.path();
        // Listing returns directories too; skip them.
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
    // Content search by grepping every text file under the root. There is
    // no index behind an fs/memory remote, so this is a linear scan -- fine
    // for the small local and test remotes these backends serve. Binary
    // files (NUL byte) and files over SEARCH_MAX_BYTES are skipped; the
    // match is case-insensitive and the snippet is the first matching line.
    async search(query, opts) {
      const limit = Math.max(1, opts?.limit ?? 20);
      const needle = query.toLowerCase();
      if (needle.length === 0) return [];
      const out: SearchHit[] = [];
      const refs = await adapter.list("");
      for (const ref of refs) {
        if (ref.size > SEARCH_MAX_BYTES) continue;
        let buf: Buffer;
        try {
          const raw = await op.read(ref.path);
          buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        } catch {
          continue;
        }
        if (buf.includes(0)) continue;
        const text = buf.toString("utf8");
        const at = text.toLowerCase().indexOf(needle);
        if (at < 0) continue;
        const lineStart = text.lastIndexOf("\n", at) + 1;
        const lineEndRaw = text.indexOf("\n", at);
        const lineEnd = lineEndRaw < 0 ? text.length : lineEndRaw;
        const snippet = text.slice(lineStart, Math.min(lineEnd, lineStart + SNIPPET_MAX_CHARS)).trim();
        out.push({
          path: ref.path,
          name: ref.path.split("/").pop() ?? ref.path,
          mimeType: "application/octet-stream",
          modifiedTime: ref.modified_at.getTime() > 0 ? ref.modified_at.toISOString() : undefined,
          snippet,
        });
        if (out.length >= limit) break;
      }
      return out;
    },
  };
  return adapter;
}
