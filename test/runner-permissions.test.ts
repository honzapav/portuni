// decidePermission (apps/server/domain/runner/permissions.ts): the pure
// policy an adapter's own permission callback maps onto. Table test over
// every rule in docs/superpowers/specs/2026-09-12-runner-and-session-design.md
// ("permissions.ts").
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decidePermission } from "../apps/server/domain/runner/permissions.js";

async function setup() {
  const portuniRoot = await mkdtemp(join(tmpdir(), "portuni-runner-perms-"));
  const mirrorA = join(portuniRoot, "mirror-a");
  const mirrorB = join(portuniRoot, "mirror-b");
  await mkdir(mirrorA, { recursive: true });
  await mkdir(mirrorB, { recursive: true });
  const outside = join(tmpdir(), "portuni-runner-perms-outside");
  return { portuniRoot, mirrorA, mirrorB, outside, mirrors: [mirrorA, mirrorB] };
}

describe("decidePermission: write tools (Edit/Write/MultiEdit/NotebookEdit)", () => {
  it("allows a write inside the current mirror (tier 1)", async () => {
    const { portuniRoot, mirrorA, mirrors } = await setup();
    const decision = decidePermission({
      tool: "Write",
      input: { file_path: join(mirrorA, "notes.md") },
      cwd: mirrorA,
      portuniRoot,
      mirrors,
      policy: "default",
    });
    assert.deepEqual(decision, { kind: "allow" });
  });

  it("denies a write into a sibling mirror (tier 2) with the classification's reason", async () => {
    const { portuniRoot, mirrorA, mirrorB, mirrors } = await setup();
    const decision = decidePermission({
      tool: "Edit",
      input: { file_path: join(mirrorB, "notes.md") },
      cwd: mirrorA,
      portuniRoot,
      mirrors,
      policy: "default",
    });
    assert.equal(decision.kind, "deny");
    if (decision.kind === "deny") assert.match(decision.message, /sibling mirror/);
  });

  it("denies a write outside PORTUNI_ROOT entirely (tier 3)", async () => {
    const { portuniRoot, mirrorA, outside, mirrors } = await setup();
    const decision = decidePermission({
      tool: "MultiEdit",
      input: { file_path: join(outside, "notes.md") },
      cwd: mirrorA,
      portuniRoot,
      mirrors,
      policy: "default",
    });
    assert.equal(decision.kind, "deny");
    if (decision.kind === "deny") assert.match(decision.message, /outside PORTUNI_ROOT/);
  });

  it("uses notebook_path for NotebookEdit", async () => {
    const { portuniRoot, mirrorA, mirrors } = await setup();
    const decision = decidePermission({
      tool: "NotebookEdit",
      input: { notebook_path: join(mirrorA, "analysis.ipynb") },
      cwd: mirrorA,
      portuniRoot,
      mirrors,
      policy: "default",
    });
    assert.deepEqual(decision, { kind: "allow" });
  });

  it("denies when the expected path field is missing", async () => {
    const { portuniRoot, mirrorA, mirrors } = await setup();
    const decision = decidePermission({
      tool: "Write",
      input: {},
      cwd: mirrorA,
      portuniRoot,
      mirrors,
      policy: "default",
    });
    assert.equal(decision.kind, "deny");
  });
});

describe("decidePermission: Bash", () => {
  it("always allows, regardless of the command", async () => {
    const { portuniRoot, mirrorA, outside, mirrors } = await setup();
    const decision = decidePermission({
      tool: "Bash",
      input: { command: `rm -rf ${outside}` },
      cwd: mirrorA,
      portuniRoot,
      mirrors,
      policy: "default",
    });
    assert.deepEqual(decision, { kind: "allow" });
  });
});

describe("decidePermission: mcp__portuni__portuni_expand_scope", () => {
  it("asks for approval under the default policy", async () => {
    const { portuniRoot, mirrorA, mirrors } = await setup();
    const decision = decidePermission({
      tool: "mcp__portuni__portuni_expand_scope",
      input: {},
      cwd: mirrorA,
      portuniRoot,
      mirrors,
      policy: "default",
    });
    assert.equal(decision.kind, "ask");
    if (decision.kind === "ask") assert.equal(decision.question.type, "approval");
  });

  it("allows outright under the auto policy", async () => {
    const { portuniRoot, mirrorA, mirrors } = await setup();
    const decision = decidePermission({
      tool: "mcp__portuni__portuni_expand_scope",
      input: {},
      cwd: mirrorA,
      portuniRoot,
      mirrors,
      policy: "auto",
    });
    assert.deepEqual(decision, { kind: "allow" });
  });
});

describe("decidePermission: AskUserQuestion", () => {
  it("asks for input, carrying the tool's question text and options", async () => {
    const { portuniRoot, mirrorA, mirrors } = await setup();
    const decision = decidePermission({
      tool: "AskUserQuestion",
      input: { question: "Which environment?", options: ["staging", "production"] },
      cwd: mirrorA,
      portuniRoot,
      mirrors,
      policy: "default",
    });
    assert.equal(decision.kind, "ask");
    if (decision.kind === "ask") {
      assert.equal(decision.question.type, "input");
      assert.equal(decision.question.detail, "Which environment?");
      assert.deepEqual(decision.question.options, ["staging", "production"]);
    }
  });

  it("tolerates a missing question/options", async () => {
    const { portuniRoot, mirrorA, mirrors } = await setup();
    const decision = decidePermission({
      tool: "AskUserQuestion",
      input: {},
      cwd: mirrorA,
      portuniRoot,
      mirrors,
      policy: "default",
    });
    assert.equal(decision.kind, "ask");
    if (decision.kind === "ask") {
      assert.equal(decision.question.detail, "");
      assert.equal(decision.question.options, null);
    }
  });
});

describe("decidePermission: ExitPlanMode", () => {
  it("asks for approval, carrying the plan text as detail", async () => {
    const { portuniRoot, mirrorA, mirrors } = await setup();
    const decision = decidePermission({
      tool: "ExitPlanMode",
      input: { plan: "1. Do the thing\n2. Ship it" },
      cwd: mirrorA,
      portuniRoot,
      mirrors,
      policy: "default",
    });
    assert.equal(decision.kind, "ask");
    if (decision.kind === "ask") {
      assert.equal(decision.question.type, "approval");
      assert.equal(decision.question.detail, "1. Do the thing\n2. Ship it");
    }
  });
});

describe("decidePermission: everything else", () => {
  it("allows an unrecognized tool", async () => {
    const { portuniRoot, mirrorA, mirrors } = await setup();
    const decision = decidePermission({
      tool: "Glob",
      input: { pattern: "**/*.ts" },
      cwd: mirrorA,
      portuniRoot,
      mirrors,
      policy: "default",
    });
    assert.deepEqual(decision, { kind: "allow" });
  });
});
