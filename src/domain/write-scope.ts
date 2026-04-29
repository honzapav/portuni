// Filesystem write-scope helpers (Phase B of the scope model spec).
//
// PORTUNI_ROOT names the directory that contains every Portuni mirror on this
// machine. Default: nearest common ancestor of every entry in local_mirrors.
//
// Three tiers govern write decisions:
//   1) inside the current mirror -> free
//   2) inside PORTUNI_ROOT but in a sibling mirror -> deny
//   3) outside PORTUNI_ROOT -> deny (always-ask hard floor)
//
// Portuni doesn't enforce these tiers itself; it generates per-harness
// configuration that the agent's own permission system enforces, plus an
// optional PreToolUse hook (`portuni-guard`) that calls /scope and
// classifies a target.

import { resolve, sep, join, dirname } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type WriteTier = "tier1_current" | "tier2_sibling" | "tier3_outside";

export interface ScopeClassification {
  tier: WriteTier;
  reason: string;
  // The mirror the cwd resolves into (null when outside any mirror).
  current_mirror: string | null;
  // The mirror the target falls into (null when outside every mirror).
  target_mirror: string | null;
  // The configured PORTUNI_ROOT used for the classification.
  portuni_root: string;
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return p.replace(/^~/, homedir());
  if (p === "~") return homedir();
  return p;
}

// Normalize a filesystem path: expand ~, resolve, strip trailing slash.
export function normalize(p: string): string {
  return resolve(expandHome(p));
}

// Is `child` strictly inside `parent`? We require a directory boundary so
// /foo/bar-baz isn't classified as inside /foo/bar.
export function isWithin(parent: string, child: string): boolean {
  const p = normalize(parent);
  const c = normalize(child);
  if (p === c) return true;
  return c.startsWith(p.endsWith(sep) ? p : p + sep);
}

// Find which mirror, if any, contains `path`. Returns the mirror with the
// longest matching prefix so nested mirrors resolve to the most specific.
export function findContainingMirror(
  mirrors: readonly string[],
  path: string,
): string | null {
  const target = normalize(path);
  let best: string | null = null;
  for (const raw of mirrors) {
    const m = normalize(raw);
    if (isWithin(m, target) && (best === null || m.length > best.length)) {
      best = m;
    }
  }
  return best;
}

// Compute the nearest common ancestor of a set of paths. Handy default for
// PORTUNI_ROOT when the user hasn't set it explicitly.
export function commonAncestor(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  const split = paths.map((p) => normalize(p).split(sep));
  const first = split[0];
  let i = 0;
  for (; i < first.length; i++) {
    const seg = first[i];
    if (split.some((s) => s[i] !== seg)) break;
  }
  // Need at least the leading "" plus one real segment to be useful (i.e.
  // `/foo/...`). Returning the bare filesystem root is too broad to be a
  // sensible PORTUNI_ROOT default.
  if (i < 2) return null;
  const ancestor = first.slice(0, i).join(sep);
  return ancestor.startsWith(sep) || ancestor.match(/^[A-Z]:/i) ? ancestor : sep + ancestor;
}

export interface PortuniRootConfig {
  // explicit user/install setting; takes precedence
  envValue?: string | null;
  // every mirror known to this device, used to derive a default
  knownMirrors?: readonly string[];
}

// Resolve PORTUNI_ROOT from env or the nearest common ancestor of mirrors.
// Returns null only when there are no mirrors and no env var.
export function resolvePortuniRoot(cfg: PortuniRootConfig): string | null {
  const env = cfg.envValue?.trim();
  if (env) return normalize(env);
  const mirrors = cfg.knownMirrors ?? [];
  if (mirrors.length === 0) return null;
  if (mirrors.length === 1) {
    // Single mirror: PORTUNI_ROOT = its parent so siblings can later be added.
    const m = normalize(mirrors[0]);
    const parent = m.split(sep).slice(0, -1).join(sep);
    return parent.length === 0 ? sep : parent;
  }
  return commonAncestor(mirrors);
}

// Classify a write target relative to a cwd, the configured PORTUNI_ROOT,
// and the set of all known mirrors on this device. The portuni-guard hook
// passes its own cwd + the agent's target path; the server resolves
// PORTUNI_ROOT and the mirror set.
export function classifyWrite(args: {
  cwd: string;
  target: string;
  portuniRoot: string;
  mirrors: readonly string[];
}): ScopeClassification {
  const cwd = normalize(args.cwd);
  const target = normalize(args.target);
  const portuniRoot = normalize(args.portuniRoot);
  const mirrors = args.mirrors;

  const currentMirror = findContainingMirror(mirrors, cwd);
  const targetMirror = findContainingMirror(mirrors, target);

  if (currentMirror && targetMirror && currentMirror === targetMirror) {
    return {
      tier: "tier1_current",
      reason: `Target is inside current mirror (${currentMirror}).`,
      current_mirror: currentMirror,
      target_mirror: targetMirror,
      portuni_root: portuniRoot,
    };
  }

  if (isWithin(portuniRoot, target)) {
    if (targetMirror && currentMirror && targetMirror !== currentMirror) {
      return {
        tier: "tier2_sibling",
        reason:
          `Target is in sibling mirror ${targetMirror} (current is ${currentMirror}). ` +
          `Run from that mirror's directory or confirm the cross-mirror write.`,
        current_mirror: currentMirror,
        target_mirror: targetMirror,
        portuni_root: portuniRoot,
      };
    }
    if (targetMirror && !currentMirror) {
      return {
        tier: "tier2_sibling",
        reason:
          `Target is in mirror ${targetMirror} but current cwd is not inside any mirror. ` +
          `Run from that mirror's directory or confirm the write.`,
        current_mirror: currentMirror,
        target_mirror: targetMirror,
        portuni_root: portuniRoot,
      };
    }
    // Inside PORTUNI_ROOT but not under any specific mirror — treat as
    // sibling-ish (the user clearly meant Portuni territory but this isn't
    // a registered node folder).
    return {
      tier: "tier2_sibling",
      reason: `Target is inside PORTUNI_ROOT (${portuniRoot}) but outside every registered mirror. Confirm the write.`,
      current_mirror: currentMirror,
      target_mirror: targetMirror,
      portuni_root: portuniRoot,
    };
  }

  return {
    tier: "tier3_outside",
    reason: `Target is outside PORTUNI_ROOT (${portuniRoot}). Confirm the write is intended.`,
    current_mirror: currentMirror,
    target_mirror: targetMirror,
    portuni_root: portuniRoot,
  };
}

// --- Resolution helpers for the agent-harness wiring ---

// Find the portuni-guard.sh script path. Used as the PreToolUse hook command
// in generated .claude/settings.local.json. Returns null if the script can't
// be located -- callers omit the hook block in that case rather than ship
// a broken reference.
//
// Resolution order:
//   1) PORTUNI_GUARD_SCRIPT env var (must be an existing file)
//   2) ../scripts/portuni-guard.sh relative to this module (works from
//      both src/ during dev and dist/ when built)
export function resolveGuardScriptPath(): string | null {
  const explicit = process.env.PORTUNI_GUARD_SCRIPT?.trim();
  if (explicit) {
    return existsSync(explicit) ? explicit : null;
  }
  try {
    const here = fileURLToPath(import.meta.url);
    const dir = dirname(here);
    // src/domain/write-scope.ts -> repo/scripts/portuni-guard.sh
    // dist/domain/write-scope.js -> repo/scripts/portuni-guard.sh
    const candidate = join(dir, "..", "..", "scripts", "portuni-guard.sh");
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

// Compose the Portuni MCP server URL from configured host/port. Honours
// PORTUNI_URL when set (allowing a custom scheme/host/port), normalising
// the trailing /mcp segment.
export function resolvePortuniMcpUrl(): string {
  const explicit = process.env.PORTUNI_URL?.trim();
  if (explicit) {
    const trimmed = explicit.replace(/\/+$/, "");
    return trimmed.endsWith("/mcp") ? trimmed : trimmed + "/mcp";
  }
  const port = Number(process.env.PORT ?? 4011);
  const host = process.env.HOST ?? "127.0.0.1";
  return `http://${host}:${port}/mcp`;
}

// Build the Claude Code project-scoped .mcp.json content. The user is
// prompted once on first session whether to trust the server. The auth
// token is embedded literally only when PORTUNI_AUTH_TOKEN is set; users
// running auth-enabled deployments should gitignore .mcp.json.
export function buildClaudeMcpJson(args: {
  url: string;
  authToken?: string | null;
}): Record<string, unknown> {
  const server: Record<string, unknown> = {
    type: "http",
    url: args.url,
  };
  if (args.authToken && args.authToken.length > 0) {
    server.headers = { Authorization: `Bearer ${args.authToken}` };
  }
  return {
    portuni_managed: {
      generated_at: new Date().toISOString(),
      note: "Portuni-managed file; will be regenerated when mirrors change. Gitignore if you store an auth token here.",
    },
    mcpServers: {
      portuni: server,
    },
  };
}

// Build the hooks block for .claude/settings.local.json. Returns null when
// no guard script is available so callers know to omit the block.
function buildClaudeHooksBlock(args: {
  guardScriptPath: string | null;
}): { hooks: Record<string, unknown> } | null {
  if (!args.guardScriptPath) return null;
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "Edit|Write|NotebookEdit|MultiEdit",
          hooks: [
            {
              type: "command",
              command: args.guardScriptPath,
            },
          ],
        },
      ],
    },
  };
}

// Build the .claude/settings.local.json contents for a mirror.
//
// Layered on top of the user's settings.json (Claude Code merges these),
// so this file is safe to overwrite on every regeneration -- it carries
// only Portuni-managed allow/deny rules.
//
// Allow tier 1 (current mirror) and explicit deny per other registered
// mirror. We deliberately do NOT emit a generic "deny everything outside
// PORTUNI_ROOT" rule -- Claude Code's permission grammar is plain glob
// without negation, and Portuni's tier-3 enforcement runs through the
// portuni-guard PreToolUse hook + the harness's own ambient permissions,
// not declarative rules. An invalid synthetic rule was worse than nothing.
export function buildClaudeSettings(args: {
  currentMirror: string;
  otherMirrors: readonly string[];
  portuniRoot: string;
  guardScriptPath?: string | null;
}): Record<string, unknown> {
  const cur = normalize(args.currentMirror);
  const others = args.otherMirrors.map(normalize).filter((m) => m !== cur);
  const ALLOW_VERBS = ["Edit", "Write", "NotebookEdit"] as const;
  const allow = ALLOW_VERBS.map((v) => `${v}(${cur}/**)`);
  const deny: string[] = [];
  for (const m of others) {
    for (const v of ALLOW_VERBS) deny.push(`${v}(${m}/**)`);
  }

  const out: Record<string, unknown> = {
    // Portuni-managed marker so future code can recognise its own files
    // and avoid clobbering settings.local.json a user customised.
    portuni_managed: {
      mirror: cur,
      portuni_root: normalize(args.portuniRoot),
      generated_at: new Date().toISOString(),
    },
    permissions: {
      allow,
      deny,
    },
  };

  // Auto-wire the portuni-guard PreToolUse hook when we know where the
  // script lives. Without this, the user has to install the hook by hand
  // and tier-3 enforcement is purely declarative (which Claude Code does
  // not enforce at the kernel).
  const hookBlock = buildClaudeHooksBlock({
    guardScriptPath: args.guardScriptPath ?? null,
  });
  if (hookBlock) {
    out.hooks = hookBlock.hooks;
  }

  return out;
}

// .codex/config.toml-style payload (we render as TOML in the caller).
export function buildCodexSandboxConfig(args: {
  currentMirror: string;
}): { sandbox_workspace_write: { writable_roots: string[] } } {
  return {
    sandbox_workspace_write: {
      writable_roots: [normalize(args.currentMirror)],
    },
  };
}

// Codex MCP server registration block. Codex uses HTTP MCP transport via
// the `[mcp_servers.<name>]` table in config.toml. The bearer token is
// embedded in headers when PORTUNI_AUTH_TOKEN is set; users with auth
// enabled should gitignore .codex/config.toml or use a per-mirror config.
export interface CodexMcpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

export function buildCodexMcpServer(args: {
  url: string;
  authToken?: string | null;
}): CodexMcpServerConfig {
  const cfg: CodexMcpServerConfig = {
    type: "http",
    url: args.url,
  };
  if (args.authToken && args.authToken.length > 0) {
    cfg.headers = { Authorization: `Bearer ${args.authToken}` };
  }
  return cfg;
}

// Soft-hint paragraph that gets appended to CLAUDE.md / AGENTS.md / .cursor/rules.
export function buildSoftHint(args: {
  currentMirror: string;
  portuniRoot: string;
}): string {
  return [
    "## Portuni write scope",
    "",
    `This mirror (\`${normalize(args.currentMirror)}\`) is your workspace.`,
    "Other mirror paths that appear in Portuni context are READ-ONLY references.",
    "Editing files in those siblings is out of scope for this session — ask the user first.",
    `Paths outside PORTUNI_ROOT (\`${normalize(args.portuniRoot)}\`) require explicit user approval for every write.`,
    "",
  ].join("\n");
}
