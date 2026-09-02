import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAgentCommand } from "../apps/web/src/lib/prompt.js";
import type { NodeDetail } from "../apps/server/shared/api-types.js";

function makeNode(overrides: Partial<NodeDetail> = {}): NodeDetail {
  return {
    id: "node_abc123",
    type: "project",
    name: "Test Project",
    description: null,
    status: "active",
    visibility: "public",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    edges: [],
    files: [],
    events: [],
    local_mirror: null,
    owner: null,
    responsibilities: [],
    data_sources: [],
    tools: [],
    goal: null,
    lifecycle_state: null,
    health: "on_track",
    ...overrides,
  } as NodeDetail;
}

describe("buildAgentCommand", () => {
  it("cd's into the local mirror and runs the template unmodified", () => {
    const node = makeNode({
      local_mirror: { local_path: "/tmp/mirror", registered_at: "2026-01-01T00:00:00.000Z" },
    });
    const cmd = buildAgentCommand(node, "claude");
    assert.equal(cmd, "cd '/tmp/mirror' && claude");
  });

  it("runs the bare template with no cd when there is no local mirror", () => {
    const node = makeNode({ local_mirror: null });
    assert.equal(buildAgentCommand(node, "claude"), "claude");
  });

  it("does not inject a prompt or orientation content of any kind", () => {
    const node = makeNode({
      local_mirror: { local_path: "/tmp/mirror", registered_at: "2026-01-01T00:00:00.000Z" },
    });
    const cmd = buildAgentCommand(node, "codex");
    assert.equal(cmd, "cd '/tmp/mirror' && codex");
    assert.doesNotMatch(cmd, /Snapshot|portuni_get_node/);
  });

  it("falls back to the default command for a leftover {prompt} placeholder from an exact preset string", () => {
    const node = makeNode({ local_mirror: null });
    assert.equal(buildAgentCommand(node, "claude {prompt}"), "claude");
  });

  it("falls back to the default command rather than leaving a flag dangling in a hand-customized template (#209)", () => {
    // settings.ts's AGENT_COMMAND_MIGRATIONS only upgrades EXACT known preset
    // strings; a hand-customized template built around one never matches it.
    // Blindly stripping just "{prompt}" here would leave "-p" dangling with
    // "--yolo" as its value -- the regression this guards.
    const node = makeNode({ local_mirror: null });
    assert.equal(buildAgentCommand(node, "gemini -p {prompt} --yolo"), "claude");
    assert.equal(buildAgentCommand(node, "gemini -p {prompt}"), "claude");
  });

  it("falls back to the default command when the template is blank", () => {
    const node = makeNode({ local_mirror: null });
    assert.equal(buildAgentCommand(node, "   "), "claude");
  });

  it("shell-quotes a mirror path containing single quotes", () => {
    const node = makeNode({
      local_mirror: { local_path: "/tmp/it's a mirror", registered_at: "2026-01-01T00:00:00.000Z" },
    });
    assert.equal(
      buildAgentCommand(node, "claude"),
      "cd '/tmp/it'\\''s a mirror' && claude",
    );
  });
});
