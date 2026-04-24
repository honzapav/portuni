import { join, relative, sep, posix } from "node:path";

const SECTIONS = ["wip", "outputs", "resources"] as const;
export type Section = (typeof SECTIONS)[number];

const TYPE_PLURAL: Record<string, string> = {
  project: "projects", process: "processes", area: "areas",
  principle: "principles", organization: "organizations",
};

export interface NodeInfo {
  orgSyncKey: string | null;
  nodeType: string;
  nodeSyncKey: string;
}

export function buildNodeRoot(n: NodeInfo): string {
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
  const root = buildNodeRoot(a);
  const parts: string[] = [root, a.section];
  if (a.subpath) parts.push(a.subpath);
  parts.push(a.filename);
  return posix.join(...parts);
}

export interface MirrorSubpathResult { section: Section; subpath: string | null; filename: string; }

export function subpathFromMirror(mirrorRoot: string, absolutePath: string): MirrorSubpathResult | null {
  const rel = relative(mirrorRoot, absolutePath);
  if (rel.startsWith("..") || rel === "") return null;
  const parts = rel.split(sep);
  const section = parts[0] as Section;
  if (!SECTIONS.includes(section)) return null;
  const filename = parts[parts.length - 1];
  const middle = parts.slice(1, -1);
  return { section, subpath: middle.length === 0 ? null : middle.join(posix.sep), filename };
}

export interface DeriveLocalPathArgs { mirrorRoot: string; nodeRoot: string; remotePath: string; }

export function deriveLocalPath(a: DeriveLocalPathArgs): string {
  const prefix = `${a.nodeRoot}/`;
  if (!a.remotePath.startsWith(prefix)) {
    throw new Error(`deriveLocalPath: remotePath ${JSON.stringify(a.remotePath)} does not start with nodeRoot ${JSON.stringify(a.nodeRoot)}`);
  }
  return join(a.mirrorRoot, a.remotePath.slice(prefix.length));
}
