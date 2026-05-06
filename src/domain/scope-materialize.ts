// Materialize per-harness scope config inside a mirror folder.
//
// Generated artifacts (overlay-style, never overwriting user-owned files):
//   - .claude/settings.local.json — Claude Code merges this on top of the
//     user's settings.json, so we own this file completely and refresh it
//     on every call. The file carries a `portuni_managed` marker.
//   - .codex/config.toml — written ONLY when missing or when the existing
//     file already carries the Portuni marker comment (we don't clobber a
//     hand-edited Codex config).
//   - .cursor/rules — soft hint, plain text, refreshed.
//   - PORTUNI_SCOPE.md — soft hint, harness-agnostic, refreshed.
//
// Soft hints are also injected into CLAUDE.md / AGENTS.md if those files
// already exist, between BEGIN/END Portuni-managed markers — anything
// outside the markers is preserved untouched.
//
// This is best-effort: any individual write failure logs and is swallowed
// so register_mirror itself doesn't fail when, say, .cursor/ has restrictive
// permissions.

import { mkdir, readFile, writeFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  buildClaudeSettings,
  buildCodexSandboxConfig,
  buildSoftHint,
  normalize,
  resolveGuardScriptPath,
  resolvePortuniRoot,
} from "./write-scope.js";
import { listUserMirrors } from "./sync/mirror-registry.js";
import { SOLO_USER } from "../infra/schema.js";

const BEGIN_MARKER = "<!-- BEGIN portuni-scope (auto-generated, do not edit) -->";
const END_MARKER = "<!-- END portuni-scope -->";

export interface MaterializeArgs {
  // Path of the mirror being materialized (the "current mirror" from the
  // perspective of any agent invoked inside it).
  currentMirror: string;
  // All other mirror paths known to this device. Used to populate the deny
  // lists for tier 2.
  otherMirrors: readonly string[];
  // Resolved PORTUNI_ROOT.
  portuniRoot: string;
  // Absolute path of portuni-guard.sh on this device. When set, the
  // generated .claude/settings.local.json wires it as a PreToolUse hook;
  // when null, no hook is generated (declarative deny list still applies).
  guardScriptPath?: string | null;
  // Home node id (the node owning this mirror). Embedded into the soft
  // hint so agents read it from CLAUDE.md / AGENTS.md / PORTUNI_SCOPE.md
  // and call `portuni_session_init({ home_node_id: ... })` at the start
  // of each session. Replaces the per-mirror `.mcp.json` auto-seed URL
  // mechanism — connection now lives in user-scoped configs only.
  homeNodeId?: string | null;
}

export interface MaterializeResult {
  written: string[];
  errors: { path: string; message: string }[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function safeWrite(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}

function tomlScalar(v: string): string {
  return JSON.stringify(v); // double-quoted string is valid TOML
}

const CODEX_MARKER = "# portuni-managed: do not edit between this line and the next portuni marker";

function renderCodexToml(cfg: {
  sandbox_workspace_write: { writable_roots: string[] };
}): string {
  const lines: string[] = [];
  lines.push(CODEX_MARKER);
  lines.push("[sandbox_workspace_write]");
  lines.push(
    `writable_roots = [${cfg.sandbox_workspace_write.writable_roots.map(tomlScalar).join(", ")}]`,
  );
  lines.push("");
  // Connection to the Portuni MCP server lives in the user-scoped
  // ~/.codex/config.toml (written by the install_codex_global Tauri
  // command), not here. Agents discover scope via the soft-hint
  // `portuni_session_init` instruction in CLAUDE.md / AGENTS.md.
  return lines.join("\n");
}

// Inject `body` into `existing` between markers, preserving everything else.
// If markers don't exist, append a new block at the end. Idempotent.
function applyMarkerBlock(existing: string, body: string): string {
  const block = `${BEGIN_MARKER}\n${body.trim()}\n${END_MARKER}\n`;
  const beginIdx = existing.indexOf(BEGIN_MARKER);
  const endIdx = existing.indexOf(END_MARKER);
  if (beginIdx >= 0 && endIdx > beginIdx) {
    const before = existing.slice(0, beginIdx);
    const after = existing.slice(endIdx + END_MARKER.length);
    return (before.trimEnd() + "\n\n" + block + after.trimStart()).trim() + "\n";
  }
  // Not present: append.
  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  return (existing.length === 0 ? "" : existing + sep) + block;
}

async function refreshMarkdownHint(
  filePath: string,
  hint: string,
  result: MaterializeResult,
): Promise<void> {
  try {
    const had = await exists(filePath);
    const existing = had ? await readFile(filePath, "utf8") : "";
    if (!had) {
      // Don't create CLAUDE.md / AGENTS.md unless they already exist; we
      // only refresh files the user opted into.
      return;
    }
    const next = applyMarkerBlock(existing, hint);
    if (next !== existing) {
      await safeWrite(filePath, next);
      result.written.push(filePath);
    }
  } catch (e) {
    result.errors.push({ path: filePath, message: (e as Error).message });
  }
}

export async function materializeScopeConfig(
  args: MaterializeArgs,
): Promise<MaterializeResult> {
  const result: MaterializeResult = { written: [], errors: [] };
  const cur = normalize(args.currentMirror);

  // 1. .claude/settings.local.json (overlay file Claude Code merges on top
  //    of settings.json -- safe to own/overwrite). The user's settings.json
  //    is left untouched. Also wires portuni-guard as PreToolUse hook when
  //    the script is locatable on this device.
  try {
    const settings = buildClaudeSettings({
      currentMirror: cur,
      otherMirrors: args.otherMirrors,
      portuniRoot: args.portuniRoot,
      guardScriptPath: args.guardScriptPath ?? null,
    });
    const path = join(cur, ".claude", "settings.local.json");
    await safeWrite(path, JSON.stringify(settings, null, 2) + "\n");
    result.written.push(path);
  } catch (e) {
    result.errors.push({ path: ".claude/settings.local.json", message: (e as Error).message });
  }

  // 2. .codex/config.toml -- sandbox config only. The MCP server
  //    connection lives in user-scoped ~/.codex/config.toml (written by
  //    the install_codex_global Tauri command). Write only when missing
  //    OR when the existing file already carries the Portuni marker, so
  //    we never clobber a hand-written Codex config.
  try {
    const sandbox = buildCodexSandboxConfig({ currentMirror: cur });
    const path = join(cur, ".codex", "config.toml");
    let mayWrite = true;
    let skipReason: string | null = null;
    if (await exists(path)) {
      const existing = await readFile(path, "utf8");
      if (!existing.includes(CODEX_MARKER)) {
        mayWrite = false;
        skipReason = "existing .codex/config.toml is user-owned (no portuni marker); skipped";
      }
    }
    if (mayWrite) {
      await safeWrite(path, renderCodexToml(sandbox));
      result.written.push(path);
    } else if (skipReason) {
      result.errors.push({ path, message: skipReason });
    }
  } catch (e) {
    result.errors.push({ path: ".codex/config.toml", message: (e as Error).message });
  }

  // 3. Active cleanup: legacy per-mirror `.mcp.json` files written by
  //    earlier Portuni versions. Connection now lives in user-scoped
  //    ~/.claude.json (install_claude_global Tauri command); the soft
  //    hint below tells agents to call portuni_session_init for scope.
  //    Best-effort: if the file isn't ours, skip silently.
  try {
    const legacyMcpPath = join(cur, ".mcp.json");
    if (await exists(legacyMcpPath)) {
      const raw = await readFile(legacyMcpPath, "utf8");
      // Only remove files that carry our marker; leave hand-written
      // .mcp.json files untouched.
      if (raw.includes("portuni_managed") || raw.includes('"portuni"')) {
        await unlink(legacyMcpPath);
        result.written.push(`removed:${legacyMcpPath}`);
      }
    }
  } catch (e) {
    result.errors.push({ path: ".mcp.json", message: (e as Error).message });
  }

  // 4. .cursor/rules (always written, plain text)
  const hint = buildSoftHint({
    currentMirror: cur,
    portuniRoot: args.portuniRoot,
    homeNodeId: args.homeNodeId ?? null,
  });
  try {
    const path = join(cur, ".cursor", "rules");
    await safeWrite(path, hint);
    result.written.push(path);
  } catch (e) {
    result.errors.push({ path: ".cursor/rules", message: (e as Error).message });
  }

  // 5. PORTUNI_SCOPE.md (always present, harness-agnostic)
  try {
    const path = join(cur, "PORTUNI_SCOPE.md");
    await safeWrite(path, hint);
    result.written.push(path);
  } catch (e) {
    result.errors.push({ path: "PORTUNI_SCOPE.md", message: (e as Error).message });
  }

  // 6. Refresh CLAUDE.md / AGENTS.md ONLY if they already exist (don't create
  //    them — those files are user-owned).
  await refreshMarkdownHint(join(cur, "CLAUDE.md"), hint, result);
  await refreshMarkdownHint(join(cur, "AGENTS.md"), hint, result);

  return result;
}

// Re-materialise every mirror registered for the solo user, picking up
// the current MCP URL + auth token from env. Called at sidecar boot so
// per-mirror .mcp.json files written by an older launch (random port,
// rotated token) refresh automatically.
//
// Returns aggregated written paths and errors; never throws — boot must
// not be blocked by a single mirror's filesystem hiccup.
export async function materializeAllRegisteredMirrors(): Promise<MaterializeResult> {
  const aggregated: MaterializeResult = { written: [], errors: [] };
  const mirrors = await listUserMirrors(SOLO_USER);
  if (mirrors.length === 0) return aggregated;

  const paths = mirrors.map((m) => m.local_path);
  const portuniRoot = resolvePortuniRoot({
    envValue: process.env.PORTUNI_ROOT ?? null,
    knownMirrors: paths,
  });
  if (!portuniRoot) return aggregated;

  const guardScriptPath = resolveGuardScriptPath();

  for (const m of mirrors) {
    const others = paths.filter((p) => p !== m.local_path);
    try {
      const r = await materializeScopeConfig({
        currentMirror: m.local_path,
        otherMirrors: others,
        portuniRoot,
        guardScriptPath,
        homeNodeId: m.node_id,
      });
      aggregated.written.push(...r.written);
      aggregated.errors.push(...r.errors);
    } catch (e) {
      aggregated.errors.push({
        path: m.local_path,
        message: (e as Error).message,
      });
    }
  }
  return aggregated;
}
