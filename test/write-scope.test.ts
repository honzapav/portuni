// Tests for the filesystem write-scope module (Phase B of the scope spec).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClaudeMcpJson,
  buildClaudeSettings,
  buildCodexMcpServer,
  buildCodexSandboxConfig,
  buildSoftHint,
  classifyWrite,
  commonAncestor,
  findContainingMirror,
  isWithin,
  resolveGuardScriptPath,
  resolvePortuniMcpUrl,
  resolvePortuniRoot,
} from "../src/domain/write-scope.js";
import { materializeScopeConfig } from "../src/domain/scope-materialize.js";

describe("isWithin", () => {
  it("matches strict prefix at directory boundary", () => {
    assert.equal(isWithin("/foo", "/foo/bar"), true);
    assert.equal(isWithin("/foo", "/foo"), true);
    assert.equal(isWithin("/foo", "/foo-bar"), false);
    assert.equal(isWithin("/foo/bar", "/foo"), false);
  });
});

describe("commonAncestor", () => {
  it("returns the longest shared directory prefix", () => {
    assert.equal(
      commonAncestor(["/Users/x/Dev/projekty/a", "/Users/x/Dev/projekty/b/c"]),
      "/Users/x/Dev/projekty",
    );
  });
  it("returns null for unrelated paths", () => {
    assert.equal(commonAncestor(["/foo", "/bar"]), null);
  });
  it("handles a single path by returning its parent's chain", () => {
    assert.equal(commonAncestor(["/a/b/c"]), "/a/b/c");
  });
});

describe("findContainingMirror", () => {
  it("picks the longest matching mirror prefix (nested mirrors)", () => {
    const m = findContainingMirror(
      ["/root/org", "/root/org/projects/p1"],
      "/root/org/projects/p1/src/file.ts",
    );
    assert.equal(m, "/root/org/projects/p1");
  });
  it("returns null when nothing matches", () => {
    assert.equal(findContainingMirror(["/a/b"], "/c/d"), null);
  });
});

describe("resolvePortuniRoot", () => {
  it("respects an explicit env value", () => {
    assert.equal(
      resolvePortuniRoot({ envValue: "/explicit/root", knownMirrors: ["/other"] }),
      "/explicit/root",
    );
  });
  it("derives the parent of a single mirror", () => {
    assert.equal(resolvePortuniRoot({ envValue: null, knownMirrors: ["/a/b/c"] }), "/a/b");
  });
  it("derives the common ancestor of multiple mirrors", () => {
    assert.equal(
      resolvePortuniRoot({
        envValue: null,
        knownMirrors: ["/a/b/c", "/a/b/d/e"],
      }),
      "/a/b",
    );
  });
  it("returns null when nothing is configured", () => {
    assert.equal(resolvePortuniRoot({ envValue: null, knownMirrors: [] }), null);
  });
});

describe("classifyWrite", () => {
  const mirrors = ["/root/projekty/a", "/root/projekty/b"];

  it("tier1 when target is inside the cwd's mirror", () => {
    const r = classifyWrite({
      cwd: "/root/projekty/a/src",
      target: "/root/projekty/a/src/x.ts",
      portuniRoot: "/root/projekty",
      mirrors,
    });
    assert.equal(r.tier, "tier1_current");
  });

  it("tier2 when target is in a sibling mirror", () => {
    const r = classifyWrite({
      cwd: "/root/projekty/a",
      target: "/root/projekty/b/file.ts",
      portuniRoot: "/root/projekty",
      mirrors,
    });
    assert.equal(r.tier, "tier2_sibling");
  });

  it("tier3 when target is outside PORTUNI_ROOT", () => {
    const r = classifyWrite({
      cwd: "/root/projekty/a",
      target: "/etc/passwd",
      portuniRoot: "/root/projekty",
      mirrors,
    });
    assert.equal(r.tier, "tier3_outside");
  });

  it("tier2 when target is inside PORTUNI_ROOT but no specific mirror", () => {
    const r = classifyWrite({
      cwd: "/root/projekty/a",
      target: "/root/projekty/scratch.txt",
      portuniRoot: "/root/projekty",
      mirrors,
    });
    assert.equal(r.tier, "tier2_sibling");
  });
});

describe("buildClaudeSettings", () => {
  it("emits allow for current mirror and deny for siblings, no synthetic negation", () => {
    const s = buildClaudeSettings({
      currentMirror: "/r/a",
      otherMirrors: ["/r/b"],
      portuniRoot: "/r",
    });
    const allow = (s.permissions as { allow: string[] }).allow;
    const deny = (s.permissions as { deny: string[] }).deny;
    assert.ok(allow.includes("Edit(/r/a/**)"));
    assert.ok(deny.some((d) => d.includes("/r/b")));
    // Drop tier-3 fallback: glob has no negation. Validate it is gone.
    assert.ok(!deny.some((d) => d.includes("!=")));
    assert.ok((s as { portuni_managed?: { mirror?: string } }).portuni_managed?.mirror === "/r/a");
    // Without guardScriptPath, no hooks block should be emitted.
    assert.equal((s as { hooks?: unknown }).hooks, undefined);
  });

  it("wires PreToolUse hook when guardScriptPath is provided", () => {
    const s = buildClaudeSettings({
      currentMirror: "/r/a",
      otherMirrors: [],
      portuniRoot: "/r",
      guardScriptPath: "/usr/local/bin/portuni-guard.sh",
    });
    const hooks = (s as {
      hooks?: { PreToolUse?: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    }).hooks;
    assert.ok(hooks?.PreToolUse?.[0]);
    assert.match(hooks.PreToolUse[0].matcher, /Edit/);
    assert.match(hooks.PreToolUse[0].matcher, /Write/);
    assert.match(hooks.PreToolUse[0].matcher, /MultiEdit/);
    assert.equal(hooks.PreToolUse[0].hooks[0].command, "/usr/local/bin/portuni-guard.sh");
  });
});

describe("buildCodexSandboxConfig", () => {
  it("emits writable_roots list", () => {
    const cfg = buildCodexSandboxConfig({ currentMirror: "/x/y" });
    assert.deepEqual(cfg.sandbox_workspace_write.writable_roots, ["/x/y"]);
  });
});

describe("buildClaudeMcpJson", () => {
  it("emits mcpServers.portuni with type/url; no headers when no token", () => {
    const j = buildClaudeMcpJson({ url: "http://localhost:4011/mcp" });
    const portuni = (j as { mcpServers: { portuni: { type: string; url: string; headers?: unknown } } })
      .mcpServers.portuni;
    assert.equal(portuni.type, "http");
    assert.equal(portuni.url, "http://localhost:4011/mcp");
    assert.equal(portuni.headers, undefined);
  });

  it("embeds bearer header when token is supplied", () => {
    const j = buildClaudeMcpJson({ url: "http://localhost:4011/mcp", authToken: "secret" });
    const portuni = (j as { mcpServers: { portuni: { headers?: Record<string, string> } } })
      .mcpServers.portuni;
    assert.equal(portuni.headers?.Authorization, "Bearer secret");
  });
});

describe("buildCodexMcpServer", () => {
  it("emits http transport with optional bearer headers", () => {
    const a = buildCodexMcpServer({ url: "http://localhost:4011/mcp" });
    assert.equal(a.type, "http");
    assert.equal(a.url, "http://localhost:4011/mcp");
    assert.equal(a.headers, undefined);

    const b = buildCodexMcpServer({ url: "http://localhost:4011/mcp", authToken: "tok" });
    assert.equal(b.headers?.Authorization, "Bearer tok");
  });
});

describe("resolvePortuniMcpUrl", () => {
  it("derives default from HOST/PORT when PORTUNI_URL is unset", () => {
    const orig = { url: process.env.PORTUNI_URL, host: process.env.HOST, port: process.env.PORT };
    delete process.env.PORTUNI_URL;
    process.env.HOST = "127.0.0.1";
    process.env.PORT = "4011";
    try {
      assert.equal(resolvePortuniMcpUrl(), "http://127.0.0.1:4011/mcp");
    } finally {
      if (orig.url !== undefined) process.env.PORTUNI_URL = orig.url;
      if (orig.host !== undefined) process.env.HOST = orig.host;
      else delete process.env.HOST;
      if (orig.port !== undefined) process.env.PORT = orig.port;
      else delete process.env.PORT;
    }
  });

  it("appends /mcp suffix when PORTUNI_URL omits it", () => {
    const orig = process.env.PORTUNI_URL;
    process.env.PORTUNI_URL = "http://example.test/portuni/";
    try {
      assert.equal(resolvePortuniMcpUrl(), "http://example.test/portuni/mcp");
    } finally {
      if (orig !== undefined) process.env.PORTUNI_URL = orig;
      else delete process.env.PORTUNI_URL;
    }
  });
});

describe("resolveGuardScriptPath", () => {
  it("returns the script path when running in this repo", () => {
    const orig = process.env.PORTUNI_GUARD_SCRIPT;
    delete process.env.PORTUNI_GUARD_SCRIPT;
    try {
      const p = resolveGuardScriptPath();
      // We expect the repo's scripts/portuni-guard.sh to resolve.
      assert.ok(p);
      assert.ok(p?.endsWith("portuni-guard.sh"));
    } finally {
      if (orig !== undefined) process.env.PORTUNI_GUARD_SCRIPT = orig;
    }
  });

  it("returns null when PORTUNI_GUARD_SCRIPT points at a missing file", () => {
    const orig = process.env.PORTUNI_GUARD_SCRIPT;
    process.env.PORTUNI_GUARD_SCRIPT = "/definitely/not/a/real/path.sh";
    try {
      assert.equal(resolveGuardScriptPath(), null);
    } finally {
      if (orig !== undefined) process.env.PORTUNI_GUARD_SCRIPT = orig;
      else delete process.env.PORTUNI_GUARD_SCRIPT;
    }
  });
});

describe("buildSoftHint", () => {
  it("references both PORTUNI_ROOT and the mirror path", () => {
    const hint = buildSoftHint({ currentMirror: "/r/a", portuniRoot: "/r" });
    assert.match(hint, /\/r\/a/);
    assert.match(hint, /\/r/);
    assert.match(hint, /Portuni write scope/);
  });
});

describe("materializeScopeConfig", () => {
  it("writes settings.local.json, codex toml, and PORTUNI_SCOPE.md", async () => {
    const dir = await mkdtemp(join(tmpdir(), "portuni-scope-mat-"));
    const cur = join(dir, "a");
    const sib = join(dir, "b");
    await mkdir(cur, { recursive: true });
    await mkdir(sib, { recursive: true });

    const r = await materializeScopeConfig({
      currentMirror: cur,
      otherMirrors: [sib],
      portuniRoot: dir,
    });
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));

    const settings = JSON.parse(await readFile(join(cur, ".claude", "settings.local.json"), "utf8"));
    assert.ok(settings.permissions.allow.length > 0);
    assert.ok(settings.permissions.deny.some((d: string) => d.includes(sib)));
    // No invalid negation pattern should leak into deny rules.
    assert.ok(
      !settings.permissions.deny.some((d: string) => d.includes("!=")),
      "deny rules should be plain glob, no synthetic negation",
    );
    assert.ok(settings.portuni_managed?.mirror === cur);

    const toml = await readFile(join(cur, ".codex", "config.toml"), "utf8");
    assert.match(toml, /sandbox_workspace_write/);
    assert.ok(toml.includes(cur));
    assert.match(toml, /portuni-managed/);

    const portuni = await readFile(join(cur, "PORTUNI_SCOPE.md"), "utf8");
    assert.match(portuni, /Portuni write scope/);
  });

  it("wires portuni-guard PreToolUse hook in settings.local.json when guardScriptPath supplied", async () => {
    const dir = await mkdtemp(join(tmpdir(), "portuni-scope-hook-"));
    const cur = join(dir, "a");
    await mkdir(cur, { recursive: true });

    await materializeScopeConfig({
      currentMirror: cur,
      otherMirrors: [],
      portuniRoot: dir,
      guardScriptPath: "/usr/local/bin/portuni-guard.sh",
    });

    const settings = JSON.parse(await readFile(join(cur, ".claude", "settings.local.json"), "utf8"));
    assert.ok(settings.hooks?.PreToolUse?.[0]);
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, "/usr/local/bin/portuni-guard.sh");
    assert.match(settings.hooks.PreToolUse[0].matcher, /Edit\|Write/);
  });

  it("emits .mcp.json (Claude Code project-scoped MCP) and Codex [mcp_servers.portuni] block when mcpUrl is supplied", async () => {
    const dir = await mkdtemp(join(tmpdir(), "portuni-scope-mcp-"));
    const cur = join(dir, "a");
    await mkdir(cur, { recursive: true });

    await materializeScopeConfig({
      currentMirror: cur,
      otherMirrors: [],
      portuniRoot: dir,
      mcpUrl: "http://localhost:4011/mcp",
      mcpAuthToken: "tok-123",
    });

    const mcpJson = JSON.parse(await readFile(join(cur, ".mcp.json"), "utf8"));
    assert.equal(mcpJson.mcpServers.portuni.type, "http");
    assert.equal(mcpJson.mcpServers.portuni.url, "http://localhost:4011/mcp");
    assert.equal(mcpJson.mcpServers.portuni.headers.Authorization, "Bearer tok-123");

    const toml = await readFile(join(cur, ".codex", "config.toml"), "utf8");
    assert.match(toml, /\[mcp_servers\.portuni\]/);
    assert.match(toml, /type = "http"/);
    assert.match(toml, /url = "http:\/\/localhost:4011\/mcp"/);
    assert.match(toml, /Bearer tok-123/);
  });

  it("omits .mcp.json and Codex MCP block when mcpUrl is null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "portuni-scope-nomcp-"));
    const cur = join(dir, "a");
    await mkdir(cur, { recursive: true });

    await materializeScopeConfig({
      currentMirror: cur,
      otherMirrors: [],
      portuniRoot: dir,
    });

    const mcpExists = await stat(join(cur, ".mcp.json")).then(() => true).catch(() => false);
    assert.equal(mcpExists, false);

    const toml = await readFile(join(cur, ".codex", "config.toml"), "utf8");
    assert.ok(!toml.includes("[mcp_servers"));
  });

  it("preserves a user-owned .codex/config.toml (no portuni marker)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "portuni-scope-codex-keep-"));
    const cur = join(dir, "a");
    await mkdir(join(cur, ".codex"), { recursive: true });

    const userConfig = "# my hand-written codex config\n[sandbox_workspace_write]\nwritable_roots = [\"/elsewhere\"]\n";
    const codexPath = join(cur, ".codex", "config.toml");
    await (await import("node:fs/promises")).writeFile(codexPath, userConfig, "utf8");

    const r = await materializeScopeConfig({
      currentMirror: cur,
      otherMirrors: [],
      portuniRoot: dir,
    });
    const after = await readFile(codexPath, "utf8");
    assert.equal(after, userConfig, "user-owned codex config must not be clobbered");
    // The skip is reported as an error entry so the caller can surface it.
    assert.ok(r.errors.some((e) => e.path.endsWith("config.toml")));
  });

  it("re-runs idempotently and refreshes existing CLAUDE.md between markers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "portuni-scope-idem-"));
    const cur = join(dir, "a");
    await mkdir(cur, { recursive: true });

    // Pre-existing CLAUDE.md the user owns: we should preserve outside the
    // marker block and refresh the block in place across runs.
    const claudeMd = join(cur, "CLAUDE.md");
    const original = "# My project\n\nUser content here.\n";
    await (await import("node:fs/promises")).writeFile(claudeMd, original, "utf8");

    await materializeScopeConfig({
      currentMirror: cur,
      otherMirrors: [],
      portuniRoot: dir,
    });
    const afterFirst = await readFile(claudeMd, "utf8");
    assert.match(afterFirst, /# My project/);
    assert.match(afterFirst, /BEGIN portuni-scope/);
    assert.match(afterFirst, /END portuni-scope/);

    await materializeScopeConfig({
      currentMirror: cur,
      otherMirrors: [],
      portuniRoot: dir,
    });
    const afterSecond = await readFile(claudeMd, "utf8");
    // Markers shouldn't have duplicated.
    const beginCount = (afterSecond.match(/BEGIN portuni-scope/g) ?? []).length;
    assert.equal(beginCount, 1);
  });
});
