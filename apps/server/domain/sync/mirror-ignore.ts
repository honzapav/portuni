// Shared ignore policy for the two mirror walkers (engine.walkMirror and
// discover-local.listUntrackedLocal). Discovery feeds auto-adopt, which
// uploads to the remote and registers a files row -- so anything skipped
// here never reaches the remote. Three layers:
//   1. dotfiles and dot-directories (.DS_Store, .obsidian/, .git/, ...)
//   2. a small default junk list (Office lock files, temp/swap files)
//   3. user patterns from <mirrorRoot>/.portuniignore (gitignore subset,
//      see shared/portuniignore.ts)

import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { compileIgnorePatterns } from "../../shared/portuniignore.js";

const DEFAULT_PATTERNS = ["Thumbs.db", "desktop.ini", "~$*", "*.tmp", "*.swp"].join("\n");

export type MirrorIgnore = (absPath: string) => boolean;

// Build a predicate over absolute paths inside mirrorRoot. Matches both
// files and directories (callers must skip descending into ignored dirs).
export async function loadMirrorIgnore(mirrorRoot: string): Promise<MirrorIgnore> {
  const defaults = compileIgnorePatterns(DEFAULT_PATTERNS);
  let custom: ((p: string) => boolean) | null = null;
  try {
    const text = await readFile(join(mirrorRoot, ".portuniignore"), "utf-8");
    custom = compileIgnorePatterns(text);
  } catch {
    /* no .portuniignore -- defaults only */
  }
  return (absPath: string) => {
    const rel = relative(mirrorRoot, absPath).split(sep).join("/");
    if (rel === "" || rel.startsWith("..")) return false;
    if (rel.split("/").some((segment) => segment.startsWith("."))) return true;
    return defaults(rel) || custom?.(rel) === true;
  };
}
