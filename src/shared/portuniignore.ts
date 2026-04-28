// Minimal gitignore-style matcher used by bulk-promote and
// cleanup-ignored-files. Supports:
//   - root-anchored patterns:   /foo, /node_modules
//   - directory patterns:       foo/
//   - basename patterns:        secret.env
//   - path-with-slash patterns: secrets/foo
//   - wildcards:                *.tmp, **/cache
//
// Returns a predicate matching a workspace-relative POSIX path.
export function compileIgnorePatterns(text: string): (path: string) => boolean {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  const matchers: Array<(p: string) => boolean> = [];
  for (const raw of lines) {
    let pat = raw;
    const dirOnly = pat.endsWith("/");
    if (dirOnly) pat = pat.slice(0, -1);
    const re = pat
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "::DOUBLESTAR::")
      .replace(/\*/g, "[^/]*")
      .replace(/::DOUBLESTAR::/g, ".*");
    if (pat.startsWith("/")) {
      // Anchor at root. The leading "/" passes through the escape pipeline
      // unchanged, so slice(1) drops just that single character.
      const r = new RegExp(`^${re.slice(1)}(/|$)`);
      matchers.push((p) => r.test(p));
    } else if (pat.includes("/")) {
      // Path-with-slash: match as a substring at any depth.
      const r = new RegExp(`(^|/)${re}(/|$)`);
      matchers.push((p) => r.test(p));
    } else {
      // Bare name: match basename or any path segment.
      const r = new RegExp(`(^|/)${re}(/|$)`);
      matchers.push((p) => r.test(p));
    }
  }
  return (relativePath: string) => matchers.some((m) => m(relativePath));
}
