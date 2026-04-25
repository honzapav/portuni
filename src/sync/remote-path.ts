import { join, relative, sep, posix } from "node:path";
import { ensureUnderRoot, isInside, PathTraversalError } from "../safe-path.js";

const SECTIONS = ["wip", "outputs", "resources"] as const;
export type Section = (typeof SECTIONS)[number];

const TYPE_PLURAL: Record<string, string> = {
  project: "projects", process: "processes", area: "areas",
  principle: "principles", organization: "organizations",
};

export class RemotePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemotePathError";
  }
}

// Reject anything that could escape a path scope or carry control bytes.
// "..", ".", "" are traversal/no-op segments; "/" or "\" inside a segment
// means the caller already pre-joined and bypassed our composition; "\0"
// is a classic null-byte truncation trick.
function assertSafeSegment(seg: string, ctx: string): void {
  if (seg === "" || seg === "." || seg === "..") {
    throw new RemotePathError(
      `${ctx}: empty/dot segment not allowed: ${JSON.stringify(seg)}`,
    );
  }
  if (seg.includes("/") || seg.includes("\\") || seg.includes("\0")) {
    throw new RemotePathError(
      `${ctx}: invalid character in segment: ${JSON.stringify(seg)}`,
    );
  }
}

// Validate a relative POSIX-style path (segments joined by "/"). Rejects
// absolute paths, leading "/", and any segment that would escape its
// parent. Empty input means "no path" — callers pass null instead.
export function assertSafeRelativePath(rel: string, ctx: string): void {
  if (rel === "") {
    throw new RemotePathError(`${ctx}: empty path not allowed`);
  }
  if (rel.startsWith("/")) {
    throw new RemotePathError(`${ctx}: absolute path not allowed: ${rel}`);
  }
  for (const seg of rel.split("/")) {
    assertSafeSegment(seg, ctx);
  }
}

export interface NodeInfo {
  orgSyncKey: string | null;
  nodeType: string;
  nodeSyncKey: string;
}

export function buildNodeRoot(n: NodeInfo): string {
  // sync_key is server-generated and slug-shaped, but defend in depth in
  // case a future migration relaxes that constraint.
  if (n.orgSyncKey !== null) assertSafeSegment(n.orgSyncKey, "buildNodeRoot.orgSyncKey");
  assertSafeSegment(n.nodeSyncKey, "buildNodeRoot.nodeSyncKey");
  if (n.nodeType === "organization") return n.orgSyncKey ?? n.nodeSyncKey;
  const plural = TYPE_PLURAL[n.nodeType] ?? n.nodeType;
  const parts = n.orgSyncKey ? [n.orgSyncKey, plural, n.nodeSyncKey] : [plural, n.nodeSyncKey];
  return posix.join(...parts);
}

export interface BuildRemotePathArgs extends NodeInfo {
  section: Section;
  subpath: string | null;
  filename: string;
}

export function buildRemotePath(a: BuildRemotePathArgs): string {
  if (!SECTIONS.includes(a.section)) {
    throw new RemotePathError(`buildRemotePath: invalid section ${JSON.stringify(a.section)}`);
  }
  assertSafeSegment(a.filename, "buildRemotePath.filename");
  if (a.subpath !== null) {
    assertSafeRelativePath(a.subpath, "buildRemotePath.subpath");
  }
  const root = buildNodeRoot(a);
  const parts: string[] = [root, a.section];
  if (a.subpath) parts.push(a.subpath);
  parts.push(a.filename);
  return posix.join(...parts);
}

export interface MirrorSubpathResult { section: Section; subpath: string | null; filename: string; }

export function subpathFromMirror(mirrorRoot: string, absolutePath: string): MirrorSubpathResult | null {
  // Defence in depth: if the absolute path symlinks/escapes outside the
  // mirror, refuse to return any structure for it.
  if (!isInside(mirrorRoot, absolutePath)) return null;
  const rel = relative(mirrorRoot, absolutePath);
  if (rel.startsWith("..") || rel === "") return null;
  const parts = rel.split(sep);
  const section = parts[0] as Section;
  if (!SECTIONS.includes(section)) return null;
  const filename = parts[parts.length - 1];
  const middle = parts.slice(1, -1);
  // Reject pre-normalised traversal that snuck back in via odd path joins.
  for (const seg of [...middle, filename]) {
    if (seg === "" || seg === "." || seg === "..") return null;
  }
  return { section, subpath: middle.length === 0 ? null : middle.join(posix.sep), filename };
}

export interface DeriveLocalPathArgs { mirrorRoot: string; nodeRoot: string; remotePath: string; }

export function deriveLocalPath(a: DeriveLocalPathArgs): string {
  const prefix = `${a.nodeRoot}/`;
  if (!a.remotePath.startsWith(prefix)) {
    throw new RemotePathError(
      `deriveLocalPath: remotePath ${JSON.stringify(a.remotePath)} does not start with nodeRoot ${JSON.stringify(a.nodeRoot)}`,
    );
  }
  const remainder = a.remotePath.slice(prefix.length);
  // Validate the relative remainder before composing — catches "../"
  // segments and absolute paths that would escape the mirror after join().
  assertSafeRelativePath(remainder, "deriveLocalPath.remotePath");
  try {
    return ensureUnderRoot(a.mirrorRoot, remainder);
  } catch (e) {
    if (e instanceof PathTraversalError) {
      throw new RemotePathError(
        `deriveLocalPath: composed path escapes mirror root (${a.mirrorRoot}): ${a.remotePath}`,
      );
    }
    throw e;
  }
}

// Safe variant of join() for assembling a mirror-local absolute path from
// components controlled by the caller. Throws if the result escapes the
// mirror root (e.g. via a "../" segment that posix.join would silently
// normalise).
export function safeMirrorJoin(mirrorRoot: string, ...segments: string[]): string {
  for (const seg of segments) {
    if (seg === "") continue;
    // Allow callers to pass multi-segment relative subpaths (e.g. "a/b").
    assertSafeRelativePath(seg, "safeMirrorJoin.segment");
  }
  try {
    return ensureUnderRoot(mirrorRoot, join(...segments));
  } catch (e) {
    if (e instanceof PathTraversalError) {
      throw new RemotePathError(
        `safeMirrorJoin: composed path escapes mirror root (${mirrorRoot})`,
      );
    }
    throw e;
  }
}
