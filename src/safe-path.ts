import { resolve, sep, isAbsolute } from "node:path";

export class PathTraversalError extends Error {
  constructor(public readonly attempted: string, public readonly root: string) {
    super(`Path escapes root: ${attempted} (root: ${root})`);
    this.name = "PathTraversalError";
  }
}

export function isInside(root: string, candidate: string): boolean {
  const rootResolved = resolve(root);
  const targetResolved = resolve(candidate);
  return targetResolved === rootResolved || targetResolved.startsWith(rootResolved + sep);
}

export function safeJoin(root: string, ...segments: string[]): string {
  const rootResolved = resolve(root);
  const target = resolve(rootResolved, ...segments);
  if (target !== rootResolved && !target.startsWith(rootResolved + sep)) {
    throw new PathTraversalError(target, rootResolved);
  }
  return target;
}

export function ensureUnderRoot(root: string, candidate: string): string {
  const absolute = isAbsolute(candidate) ? candidate : resolve(root, candidate);
  if (!isInside(root, absolute)) {
    throw new PathTraversalError(absolute, resolve(root));
  }
  return resolve(absolute);
}
