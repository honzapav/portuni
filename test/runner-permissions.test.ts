// decidePermission (apps/server/domain/runner/permissions.ts): the pure
// policy an adapter's own permission callback maps onto. Table test over
// every rule in docs/superpowers/specs/2026-09-12-runner-and-session-design.md
// ("permissions.ts").
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askUserQuestionAnswers, decidePermission } from "../apps/server/domain/runner/permissions.js";

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
  it("maps Claude Code's questions[] shape: every question with its own option labels", async () => {
    const { portuniRoot, mirrorA, mirrors } = await setup();
    const decision = decidePermission({
      tool: "AskUserQuestion",
      input: {
        questions: [
          {
            question: "Which environment?",
            header: "Env",
            options: [
              { label: "staging", description: "pre-prod" },
              { label: "production", description: "live" },
            ],
            multiSelect: false,
          },
          { question: "Dry run first?", header: "Mode", options: [{ label: "yes" }, { label: "no" }] },
        ],
      },
      cwd: mirrorA,
      portuniRoot,
      mirrors,
      policy: "default",
    });
    assert.equal(decision.kind, "ask");
    if (decision.kind === "ask") {
      assert.equal(decision.question.type, "input");
      assert.equal(decision.question.detail, "Which environment?\n\nDry run first?");
      // #492: no flat list for two questions -- each keeps its own options.
      assert.equal(decision.question.options, null);
      assert.deepEqual(decision.question.questions, [
        { question: "Which environment?", options: ["staging", "production"], multi_select: false },
        { question: "Dry run first?", options: ["yes", "no"], multi_select: false },
      ]);
    }
  });

  it("a single question keeps its option labels flat as well", async () => {
    const { portuniRoot, mirrorA, mirrors } = await setup();
    const decision = decidePermission({
      tool: "AskUserQuestion",
      input: {
        questions: [
          { question: "Which features?", header: "F", options: [{ label: "a" }, { label: "b" }], multiSelect: true },
        ],
      },
      cwd: mirrorA,
      portuniRoot,
      mirrors,
      policy: "default",
    });
    assert.equal(decision.kind, "ask");
    if (decision.kind === "ask") {
      assert.deepEqual(decision.question.options, ["a", "b"]);
      assert.deepEqual(decision.question.questions, [{ question: "Which features?", options: ["a", "b"], multi_select: true }]);
    }
  });

  it("accepts a pre-flattened { question, options } shape too", async () => {
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

describe("askUserQuestionAnswers (#492)", () => {
  const input = {
    questions: [
      { question: "Which environment?", options: [{ label: "staging" }, { label: "production" }] },
      { question: "Dry run first?", options: [{ label: "yes" }, { label: "no" }] },
    ],
  };

  it("keys each answer by its question text", () => {
    assert.deepEqual(
      askUserQuestionAnswers(input, { "Which environment?": "production", "Dry run first?": "no", "Unasked?": "x" }),
      { "Which environment?": "production", "Dry run first?": "no" },
    );
  });

  it("a string answers every question", () => {
    assert.deepEqual(askUserQuestionAnswers(input, "whatever you think"), {
      "Which environment?": "whatever you think",
      "Dry run first?": "whatever you think",
    });
  });

  it("an empty answer and an inherited key answer nothing", () => {
    assert.deepEqual(askUserQuestionAnswers(input, "  "), {});
    assert.deepEqual(askUserQuestionAnswers({ questions: [{ question: "constructor", options: [] }] }, {}), {});
  });
});
