// When the sync agent last refreshed every mirror's harness configs at boot
// (#633). That refresh costs central two requests per mirror (data sources
// and orientation) and, with a stable per-workspace port, writes the same
// files again on a quick restart (Cmd+Q and relaunch): with a few dozen
// mirrors that alone used a third of the token's per-minute budget, twice
// within 20 s. A boot within REFRESH_FRESH_MS of the last complete refresh,
// with the same MCP URL, the same set of mirrors and the same sidecar build,
// skips it. The build is part of the key because the materialiser's output
// is a function of the code too: the updater relaunches the new version
// seconds after the old one refreshed, and that boot must write the new
// version's .mcp.json / PORTUNI_SCOPE.md, not trust the old one's stamp.
//
// The stamp is a small JSON file in the device's data dir; a missing,
// unreadable or foreign file means "refresh". A refresh that reported any
// error never writes a stamp, so the next boot retries it.

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const REFRESH_FRESH_MS = 5 * 60_000;
const STAMP_FILE = "mirror-configs-refreshed.json";

export interface RefreshKey {
  mcpUrl: string;
  // Identity of the running code (sidecarBuildId()); any change refreshes.
  build: string;
  mirrors: { node_id: string; local_path: string }[];
}

interface Stamp {
  key: string;
  at: number;
}

function keyOf(k: RefreshKey): string {
  const mirrors = k.mirrors
    .map((m) => `${m.node_id}\u0000${m.local_path}`)
    .sort();
  return JSON.stringify({ mcpUrl: k.mcpUrl, build: k.build, mirrors });
}

// The running code's identity, read from the files it was loaded from: the
// executable (the bun-compiled sidecar is one file, replaced by every update
// and every local build) and the entry script (node dist/desktop.js in dev,
// rebuilt by `npm run build`). Path, size and mtime of each; a file that
// cannot be stat'ed contributes its path only. No version string is used
// on purpose: two builds of the same version (a dev rebuild, a re-signed
// .app) can materialise different files, and the sidecar is not told its
// app version.
export function sidecarBuildId(
  files: readonly (string | undefined)[] = [process.execPath, process.argv[1]],
): string {
  return files
    .filter((f): f is string => typeof f === "string" && f.length > 0)
    .map((f) => {
      try {
        const st = statSync(f);
        return `${f}:${st.size}:${st.mtimeMs}`;
      } catch {
        return f;
      }
    })
    .join("|");
}

export function mirrorConfigsFresh(dataDir: string, k: RefreshKey, nowMs: number): boolean {
  let stamp: Stamp;
  try {
    stamp = JSON.parse(readFileSync(join(dataDir, STAMP_FILE), "utf8")) as Stamp;
  } catch {
    return false;
  }
  if (typeof stamp?.at !== "number" || typeof stamp.key !== "string") return false;
  const age = nowMs - stamp.at;
  return age >= 0 && age < REFRESH_FRESH_MS && stamp.key === keyOf(k);
}

export function recordMirrorConfigsRefreshed(dataDir: string, k: RefreshKey, nowMs: number): void {
  try {
    const stamp: Stamp = { key: keyOf(k), at: nowMs };
    writeFileSync(join(dataDir, STAMP_FILE), JSON.stringify(stamp));
  } catch (e) {
    // Best-effort: without the stamp the next boot simply refreshes again.
    console.warn("[boot] could not record the mirror config refresh:", e);
  }
}
