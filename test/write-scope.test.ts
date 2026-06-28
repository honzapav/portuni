// Tests for the filesystem write-scope module (Phase B of the scope spec).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendHomeNodeIdToUrl,
  buildClaudeMcpJson,
  buildClaudeSettings,
  buildCodexMcpServer,
  buildCodexSandboxConfig,
  buildSoftHint,
  buildVibeMcpToml,
  VIBE_PROJECT_MARKER,
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

  it("filters ancestor mirrors out of deny so nested mirror does not block itself", () => {
    // cur is nested inside an ancestor mirror (e.g. project under its org).
    // The ancestor's glob `/r/org/**` would match cur's own files; deny
    // beats allow in Claude Code, so the ancestor must not appear in deny.
    const s = buildClaudeSettings({
      currentMirror: "/r/org/projects/p1",
      otherMirrors: ["/r/org", "/r/org/projects/p2", "/r/other"],
      portuniRoot: "/r",
    });
    const allow = (s.permissions as { allow: string[] }).allow;
    const deny = (s.permissions as { deny: string[] }).deny;
    assert.ok(allow.includes("Edit(/r/org/projects/p1/**)"));
    assert.ok(!deny.some((d) => d === "Edit(/r/org/**)"), "ancestor must not be in deny");
    assert.ok(!deny.some((d) => d === "Write(/r/org/**)"), "ancestor must not be in deny");
    assert.ok(deny.some((d) => d.includes("/r/org/projects/p2")), "true sibling stays in deny");
    assert.ok(deny.some((d) => d.includes("/r/other")), "unrelated mirror stays in deny");
  });

  it("keeps descendant mirrors in deny (cur is ancestor)", () => {
    // From the ancestor's session, nested mirrors are distinct workspaces.
    // Direct edits should route through their own session -- so they stay
    // in deny by design (matches findContainingMirror longest-prefix).
    const s = buildClaudeSettings({
      currentMirror: "/r/org",
      otherMirrors: ["/r/org/projects/p1", "/r/other"],
      portuniRoot: "/r",
    });
    const deny = (s.permissions as { deny: string[] }).deny;
    assert.ok(deny.some((d) => d === "Write(/r/org/projects/p1/**)"));
    assert.ok(deny.some((d) => d === "Write(/r/other/**)"));
  });

  it("auto-approves the project-scoped portuni MCP server", () => {
    const s = buildClaudeSettings({
      currentMirror: "/r/a",
      otherMirrors: [],
      portuniRoot: "/r",
    });
    assert.deepEqual(
      (s as { enabledMcpjsonServers?: string[] }).enabledMcpjsonServers,
      ["portuni"],
    );
  });

  it("forces a manual prompt on portuni_expand_scope via permissions.ask", () => {
    const s = buildClaudeSettings({
      currentMirror: "/r/a",
      otherMirrors: [],
      portuniRoot: "/r",
    });
    const ask = (s.permissions as { ask?: string[] }).ask;
    assert.ok(ask?.includes("mcp__portuni__portuni_expand_scope"));
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

describe("appendHomeNodeIdToUrl", () => {
  it("appends home_node_id as a query param when none exists", () => {
    assert.equal(
      appendHomeNodeIdToUrl("http://localhost:4011/mcp", "01ABC"),
      "http://localhost:4011/mcp?home_node_id=01ABC",
    );
  });

  it("appends with & when other params exist", () => {
    assert.equal(
      appendHomeNodeIdToUrl("http://localhost:4011/mcp?foo=bar", "01ABC"),
      "http://localhost:4011/mcp?foo=bar&home_node_id=01ABC",
    );
  });

  it("returns the URL unchanged when homeNodeId is null", () => {
    assert.equal(
      appendHomeNodeIdToUrl("http://localhost:4011/mcp", null),
      "http://localhost:4011/mcp",
    );
  });

  it("encodes special chars defensively", () => {
    assert.equal(
      appendHomeNodeIdToUrl("http://x/mcp", "a b"),
      "http://x/mcp?home_node_id=a%20b",
    );
  });
});

describe("buildVibeMcpToml", () => {
  it("emits a portuni mcp_server with seeded url and env-var auth", () => {
    const toml = buildVibeMcpToml({
      url: "http://127.0.0.1:47011/mcp",
      homeNodeId: "01HOME",
    });
    assert.ok(toml.includes(VIBE_PROJECT_MARKER));
    assert.match(toml, /\[\[mcp_servers\]\]/);
    assert.match(toml, /name = "portuni"/);
    assert.match(toml, /transport = "streamable-http"/);
    assert.match(toml, /url = "http:\/\/127\.0\.0\.1:47011\/mcp\?home_node_id=01HOME"/);
    assert.match(toml, /\[mcp_servers\.auth\]/);
    assert.match(toml, /type = "static"/);
    assert.match(toml, /api_key_env = "PORTUNI_MCP_TOKEN"/);
    assert.match(toml, /api_key_format = "Bearer \{token\}"/);
  });

  it("omits the query param when no home node is given", () => {
    const toml = buildVibeMcpToml({ url: "http://x/mcp", homeNodeId: null });
    assert.match(toml, /url = "http:\/\/x\/mcp"/);
    assert.ok(!toml.includes("home_node_id"));
  });
});

describe("buildClaudeMcpJson", () => {
  it("appends home_node_id to the URL so auto-seed runs on connect", () => {
    const j = buildClaudeMcpJson({
      url: "http://127.0.0.1:47011/mcp",
      homeNodeId: "01ABC",
    });
    const portuni = (j as { mcpServers: { portuni: { type: string; url: string } } })
      .mcpServers.portuni;
    assert.equal(portuni.type, "http");
    assert.equal(portuni.url, "http://127.0.0.1:47011/mcp?home_node_id=01ABC");
  });

  it("references the token via env expansion, never a literal value", () => {
    const j = buildClaudeMcpJson({
      url: "http://127.0.0.1:47011/mcp",
      homeNodeId: "01ABC",
    });
    const portuni = (j as { mcpServers: { portuni: { headers?: Record<string, string> } } })
      .mcpServers.portuni;
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder expanded by Claude Code, not JS
    assert.equal(portuni.headers?.Authorization, "Bearer ${PORTUNI_MCP_TOKEN:-}");
  });

  it("carries the portuni_managed marker so regeneration can recognise its own file", () => {
    const j = buildClaudeMcpJson({ url: "http://x/mcp", homeNodeId: "01ABC" });
    assert.ok((j as { portuni_managed?: unknown }).portuni_managed);
  });

  it("omits the query param when homeNodeId is null", () => {
    const j = buildClaudeMcpJson({ url: "http://x/mcp", homeNodeId: null });
    const portuni = (j as { mcpServers: { portuni: { url: string } } }).mcpServers.portuni;
    assert.equal(portuni.url, "http://x/mcp");
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

  it("tells the agent to save into wip/outputs/resources, not the mirror root", () => {
    const hint = buildSoftHint({ currentMirror: "/r/a", portuniRoot: "/r" });
    assert.match(hint, /Where to save files/);
    assert.match(hint, /`wip\/`/);
    assert.match(hint, /`outputs\/`/);
    assert.match(hint, /`resources\/`/);
    assert.match(hint, /mirror root is reserved/i);
  });

  it("lists registered data sources when provided", () => {
    const hint = buildSoftHint({
      currentMirror: "/r/a",
      portuniRoot: "/r",
      dataSources: [
        {
          id: "D1",
          node_id: "N1",
          name: "Acme CRM",
          description: "deal pipeline",
          external_link: "https://crm.example.com",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
    });
    assert.match(hint, /Portuni data sources/);
    assert.match(hint, /Acme CRM/);
    assert.match(hint, /https:\/\/crm\.example\.com/);
    assert.match(hint, /deal pipeline/);
    assert.match(hint, /portuni_list_data_sources/);
  });

  it("falls back to a list-data-sources instruction when none are provided", () => {
    const hint = buildSoftHint({ currentMirror: "/r/a", portuniRoot: "/r" });
    assert.match(hint, /Portuni data sources/);
    assert.match(hint, /portuni_list_data_sources/);
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

  it("writes .mcp.json with home_node_id when nodeId is provided; skips it otherwise", async () => {
    const dir = await mkdtemp(join(tmpdir(), "portuni-scope-mcp-"));
    const cur = join(dir, "a");
    await mkdir(cur, { recursive: true });

    await materializeScopeConfig({
      currentMirror: cur,
      otherMirrors: [],
      portuniRoot: dir,
    });
    const withoutNode = await stat(join(cur, ".mcp.json"))
      .then(() => true)
      .catch(() => false);
    assert.equal(withoutNode, false, "no nodeId -> no .mcp.json");

    await materializeScopeConfig({
      currentMirror: cur,
      nodeId: "01HOME",
      mcpUrl: "http://127.0.0.1:47011/mcp",
      otherMirrors: [],
      portuniRoot: dir,
    });
    const parsed = JSON.parse(await readFile(join(cur, ".mcp.json"), "utf8"));
    assert.equal(
      parsed.mcpServers.portuni.url,
      "http://127.0.0.1:47011/mcp?home_node_id=01HOME",
    );

    // Vibe gets a project-scoped .vibe/config.toml with the same seeded URL
    // so a session launched in the mirror auto-seeds its scope (no expand).
    const vibe = await readFile(join(cur, ".vibe", "config.toml"), "utf8");
    assert.ok(vibe.includes(VIBE_PROJECT_MARKER), "carries portuni marker");
    assert.match(vibe, /url = "http:\/\/127\.0\.0\.1:47011\/mcp\?home_node_id=01HOME"/);
    assert.match(vibe, /api_key_env = "PORTUNI_MCP_TOKEN"/);
    assert.ok(!vibe.includes("Bearer ey"), "no literal token in file");

    // The Codex per-mirror toml still carries only the sandbox config; its
    // MCP registration lives in the user-scoped ~/.codex/config.toml.
    const toml = await readFile(join(cur, ".codex", "config.toml"), "utf8");
    assert.ok(!toml.includes("[mcp_servers"), "mirror Codex toml must not register MCP server");
    assert.match(toml, /sandbox_workspace_write/, "sandbox config must still be present");
  });

  it("overwrites a stale portuni-managed .mcp.json with the current url", async () => {
    const dir = await mkdtemp(join(tmpdir(), "portuni-scope-refresh-"));
    const cur = join(dir, "a");
    await mkdir(cur, { recursive: true });

    const mcpPath = join(cur, ".mcp.json");
    await (await import("node:fs/promises")).writeFile(
      mcpPath,
      JSON.stringify({
        portuni_managed: { generated_at: "2026-04-25T00:00:00Z" },
        mcpServers: {
          portuni: {
            type: "http",
            url: "http://localhost:9999/mcp?home_node_id=01OLD",
            headers: { Authorization: "Bearer old-literal" },
          },
        },
      }),
    );

    const r = await materializeScopeConfig({
      currentMirror: cur,
      nodeId: "01NEW",
      mcpUrl: "http://127.0.0.1:47011/mcp",
      otherMirrors: [],
      portuniRoot: dir,
    });

    const raw = await readFile(mcpPath, "utf8");
    assert.ok(raw.includes("home_node_id=01NEW"), "home node must be refreshed");
    assert.ok(!raw.includes("9999"), "stale port must be gone");
    assert.ok(!raw.includes("old-literal"), "literal token must be gone");
    assert.ok(r.written.includes(mcpPath));
  });

  it("preserves a hand-written .mcp.json without the portuni marker", async () => {
    const dir = await mkdtemp(join(tmpdir(), "portuni-scope-keep-"));
    const cur = join(dir, "a");
    await mkdir(cur, { recursive: true });

    const userOwned = join(cur, ".mcp.json");
    const userContent = JSON.stringify(
      { mcpServers: { other: { command: "x" } } },
      null,
      2,
    );
    await (await import("node:fs/promises")).writeFile(userOwned, userContent);

    const r = await materializeScopeConfig({
      currentMirror: cur,
      nodeId: "01HOME",
      mcpUrl: "http://127.0.0.1:47011/mcp",
      otherMirrors: [],
      portuniRoot: dir,
    });

    const after = await readFile(userOwned, "utf8");
    assert.equal(after, userContent, "hand-written .mcp.json must not be touched");
    assert.ok(
      r.errors.some((e) => e.path === userOwned),
      "skip must be surfaced as a non-fatal note",
    );
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
